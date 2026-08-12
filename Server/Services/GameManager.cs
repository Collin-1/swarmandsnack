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

    /// <summary>
    /// Always the same number, for every player, in every round of every match.
    /// The count used to be a random 3-5 rolled per match, which meant no two
    /// games started from the same board.
    /// </summary>
    private static void InitializePlayerEntities(
        Player player, int spawnIndex, float worldWidth,
        int underlingCount = GameConstants.UnderlingsPerPlayer)
    {
        // The leader starts in its own room; the swarm is scattered across the
        // whole open world instead of huddling around it, so a swarm can't be
        // wiped out in one pass through a single room.
        var spawn = Level.SpawnPoints[spawnIndex % Level.SpawnPoints.Count];
        player.Leader.Position = spawn;
        player.Leader.Velocity = Vector2.Zero;
        player.Underlings.Clear();

        var obstacles = Level.ObstaclesFor(worldWidth);
        var count = underlingCount > 0 ? underlingCount : GameConstants.UnderlingsPerPlayer;
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
        // A fixed count, not a random one: every round of every match starts with
        // the same pool, so "how much is left" always means the same thing.
        var worldWidth = room.EffectiveWorldWidth;
        foreach (var player in room.Players)
        {
            InitializePlayerEntities(
                player, player.SpawnIndex, worldWidth, GameConstants.UnderlingsPerPlayer);
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

        foreach (var underling in AllUnderlings(room, players))
        {
            SteerUnderlingAway(underling, players);
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

        if (room.Phase == GamePhase.Hunting)
        {
            UpdateHunt(room, players, deltaSeconds);
        }

        room.Touch();
    }

    /// <summary>
    /// The hunt. Every underling has left the map, the super is faster than
    /// everyone, and it is the only thing that can eat a leader. Catch them all
    /// and the super takes the match; if anyone is still alive when the clock
    /// runs out, the round resets and gathering starts again.
    /// </summary>
    private void UpdateHunt(GameRoom room, IReadOnlyList<Player> players, float deltaSeconds)
    {
        if (room.GraceSecondsRemaining > 0f)
        {
            // Nobody can be caught for a moment after the change, so a hunt
            // never starts with the super already standing on somebody.
            room.GraceSecondsRemaining = Math.Max(0f, room.GraceSecondsRemaining - deltaSeconds);
        }
        else
        {
            ResolveSuperCatches(room, players);
        }

        var survivors = players.Count(p => !p.IsSuper && !p.IsDead);
        if (survivors == 0)
        {
            var super = players.FirstOrDefault(p => p.IsSuper);
            if (super is not null)
            {
                super.Wins++;
                _logger.LogInformation("Room {RoomId}: {Super} caught everyone", room.Id, super.ConnectionId);
                room.Stop(super.ConnectionId);
            }
            return;
        }

        room.HuntSecondsRemaining = Math.Max(0f, room.HuntSecondsRemaining - deltaSeconds);
        if (room.HuntSecondsRemaining <= 0f)
        {
            _logger.LogInformation(
                "Room {RoomId}: {Count} survived the hunt", room.Id, survivors);
            StartGathering(room, players);
        }
    }

    /// <summary>The super eats leaders on contact. Everyone else just bumps.</summary>
    private void ResolveSuperCatches(GameRoom room, IReadOnlyList<Player> players)
    {
        var super = players.FirstOrDefault(p => p.IsSuper);
        if (super is null) return;

        foreach (var prey in players)
        {
            if (prey.IsSuper || prey.IsDead) continue;
            var reach = super.Leader.Radius + prey.Leader.Radius + GameConstants.HitForgivenessRadius;
            if (Vector2.DistanceSquared(super.Leader.Position, prey.Leader.Position) >= reach * reach)
            {
                continue;
            }

            // Dead for the match, not the round. Their underlings go with them,
            // so the pool shrinks as the field does.
            prey.IsDead = true;
            prey.Leader.Velocity = Vector2.Zero;
            prey.Underlings.Clear();
            _logger.LogInformation("Room {RoomId}: {Super} caught {Prey}", room.Id, super.ConnectionId, prey.ConnectionId);
        }
    }

    /// <summary>
    /// Turns a player super: the map is swept of underlings and the clock starts.
    /// This is the moment the game changes.
    /// </summary>
    private void BecomeSuper(GameRoom room, IReadOnlyList<Player> players, Player super)
    {
        room.Phase = GamePhase.Hunting;
        room.SuperId = super.ConnectionId;
        room.HuntSecondsRemaining = GameConstants.HuntDurationSeconds;
        room.GraceSecondsRemaining = GameConstants.HuntStartGraceSeconds;

        foreach (var player in players)
        {
            player.IsSuper = ReferenceEquals(player, super);
            // No more food: the hunt is only about leaders.
            player.Underlings.Clear();
        }

        _logger.LogInformation("Room {RoomId}: {Super} became super, hunt begins", room.Id, super.ConnectionId);
    }

    /// <summary>
    /// Back to gathering — but only for whoever is still alive. Players caught
    /// during a hunt stay dead, so each round starts with a smaller field, and
    /// the match ends when one player is left standing.
    /// </summary>
    private void StartGathering(GameRoom room, IReadOnlyList<Player> players)
    {
        var alive = players.Where(p => !p.IsDead).ToList();
        if (alive.Count <= 1)
        {
            var winner = alive.FirstOrDefault();
            if (winner is not null) winner.Wins++;
            _logger.LogInformation(
                "Room {RoomId}: {Winner} is the last one standing", room.Id, winner?.ConnectionId ?? "(nobody)");
            room.Stop(winner?.ConnectionId);
            return;
        }

        room.Phase = GamePhase.Gathering;
        room.SuperId = null;
        room.HuntSecondsRemaining = 0f;
        room.GraceSecondsRemaining = 0f;
        room.RoundNumber++;

        var worldWidth = room.EffectiveWorldWidth;
        foreach (var player in players)
        {
            player.ResetForRound();
            player.Underlings.Clear();
            // A dead player keeps no swarm and takes no further part.
            if (player.IsDead) continue;
            InitializePlayerEntities(
                player, player.SpawnIndex, worldWidth, GameConstants.UnderlingsPerPlayer);
        }
    }

    /// <summary>Every underling in the room. All food belongs to a player now.</summary>
    private static IEnumerable<Underling> AllUnderlings(GameRoom room, IReadOnlyList<Player> players)
        => players.SelectMany(p => p.Underlings);

    /// <summary>The centre of a player's own room — where they spawn and regrow.</summary>
    private static Vector2 HomeOf(Player player) => Level.SpawnPoints[player.SpawnIndex % Level.SpawnPoints.Count];

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
    /// <summary>
    /// Underlings stay scattered and run from anything that can eat them.
    ///
    /// They used to escort their owner, which turned a swarm into one cluster a
    /// leader could clear in a single pass. Scattered and evasive, each one is a
    /// small chase instead — and because they only fear leaders that can
    /// actually eat them, an underling ignores its own.
    /// </summary>
    private static void SteerUnderlingAway(Underling underling, IReadOnlyList<Player> players)
    {
        Player? threat = null;
        var nearestSq = GameConstants.UnderlingFleeRadius * GameConstants.UnderlingFleeRadius;

        foreach (var player in players)
        {
            // Your own leader is harmless to you, and a dead one is harmless to
            // everyone.
            if (player.IsDead || player.ConnectionId == underling.OwnerId) continue;
            var distanceSq = Vector2.DistanceSquared(player.Leader.Position, underling.Position);
            if (distanceSq < nearestSq)
            {
                nearestSq = distanceSq;
                threat = player;
            }
        }

        if (threat is not null)
        {
            var away = (underling.Position - threat.Leader.Position).Normalized();
            if (away.LengthSquared == 0) away = RandomUnitVector();
            underling.Velocity = away * GameConstants.UnderlingFleeSpeed;
            return;
        }

        // Nothing near: drift, so the map keeps shifting instead of freezing.
        if (Random.Shared.NextDouble() < 0.02)
        {
            underling.Velocity = RandomUnitVector() * GameConstants.UnderlingDriftSpeed;
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
                    // Leaders just bump. The only thing that hurts a leader is
                    // the super, and that is handled by the hunt.
                    first.Velocity = direction * GameConstants.LeaderSpeed;
                    second.Velocity = direction * -GameConstants.LeaderSpeed;
                    first.Position += direction * 4f;
                    second.Position -= direction * 4f;
                }
            }
        }

        ResolveLeaderUnderlingCollisions(players, room);
    }

    private void ResolveLeaderUnderlingCollisions(IReadOnlyList<Player> players, GameRoom room)
    {
        // Nothing to eat during a hunt — the map was swept when the game changed.
        if (room.Phase != GamePhase.Gathering) return;

        foreach (var player in players)
        {
            if (player.IsDead) continue;

            foreach (var opponent in players.Where(p => p != player))
            {
                EatFrom(player, opponent.Underlings, room);
            }

            if (player.Eaten >= GameConstants.UnderlingsToBecomeSuper)
            {
                BecomeSuper(room, players, player);
                return;
            }
        }

        // Nothing regrows, so the map can run dry with nobody at the threshold —
        // players eating each other's swarms unevenly, or a swarm dying with its
        // owner. Whoever ate most takes the hunt rather than letting gathering
        // stall forever with no food left.
        if (players.Any(p => !p.IsDead) && players.All(p => p.Underlings.Count == 0))
        {
            var best = players.Where(p => !p.IsDead).OrderByDescending(p => p.Eaten).First();
            _logger.LogInformation(
                "Room {RoomId}: map is empty, {Player} leads with {Eaten}", room.Id, best.ConnectionId, best.Eaten);
            BecomeSuper(room, players, best);
        }
    }

    private static void EatFrom(Player player, List<Underling> food, GameRoom room)
    {
        var leader = player.Leader;
        for (var i = food.Count - 1; i >= 0; i--)
        {
            var underling = food[i];
            var distanceSq = Vector2.DistanceSquared(leader.Position, underling.Position);
            // Extra buffer compensates for the leader's optimistic client position
            // lagging behind the server position by roughly one network round-trip.
            var radiusSum = leader.Radius + underling.Radius + GameConstants.HitForgivenessRadius;
            if (distanceSq >= radiusSum * radiusSum)
            {
                continue;
            }

            // Nothing regrows. The pool the round started with is the pool, so
            // gathering is a race for something that only ever gets scarcer.
            food.RemoveAt(i);
            player.Eaten++;

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
                player.Eaten,
                player.IsSuper,
                player.IsDead,
                player.Wins))
            .ToList();

        var worldWidth = room.EffectiveWorldWidth;
        var half = worldWidth <= GameConstants.HalfWorldWidth;
        var obstacles = half ? HalfWorldObstacleDtos : FullWorldObstacleDtos;
        var rooms = half ? HalfWorldRoomDtos : FullWorldRoomDtos;
        var thickets = half ? HalfWorldThicketDtos : FullWorldThicketDtos;

        return new GameStateDto(
            room.Id, room.IsActive, players, room.WinnerId, serverTime, snapshotId,
            room.HostId, obstacles, worldWidth, GameConstants.WorldHeight, rooms, thickets,
            room.Phase, room.SuperId, room.HuntSecondsRemaining, room.RoundNumber,
            GameConstants.UnderlingsToBecomeSuper);
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
