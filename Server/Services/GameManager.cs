using System;
using System.Collections.Concurrent;
using System.Linq;
using Microsoft.AspNetCore.SignalR;
using SwarmAndSnack.Server.Hubs;
using SwarmAndSnack.Server.Models;

namespace SwarmAndSnack.Server.Services;

public class GameManager
{
    private readonly ConcurrentDictionary<string, GameRoom> _rooms = new();
    private readonly IHubContext<GameHub> _hubContext;
    private readonly ILogger<GameManager> _logger;

    public GameManager(IHubContext<GameHub> hubContext, ILogger<GameManager> logger)
    {
        _hubContext = hubContext;
        _logger = logger;
    }

    public IReadOnlyDictionary<string, GameRoom> Rooms => _rooms;

    public (GameRoom room, Player player) CreateRoom(string connectionId, string? displayName)
    {
        string roomId;
        do
        {
            roomId = GenerateRoomId();
        }
        while (_rooms.ContainsKey(roomId));

        var room = new GameRoom(roomId);
        var player = CreatePlayer(connectionId, ColorKeyForIndex(0), displayName);
        player.SpawnIndex = 0;
        room.TryAddPlayer(player);
        InitializePlayerEntities(player, player.SpawnIndex, room.EffectiveWorldWidth);
        _rooms[roomId] = room;
        _logger.LogInformation("Created room {RoomId} by {ConnectionId}", roomId, connectionId);
        return (room, player);
    }

    public bool TryJoinRoom(string roomId, string connectionId, string? displayName, out Player? player, out string? error)
    {
        player = null;
        error = null;

        if (!_rooms.TryGetValue(roomId, out var room))
        {
            error = "RoomNotFound";
            return false;
        }

        if (room.IsActive)
        {
            error = "MatchInProgress";
            return false;
        }

        var existingCount = room.PlayerCount;
        if (existingCount >= GameConstants.MaxPlayersPerRoom)
        {
            error = "RoomFull";
            return false;
        }

        player = CreatePlayer(connectionId, ColorKeyForIndex(existingCount), displayName);
        player.SpawnIndex = existingCount;
        // The joiner may be the one that opens the right half, so size for the
        // roster this player is about to join.
        InitializePlayerEntities(player, player.SpawnIndex, Level.WorldWidthFor(existingCount + 1));

        if (!room.TryAddPlayer(player))
        {
            error = "RoomFull";
            return false;
        }

        _logger.LogInformation("Player {ConnectionId} joined room {RoomId}", connectionId, roomId);
        return true;
    }

    private static string ColorKeyForIndex(int index)
    {
        var keys = GameConstants.PlayerColorKeys;
        return keys[index % keys.Length];
    }

    public bool TryGetRoom(string roomId, out GameRoom? room) => _rooms.TryGetValue(roomId, out room);

    public bool TryRegisterMove(string roomId, string connectionId, Direction direction)
    {
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            return false;
        }

        if (!room.TryGetPlayer(connectionId, out var player) || player is null)
        {
            return false;
        }

        player.UpdateInput(direction);
        room.Touch();
        return true;
    }

    public void HandleDisconnect(string connectionId)
    {
        foreach (var (roomId, room) in _rooms)
        {
            if (!room.TryGetPlayer(connectionId, out _))
            {
                continue;
            }

            room.RemovePlayer(connectionId);
            _logger.LogInformation("Removed player {ConnectionId} from room {RoomId}", connectionId, roomId);

            lock (room.SyncRoot)
            {
                // Only end the match if a single player is left standing; with more
                // players still present, the free-for-all keeps going.
                if (room.IsActive && room.PlayerCount == 1)
                {
                    var remaining = room.Players.First();
                    room.Stop(remaining.ConnectionId);
                }
            }

            if (room.IsEmpty)
            {
                _rooms.TryRemove(roomId, out _);
                _logger.LogInformation("Removed empty room {RoomId}", roomId);
            }
        }
    }

    // Host-gated match start, used for both the initial start from the lobby and rematches.
    public bool TryStartMatch(string roomId, string connectionId, out string? error)
    {
        error = null;
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            error = "RoomNotFound";
            return false;
        }

        lock (room.SyncRoot)
        {
            if (!room.IsHost(connectionId))
            {
                error = "NotHost";
                return false;
            }

            if (!room.CanStart)
            {
                error = room.PlayerCount < GameConstants.MinPlayersPerRoom
                    ? "NotEnoughPlayers"
                    : "AlreadyStarted";
                return false;
            }

            ResetRoom(room);
            room.Start();
            _logger.LogInformation("Room {RoomId} match started by host {ConnectionId}", roomId, connectionId);
            return true;
        }
    }

    public async Task TickAsync(double deltaSeconds, CancellationToken cancellationToken)
    {
        var rooms = _rooms.Values.ToList();
        List<Task>? sendTasks = null;

        foreach (var room in rooms)
        {
            if (room.IsExpired)
            {
                _rooms.TryRemove(room.Id, out _);
                _logger.LogInformation("Room {RoomId} expired and was removed", room.Id);
                continue;
            }

            GameStateDto state;
            string? winnerId;
            bool announceResult;

            // Simulation runs under the room lock (fast, CPU-bound); the network
            // broadcasts below are fired without awaiting so all rooms send in
            // parallel and one slow room can't stall the whole tick.
            lock (room.SyncRoot)
            {
                if (room.IsActive)
                {
                    UpdateRoom(room, (float)deltaSeconds);
                }

                winnerId = room.WinnerId;
                announceResult = room.MatchEnded && !room.WinnerBroadcasted;

                state = BuildStateSnapshot(room);

                if (announceResult)
                {
                    room.MarkWinnerBroadcasted();
                }
            }

            sendTasks ??= new List<Task>(rooms.Count);
            sendTasks.Add(_hubContext.Clients.Group(room.Id)
                .SendAsync("GameStateUpdated", state, cancellationToken));

            if (announceResult)
            {
                // winnerId may be null on a simultaneous knockout (draw).
                sendTasks.Add(_hubContext.Clients.Group(room.Id)
                    .SendAsync("GameOver", new { winnerId }, cancellationToken));
            }
        }

        if (sendTasks is not null)
        {
            await Task.WhenAll(sendTasks);
        }
    }

    private static Player CreatePlayer(string connectionId, string team, string? displayName)
    {
        return new Player(connectionId, team, displayName ?? team);
    }

    // Underlings are kept this far from every leader's starting room so nobody
    // can clear a swarm in the opening seconds just by standing still.
    private const float ScatterClearanceFromSpawns = 200f;

    private static void InitializePlayerEntities(Player player, int spawnIndex, float worldWidth, int underlingCount = 0)
    {
        // The leader starts in its own room; the swarm is scattered across the
        // whole open world instead of huddling around it, so a swarm can't be
        // wiped out in one pass through a single room.
        var spawn = Level.SpawnPoints[spawnIndex % Level.SpawnPoints.Count];
        player.Leader.Position = spawn;
        player.Leader.Velocity = Vector2.Zero;
        player.Underlings.Clear();

        var obstacles = Level.ObstaclesFor(worldWidth);
        var count = underlingCount > 0
            ? underlingCount
            : Random.Shared.Next(GameConstants.MinUnderlingsPerPlayer, GameConstants.MaxUnderlingsPerPlayer + 1);
        for (var i = 0; i < count; i++)
        {
            var position = FindScatterPosition(worldWidth, obstacles, spawn);
            var velocity = RandomUnitVector() * GameConstants.UnderlingSpeed;
            player.Underlings.Add(new Underling(player.ConnectionId, position, velocity));
        }
    }

    /// <summary>
    /// Rejection-samples a free point anywhere in the open world: clear of every
    /// wall and not on a leader's doorstep.
    /// </summary>
    private static Vector2 FindScatterPosition(float worldWidth, IReadOnlyList<Obstacle> obstacles, Vector2 fallbackNear)
    {
        var radius = GameConstants.UnderlingRadius;
        var margin = radius + 8f;
        var wallClearance = radius + 6f;

        for (var attempt = 0; attempt < 300; attempt++)
        {
            var candidate = new Vector2(
                RandomFloat(margin, worldWidth - margin),
                RandomFloat(margin, GameConstants.WorldHeight - margin));

            if (OverlapsAnyObstacle(candidate, wallClearance, obstacles))
            {
                continue;
            }

            if (IsInsideThicket(candidate, radius, Level.ThicketsFor(worldWidth)))
            {
                continue;
            }

            if (IsNearAnyStartingRoom(candidate, worldWidth))
            {
                continue;
            }

            return candidate;
        }

        // Open space is plentiful, so this should not happen; keep the old
        // behaviour rather than risk placing an underling inside a wall.
        return new Vector2(
            Math.Clamp(fallbackNear.X + RandomFloat(-60f, 60f), margin, worldWidth - margin),
            Math.Clamp(fallbackNear.Y + RandomFloat(-60f, 60f), margin, GameConstants.WorldHeight - margin));
    }

    private static bool IsInsideThicket(Vector2 point, float radius, IReadOnlyList<Thicket> thickets)
    {
        foreach (var thicket in thickets)
        {
            var reach = thicket.Radius + radius + 8f;
            if (Vector2.DistanceSquared(point, thicket.Center) < reach * reach)
            {
                return true;
            }
        }
        return false;
    }

    private static bool OverlapsAnyObstacle(Vector2 point, float clearance, IReadOnlyList<Obstacle> obstacles)
    {
        foreach (var obstacle in obstacles)
        {
            if (Vector2.DistanceSquared(point, obstacle.ClosestPoint(point)) < clearance * clearance)
            {
                return true;
            }
        }
        return false;
    }

    private static bool IsNearAnyStartingRoom(Vector2 point, float worldWidth)
    {
        foreach (var spawn in Level.SpawnPoints)
        {
            // Rooms outside the active world half aren't in play.
            if (spawn.X > worldWidth)
            {
                continue;
            }

            if (Vector2.DistanceSquared(point, spawn) <
                ScatterClearanceFromSpawns * ScatterClearanceFromSpawns)
            {
                return true;
            }
        }
        return false;
    }

    private static void ResetRoom(GameRoom room)
    {
        // Called just before Start(), so this is the width the match will freeze.
        var worldWidth = room.EffectiveWorldWidth;
        var sharedCount = Random.Shared.Next(GameConstants.MinUnderlingsPerPlayer, GameConstants.MaxUnderlingsPerPlayer + 1);
        foreach (var player in room.Players)
        {
            InitializePlayerEntities(player, player.SpawnIndex, worldWidth, sharedCount);
        }
        room.Touch();
    }

    private void UpdateRoom(GameRoom room, float deltaSeconds)
    {
        var players = room.Players.ToList();
        var worldWidth = room.EffectiveWorldWidth;
        var obstacles = Level.ObstaclesFor(worldWidth);
        var thickets = Level.ThicketsFor(worldWidth);

        foreach (var player in players)
        {
            UpdateLeaderMovement(player);
        }

        var ownerById = players.ToDictionary(p => p.ConnectionId);
        foreach (var underling in AllUnderlings(room, players))
        {
            ownerById.TryGetValue(underling.OwnerId, out var owner);
            SteerUnderling(underling, owner, deltaSeconds);
            underling.Advance(deltaSeconds);
            BounceOffWalls(underling, worldWidth);
            ResolveObstacleCollisions(underling, obstacles, bounce: true);
            ResolveThicketCollisions(underling, thickets, bounce: true);
        }

        foreach (var player in players)
        {
            player.Leader.Advance(deltaSeconds);
            BounceOffWalls(player.Leader, worldWidth);
            ResolveObstacleCollisions(player.Leader, obstacles, bounce: false);
            ResolveThicketCollisions(player.Leader, thickets, bounce: false);
        }

        ResolveUnderlingCollisions(room, players);
        ResolveLeaderCollisions(players, room);

        // Eating an underling shoves the leader 6px, and leader-vs-leader and
        // underling-vs-underling separation move entities too. Those all happen
        // after the terrain pass, so without re-resolving here an entity can end
        // the tick sitting inside a wall or a thicket.
        foreach (var underling in players.SelectMany(p => p.Underlings))
        {
            ResolveObstacleCollisions(underling, obstacles, bounce: false);
            ResolveThicketCollisions(underling, thickets, bounce: false);
        }
        foreach (var player in players)
        {
            ResolveObstacleCollisions(player.Leader, obstacles, bounce: false);
            ResolveThicketCollisions(player.Leader, thickets, bounce: false);
        }

        UpdateApex(players, deltaSeconds);
        ResolveApexKills(room, players);
        UpdateBanking(room, players, deltaSeconds);
        UpdateRegrowth(players, worldWidth, deltaSeconds);

        room.SecondsRemaining = Math.Max(0f, room.SecondsRemaining - deltaSeconds);

        CheckForWinner(room);
        room.Touch();
    }

    /// <summary>Every underling in the room, owned or neutral.</summary>
    private static IEnumerable<Underling> AllUnderlings(GameRoom room, IReadOnlyList<Player> players)
        => players.SelectMany(p => p.Underlings).Concat(room.NeutralUnderlings);

    private static void UpdateApex(IReadOnlyList<Player> players, float deltaSeconds)
    {
        foreach (var player in players)
        {
            if (player.ApexSecondsLeft > 0f)
            {
                player.ApexSecondsLeft = Math.Max(0f, player.ApexSecondsLeft - deltaSeconds);
            }
            if (player.ProtectedSecondsLeft > 0f)
            {
                player.ProtectedSecondsLeft = Math.Max(0f, player.ProtectedSecondsLeft - deltaSeconds);
            }
        }
    }

    /// <summary>
    /// An Apex leader eats other leaders. The victim is not eliminated — they
    /// spill what they were carrying as neutral food and respawn at their own
    /// room. That keeps the biggest moment in a match a scramble rather than a
    /// coronation: the bounty goes back on the table for everyone, including the
    /// player who just lost it. Banked score is never touched, because banking
    /// has to mean something.
    /// </summary>
    private void ResolveApexKills(GameRoom room, IReadOnlyList<Player> players)
    {
        foreach (var hunter in players)
        {
            if (!hunter.IsApex) continue;

            foreach (var prey in players)
            {
                if (ReferenceEquals(prey, hunter)) continue;
                // Two Apex leaders bounce off each other rather than trading
                // kills on whichever tick happens to look first.
                if (prey.IsApex) continue;
                // Freshly respawned prey is untouchable, otherwise the kill
                // re-fires every tick the pair overlaps and one Apex farms the
                // same victim hundreds of times.
                if (prey.IsProtected) continue;

                var reach = hunter.Leader.Radius + prey.Leader.Radius + GameConstants.HitForgivenessRadius;
                if (Vector2.DistanceSquared(hunter.Leader.Position, prey.Leader.Position) >= reach * reach)
                {
                    continue;
                }

                SpillSnack(room, prey);
                prey.BankProgressSeconds = 0f;
                prey.ProtectedSecondsLeft = GameConstants.RespawnProtectionSeconds;
                RespawnLeaderAtHome(prey, room.EffectiveWorldWidth);
                _logger.LogInformation(
                    "Room {RoomId}: {Hunter} ate {Prey} while Apex", room.Id, hunter.ConnectionId, prey.ConnectionId);
            }
        }
    }

    /// <summary>
    /// Every player can always attack. Two leaders touching makes whichever is
    /// carrying more spill some of it on the floor for anyone to grab.
    ///
    /// Before this, leaders simply bounced off each other unless one was Apex,
    /// which meant that for most of a match there was no way to attack anybody —
    /// the whole point of a free-for-all. Now being loaded is a liability at all
    /// times, and a player who is behind can bully the leader instead of farming.
    /// </summary>
    private void ResolveRam(GameRoom room, Player a, Player b)
    {
        // Apex handles its own, far more decisive, collision.
        if (a.IsApex || b.IsApex) return;
        if (a.Snack == b.Snack) return;

        var loaded = a.Snack > b.Snack ? a : b;
        if (loaded.IsProtected) return;

        var spill = Math.Min(GameConstants.RamSpillAmount, loaded.Snack);
        if (spill <= 0) return;

        loaded.Snack -= spill;
        loaded.BankProgressSeconds = 0f;
        loaded.ProtectedSecondsLeft = GameConstants.RamCooldownSeconds;
        ScatterFood(room, loaded.Leader.Position, spill);
        _logger.LogInformation(
            "Room {RoomId}: {Player} was rammed and dropped {Spill}", room.Id, loaded.ConnectionId, spill);
    }

    /// <summary>Turns a caught leader's belly into neutral food where it fell.</summary>
    private static void SpillSnack(GameRoom room, Player victim)
    {
        var spill = victim.Snack;
        victim.Snack = 0;
        ScatterFood(room, victim.Leader.Position, spill);
    }

    /// <summary>Bursts dropped snack outward, so it reads as an explosion rather than a pile.</summary>
    private static void ScatterFood(GameRoom room, Vector2 origin, int count)
    {
        for (var i = 0; i < count; i++)
        {
            if (room.NeutralUnderlings.Count >= GameConstants.MaxNeutralUnderlings) break;
            var direction = RandomUnitVector();
            var position = origin + direction * RandomFloat(20f, 60f);
            room.NeutralUnderlings.Add(new Underling(
                NeutralOwnerId, ClampToWorld(position, room.EffectiveWorldWidth),
                // Thrown clear, and briefly untouchable, so the drop is a prize
                // on the floor rather than something the victim inhales again.
                direction * GameConstants.SpillLaunchSpeed)
            {
                CoolSeconds = GameConstants.SpilledFoodCoolSeconds,
            });
        }
    }

    private static void RespawnLeaderAtHome(Player player, float worldWidth)
    {
        var spawn = HomeOf(player);
        player.Leader.Position = spawn;
        player.Leader.Velocity = Vector2.Zero;
    }

    /// <summary>
    /// Banking is a commitment. A leader has to hold its ground inside a bank
    /// zone for a full second, and an enemy leader arriving spoils it — which is
    /// what turns coming home with a full belly into the tensest moment in a
    /// match instead of a formality.
    /// </summary>
    private void UpdateBanking(GameRoom room, IReadOnlyList<Player> players, float deltaSeconds)
    {
        foreach (var player in players)
        {
            if (player.Snack <= 0 || !IsInsideBankZone(room, player))
            {
                player.BankProgressSeconds = 0f;
                continue;
            }

            if (EnemyLeaderIsNear(player, players))
            {
                player.BankProgressSeconds = 0f;
                continue;
            }

            player.BankProgressSeconds += deltaSeconds;
            if (player.BankProgressSeconds < GameConstants.BankSecondsRequired)
            {
                continue;
            }

            player.Banked += player.Snack;
            player.Snack = 0;
            player.BankProgressSeconds = 0f;
            _logger.LogInformation(
                "Room {RoomId}: {Player} banked, total {Banked}", room.Id, player.ConnectionId, player.Banked);
        }
    }

    private static bool IsInsideBankZone(GameRoom room, Player player)
    {
        if (room.SharedBank)
        {
            var centre = MidfieldCentre(room.EffectiveWorldWidth);
            return Vector2.DistanceSquared(player.Leader.Position, centre)
                <= GameConstants.SharedBankRadius * GameConstants.SharedBankRadius;
        }

        var home = HomeOf(player);
        return Vector2.DistanceSquared(player.Leader.Position, home)
            <= GameConstants.SharedBankRadius * GameConstants.SharedBankRadius;
    }

    private static bool EnemyLeaderIsNear(Player player, IReadOnlyList<Player> players)
    {
        foreach (var other in players)
        {
            if (ReferenceEquals(other, player)) continue;
            if (Vector2.DistanceSquared(player.Leader.Position, other.Leader.Position)
                <= GameConstants.BankInterruptRadius * GameConstants.BankInterruptRadius)
            {
                return true;
            }
        }
        return false;
    }

    // The timed midfield food drop that used to live here is gone. It kept the
    // map fed, but it also meant the safest way to play was to farm free dots in
    // the middle and never go near another player — which designed the fight out
    // of a game about raiding each other. Underlings now regrow for the player
    // they were taken from instead, so all food belongs to somebody.

    private const string NeutralOwnerId = "neutral";

    /// <summary>The centre of a player's own room — their bank and respawn point.</summary>
    private static Vector2 HomeOf(Player player) => Level.SpawnPoints[player.SpawnIndex % Level.SpawnPoints.Count];

    private static Vector2 MidfieldCentre(float worldWidth)
        => new(worldWidth / 2f, GameConstants.WorldHeight / 2f);

    private static Vector2 ClampToWorld(Vector2 position, float worldWidth)
    {
        var r = GameConstants.UnderlingRadius;
        return new Vector2(
            Math.Clamp(position.X, r, worldWidth - r),
            Math.Clamp(position.Y, r, GameConstants.WorldHeight - r));
    }

    private static bool IsClearOfTerrain(
        Vector2 position, float radius, IReadOnlyList<Obstacle> obstacles, IReadOnlyList<Thicket> thickets)
    {
        foreach (var obstacle in obstacles)
        {
            var nearestX = Math.Clamp(position.X, obstacle.X, obstacle.X + obstacle.Width);
            var nearestY = Math.Clamp(position.Y, obstacle.Y, obstacle.Y + obstacle.Height);
            var dx = position.X - nearestX;
            var dy = position.Y - nearestY;
            if (dx * dx + dy * dy < radius * radius) return false;
        }
        foreach (var thicket in thickets)
        {
            var reach = thicket.Radius + radius;
            var dx = position.X - thicket.X;
            var dy = position.Y - thicket.Y;
            if (dx * dx + dy * dy < reach * reach) return false;
        }
        return true;
    }

    private static void UpdateLeaderMovement(Player player)
    {
        var desiredVelocity = player.PendingDirection.ToVector();
        if (desiredVelocity.LengthSquared > 0.01f)
        {
            // Speed falls as the belly fills, and Apex clears the penalty. This
            // is the whole reason carrying four is frightening and reaching five
            // feels like relief.
            desiredVelocity = desiredVelocity.WithLength(player.CurrentSpeed);
        }
        player.Leader.Velocity = desiredVelocity;
    }

    /// <summary>
    /// Owned underlings keep station on their leader; loose ones drift.
    ///
    /// They used to random-walk with no idea who they belonged to, which meant a
    /// "swarm" was just scattered dots and raiding somebody had no defender to
    /// get past. Following turns a swarm into a place — you have to go into it
    /// and come back out.
    /// </summary>
    private static void SteerUnderling(Underling underling, Player? owner, float deltaSeconds)
    {
        if (owner is null)
        {
            underling.LostSeconds = 0f;
            if (underling.CoolSeconds > 0f)
            {
                // Still flying out of the spill; leave its launch velocity alone.
                underling.CoolSeconds = Math.Max(0f, underling.CoolSeconds - deltaSeconds);
                return;
            }
            // Settled loot: wander gently so a dropped pile spreads a little.
            if (Random.Shared.NextDouble() < 0.02)
            {
                underling.Velocity = RandomUnitVector() * (GameConstants.UnderlingSpeed * 0.5f);
            }
            return;
        }

        var toOwner = owner.Leader.Position - underling.Position;
        var distance = toOwner.Length;

        if (distance > GameConstants.UnderlingLeashRadius)
        {
            underling.LostSeconds += deltaSeconds;
            if (underling.LostSeconds >= GameConstants.UnderlingLostSeconds)
            {
                // Stranded. Steering straight at the owner walks a follower into
                // whatever wall is between them and holds it there, so give up
                // and put it back with the swarm.
                underling.LostSeconds = 0f;
                underling.Position = owner.Leader.Position + RandomUnitVector() * RandomFloat(40f, 110f);
                underling.Velocity = RandomUnitVector() * GameConstants.UnderlingSpeed;
                return;
            }

            // Head back, but angled rather than dead-on, so a follower slides
            // along an obstacle instead of pressing into it.
            var heading = toOwner.Normalized() * 0.8f + Perpendicular(toOwner).Normalized() * 0.2f;
            underling.Velocity = heading.Normalized() * GameConstants.UnderlingSpeed;
            return;
        }

        underling.LostSeconds = 0f;

        if (distance > GameConstants.UnderlingFollowRadius)
        {
            // Drift back toward the owner, but keep some jitter so the escort
            // spreads into a cloud instead of converging on one point.
            var heading = toOwner.Normalized() * 0.75f + RandomUnitVector() * 0.25f;
            underling.Velocity = heading.Normalized() * (GameConstants.UnderlingSpeed * 0.85f);
            return;
        }

        // Inside the escort: mill around.
        if (Random.Shared.NextDouble() < 0.04)
        {
            underling.Velocity = RandomUnitVector() * (GameConstants.UnderlingSpeed * 0.6f);
        }
    }

    /// <summary>
    /// Regrows underlings taken off a player, at that player's own room. The
    /// swarm never shrinks permanently, so raiding stays worth doing all match,
    /// but a raided player pays the walk to gather them up again.
    /// </summary>
    private static void UpdateRegrowth(IReadOnlyList<Player> players, float worldWidth, float deltaSeconds)
    {
        foreach (var player in players)
        {
            for (var i = player.RegrowTimers.Count - 1; i >= 0; i--)
            {
                player.RegrowTimers[i] -= deltaSeconds;
                if (player.RegrowTimers[i] > 0f) continue;

                player.RegrowTimers.RemoveAt(i);
                if (player.Underlings.Count >= player.SwarmCapacity) continue;

                var home = HomeOf(player);
                var spawn = ClampToWorld(home + RandomUnitVector() * RandomFloat(30f, 110f), worldWidth);
                player.Underlings.Add(new Underling(
                    player.ConnectionId, spawn, RandomUnitVector() * GameConstants.UnderlingSpeed));
            }
        }
    }

    private static void BounceOffWalls(GameEntity entity, float worldWidth)
    {
        var pos = entity.Position;
        var radius = entity.Radius;

        if (pos.X - radius < 0f)
        {
            pos = new Vector2(radius, pos.Y);
            entity.Velocity = entity.Velocity.BounceX();
        }
        else if (pos.X + radius > worldWidth)
        {
            pos = new Vector2(worldWidth - radius, pos.Y);
            entity.Velocity = entity.Velocity.BounceX();
        }

        if (pos.Y - radius < 0f)
        {
            pos = new Vector2(pos.X, radius);
            entity.Velocity = entity.Velocity.BounceY();
        }
        else if (pos.Y + radius > GameConstants.WorldHeight)
        {
            pos = new Vector2(pos.X, GameConstants.WorldHeight - radius);
            entity.Velocity = entity.Velocity.BounceY();
        }

        entity.Position = pos;
    }

    // Circle-vs-axis-aligned-rectangle resolution against static obstacles.
    // Underlings bounce (reflect); leaders slide (inward velocity removed) so
    // walls feel like barriers to steer along rather than trampolines.
    // Circle-vs-circle against the solid core of a thicket. Underlings bounce
    // out of the undergrowth; leaders slide around it, same as walls.
    private static void ResolveThicketCollisions(GameEntity entity, IReadOnlyList<Thicket> thickets, bool bounce)
    {
        foreach (var thicket in thickets)
        {
            var delta = entity.Position - thicket.Center;
            var minDistance = thicket.Radius + entity.Radius;
            var distanceSq = delta.LengthSquared;
            if (distanceSq >= minDistance * minDistance)
            {
                continue;
            }

            var distance = (float)Math.Sqrt(distanceSq);
            var normal = distance > 0.0001f ? delta / distance : new Vector2(1f, 0f);
            entity.Position = thicket.Center + normal * minDistance;

            var inward = entity.Velocity.X * normal.X + entity.Velocity.Y * normal.Y;
            if (inward < 0f)
            {
                entity.Velocity = bounce
                    ? entity.Velocity - normal * (2f * inward)
                    : entity.Velocity - normal * inward;
            }
        }
    }

    private static void ResolveObstacleCollisions(GameEntity entity, IReadOnlyList<Obstacle> obstacles, bool bounce)
    {
        var radius = entity.Radius;
        foreach (var obstacle in obstacles)
        {
            var pos = entity.Position;
            Vector2 normal;
            float penetration;

            if (obstacle.ContainsCenter(pos))
            {
                // Centre buried inside the box: eject along the least-penetration axis.
                var left = pos.X - obstacle.X;
                var right = obstacle.MaxX - pos.X;
                var top = pos.Y - obstacle.Y;
                var bottom = obstacle.MaxY - pos.Y;
                var min = Math.Min(Math.Min(left, right), Math.Min(top, bottom));
                if (min == left) { normal = new Vector2(-1f, 0f); penetration = left + radius; }
                else if (min == right) { normal = new Vector2(1f, 0f); penetration = right + radius; }
                else if (min == top) { normal = new Vector2(0f, -1f); penetration = top + radius; }
                else { normal = new Vector2(0f, 1f); penetration = bottom + radius; }
            }
            else
            {
                var closest = obstacle.ClosestPoint(pos);
                var delta = pos - closest;
                var distSq = delta.LengthSquared;
                if (distSq >= radius * radius)
                {
                    continue;
                }
                var dist = (float)Math.Sqrt(distSq);
                normal = dist > 0.0001f ? delta / dist : new Vector2(0f, -1f);
                penetration = radius - dist;
            }

            entity.Position = pos + normal * penetration;

            var inward = entity.Velocity.X * normal.X + entity.Velocity.Y * normal.Y;
            if (inward < 0f)
            {
                entity.Velocity = bounce
                    ? entity.Velocity - normal * (2f * inward) // reflect off the surface
                    : entity.Velocity - normal * inward;       // cancel inward component (slide)
            }
        }
    }

    private static void ResolveUnderlingCollisions(GameRoom room, IReadOnlyList<Player> players)
    {
        // Neutral food separates from owned underlings too, so a respawn batch
        // doesn't land as one overlapping clump in the middle of the map.
        var allUnderlings = AllUnderlings(room, players).ToList();
        for (var i = 0; i < allUnderlings.Count; i++)
        {
            for (var j = i + 1; j < allUnderlings.Count; j++)
            {
                var a = allUnderlings[i];
                var b = allUnderlings[j];
                var distanceSq = Vector2.DistanceSquared(a.Position, b.Position);
                var radiusSum = a.Radius + b.Radius;
                if (distanceSq < radiusSum * radiusSum)
                {
                    var tempVelocity = a.Velocity;
                    a.Velocity = b.Velocity;
                    b.Velocity = tempVelocity;

                    var direction = (a.Position - b.Position).Normalized();
                    if (direction.LengthSquared > 0)
                    {
                        var separation = radiusSum - (float)Math.Sqrt(distanceSq);
                        a.Position += direction * (separation / 2f);
                        b.Position -= direction * (separation / 2f);
                    }
                }
            }
        }
    }

    private void ResolveLeaderCollisions(IReadOnlyList<Player> players, GameRoom room)
    {
        for (var i = 0; i < players.Count; i++)
        {
            for (var j = i + 1; j < players.Count; j++)
            {
                var first = players[i].Leader;
                var second = players[j].Leader;
                var distanceSq = Vector2.DistanceSquared(first.Position, second.Position);
                var radiusSum = first.Radius + second.Radius;
                if (distanceSq < radiusSum * radiusSum)
                {
                    var direction = (first.Position - second.Position).Normalized();
                    if (direction.LengthSquared == 0)
                    {
                        direction = new Vector2(1f, 0f);
                    }
                    first.Velocity = direction * GameConstants.LeaderSpeed;
                    second.Velocity = direction * -GameConstants.LeaderSpeed;
                    first.Position += direction * 4f;
                    second.Position -= direction * 4f;

                    ResolveRam(room, players[i], players[j]);
                }
            }
        }

        ResolveLeaderUnderlingCollisions(players, room);
    }

    private void ResolveLeaderUnderlingCollisions(IReadOnlyList<Player> players, GameRoom room)
    {
        foreach (var player in players)
        {
            foreach (var opponent in players.Where(p => p != player))
            {
                // Taking one off a player books it to regrow for them, so their
                // swarm recovers and stays worth raiding again later.
                EatFrom(player, opponent.Underlings, room, opponent);
            }
            // Loose food is only ever wreckage from a fight — what a caught
            // leader spilled. Nothing arrives free.
            EatFrom(player, room.NeutralUnderlings, room, null);
        }
    }

    private static void EatFrom(Player player, List<Underling> food, GameRoom room, Player? victim)
    {
        var leader = player.Leader;
        for (var i = food.Count - 1; i >= 0; i--)
        {
            var underling = food[i];
            // Freshly spilled food is off the menu for a moment, so a rammed
            // player cannot re-swallow its own drop before anyone can contest it.
            if (underling.CoolSeconds > 0f) continue;
            var distanceSq = Vector2.DistanceSquared(leader.Position, underling.Position);
            // Extra buffer compensates for the leader's optimistic client position
            // lagging behind the server position by roughly one network round-trip.
            var radiusSum = leader.Radius + underling.Radius + GameConstants.HitForgivenessRadius;
            if (distanceSq >= radiusSum * radiusSum)
            {
                continue;
            }

            food.RemoveAt(i);
            GainSnack(player);
            victim?.RegrowTimers.Add(GameConstants.UnderlingRegrowSeconds);

            var pushDirection = (leader.Position - underling.Position).Normalized();
            if (pushDirection.LengthSquared == 0)
            {
                pushDirection = RandomUnitVector();
            }

            leader.Position += pushDirection * 6f;
            leader.Velocity = pushDirection * player.CurrentSpeed;
            room.Touch();
        }
    }

    /// <summary>
    /// Filling the belly. Hitting the threshold transforms the leader for a
    /// fixed window: it can eat other leaders and loses the carrying penalty, so
    /// the payoff reads as both power and relief. The Snack stays on the books —
    /// spending Apex hunting instead of banking means the window closes with a
    /// full belly and no protection, which is the decision inside the reward.
    /// </summary>
    private static void GainSnack(Player player)
    {
        player.Snack++;
        // Banking progress is lost by moving to eat, which stops a player
        // nibbling one more while parked safely on their bank.
        player.BankProgressSeconds = 0f;

        if (player.Snack >= GameConstants.SnackForApex && !player.IsApex)
        {
            player.ApexSecondsLeft = GameConstants.ApexDurationSeconds;
        }
    }

    /// <summary>
    /// A score race, not a war of attrition. The old rule ended a match when at
    /// most one player still had underlings, which meant the last minutes were
    /// spent combing a 2880x1920 map for one randomly wandering token — the
    /// tension collapsed exactly where it should have peaked. Banked score with a
    /// hard clock cannot degenerate that way, and it inverts the endgame: the
    /// leader is known, so everyone else has to take risks to catch them.
    /// </summary>
    private void CheckForWinner(GameRoom room)
    {
        var players = room.Players.ToList();
        if (players.Count == 0)
        {
            return;
        }

        var leader = players.OrderByDescending(p => p.Banked).First();
        var outright = leader.Banked >= room.WinThreshold;
        var timeUp = room.SecondsRemaining <= 0f;
        if (!outright && !timeUp)
        {
            return;
        }

        // On the clock a shared top score is a genuine draw.
        var top = players.Max(p => p.Banked);
        var leaders = players.Where(p => p.Banked == top).ToList();
        var winnerId = leaders.Count == 1 && top > 0 ? leaders[0].ConnectionId : null;
        room.Stop(winnerId);
        _logger.LogInformation("Room {RoomId} match ended, winner {ConnectionId}", room.Id, winnerId ?? "(draw)");
    }

    // Obstacle geometry is static for the whole app lifetime, so map both
    // variants (half world = rooms 1-4, full world = all 8) once.
    private static readonly IReadOnlyCollection<ObstacleDto> HalfWorldObstacleDtos =
        Level.HalfWorldObstacles.Select(o => new ObstacleDto(o.X, o.Y, o.Width, o.Height)).ToList();
    private static readonly IReadOnlyCollection<ObstacleDto> FullWorldObstacleDtos =
        Level.FullWorldObstacles.Select(o => new ObstacleDto(o.X, o.Y, o.Width, o.Height)).ToList();

    // Room footprints are static too, so map both variants once. The colour key
    // is the one the player spawning in that room is assigned.
    private static IReadOnlyCollection<RoomDto> MapRooms(int count) =>
        Level.Rooms.Take(count)
            .Select((r, i) => new RoomDto(r.X, r.Y, r.Width, r.Height, ColorKeyForIndex(i)))
            .ToList();

    private static readonly IReadOnlyCollection<RoomDto> HalfWorldRoomDtos = MapRooms(4);
    private static readonly IReadOnlyCollection<RoomDto> FullWorldRoomDtos = MapRooms(Level.Rooms.Count);

    private static IReadOnlyCollection<ThicketDto> MapThickets(IReadOnlyList<Thicket> thickets) =>
        thickets
            .Select(t => new ThicketDto(t.X, t.Y, t.Radius, t.VisualRadiusX, t.VisualRadiusY, t.Seed))
            .ToList();

    private static readonly IReadOnlyCollection<ThicketDto> HalfWorldThicketDtos =
        MapThickets(Level.HalfWorldThickets);
    private static readonly IReadOnlyCollection<ThicketDto> FullWorldThicketDtos =
        MapThickets(Level.FullWorldThickets);

    internal static GameStateDto BuildStateSnapshot(GameRoom room)
    {
        var serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var snapshotId = room.AllocateSnapshotId();
        var players = room.Players
            // Stable join order: the room's dictionary has no guaranteed
            // enumeration order, and a shuffling roster would make the
            // scoreboard and voice avatars jump around between snapshots.
            .OrderBy(player => player.SpawnIndex)
            .Select(player => new PlayerStateDto(
                player.ConnectionId,
                player.DisplayName,
                player.TeamColor,
                new EntityStateDto(
                    player.Leader.Id.ToString(),
                    player.Leader.OwnerId,
                    player.Leader.Position.X,
                    player.Leader.Position.Y,
                    player.Leader.Radius,
                    player.TeamColor,
                    "leader",
                    player.Leader.Velocity.X,
                    player.Leader.Velocity.Y),
                player.Underlings
                    .Select(u => new EntityStateDto(
                        u.Id.ToString(),
                        u.OwnerId,
                        u.Position.X,
                        u.Position.Y,
                        u.Radius,
                        player.TeamColor,
                        "underling",
                        u.Velocity.X,
                        u.Velocity.Y))
                    .ToList(),
                player.Snack,
                player.Banked,
                player.IsApex,
                player.ApexSecondsLeft,
                player.IsProtected,
                GameConstants.BankSecondsRequired <= 0f
                    ? 0f
                    : Math.Clamp(player.BankProgressSeconds / GameConstants.BankSecondsRequired, 0f, 1f)))
            .ToList();

        var worldWidth = room.EffectiveWorldWidth;
        var half = worldWidth <= GameConstants.HalfWorldWidth;
        var obstacles = half ? HalfWorldObstacleDtos : FullWorldObstacleDtos;
        var rooms = half ? HalfWorldRoomDtos : FullWorldRoomDtos;
        var thickets = half ? HalfWorldThicketDtos : FullWorldThicketDtos;

        var neutral = room.NeutralUnderlings
            .Select(u => new EntityStateDto(
                u.Id.ToString(), u.OwnerId, u.Position.X, u.Position.Y, u.Radius,
                "neutral", "underling", u.Velocity.X, u.Velocity.Y))
            .ToList();

        return new GameStateDto(
            room.Id, room.IsActive, players, room.WinnerId, serverTime, snapshotId,
            room.HostId, obstacles, worldWidth, GameConstants.WorldHeight, rooms, thickets,
            neutral, room.SecondsRemaining, room.WinThreshold, BuildBankZones(room, worldWidth));
    }

    private static IReadOnlyCollection<BankZoneDto> BuildBankZones(GameRoom room, float worldWidth)
    {
        if (!room.IsActive)
        {
            return Array.Empty<BankZoneDto>();
        }

        if (room.SharedBank)
        {
            var centre = MidfieldCentre(worldWidth);
            return new[] { new BankZoneDto(null, centre.X, centre.Y, GameConstants.SharedBankRadius, "neutral") };
        }

        return room.Players
            .OrderBy(p => p.SpawnIndex)
            .Select(p =>
            {
                var home = HomeOf(p);
                return new BankZoneDto(p.ConnectionId, home.X, home.Y, GameConstants.SharedBankRadius, p.TeamColor);
            })
            .ToList();
    }

    private static string GenerateRoomId()
    {
        const string chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        return string.Create(6, chars, (span, charsState) =>
        {
            for (var i = 0; i < span.Length; i++)
            {
                span[i] = charsState[Random.Shared.Next(charsState.Length)];
            }
        });
    }

    /// <summary>Rotated 90 degrees, used to slide along an obstacle instead of into it.</summary>
    private static Vector2 Perpendicular(Vector2 v) => new(-v.Y, v.X);

    private static Vector2 RandomUnitVector()
    {
        var angle = Random.Shared.NextDouble() * Math.PI * 2;
        return new Vector2((float)Math.Cos(angle), (float)Math.Sin(angle));
    }

    private static float RandomFloat(float min, float max)
    {
        var value = Random.Shared.NextDouble();
        return (float)(min + value * (max - min));
    }
}
