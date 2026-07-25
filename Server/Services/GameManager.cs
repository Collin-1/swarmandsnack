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

        foreach (var player in players)
        {
            UpdateLeaderMovement(player);
        }

        foreach (var underling in players.SelectMany(p => p.Underlings))
        {
            MaybeNudgeUnderling(underling);
            underling.Advance(deltaSeconds);
            BounceOffWalls(underling, worldWidth);
            ResolveObstacleCollisions(underling, obstacles, bounce: true);
        }

        foreach (var player in players)
        {
            player.Leader.Advance(deltaSeconds);
            BounceOffWalls(player.Leader, worldWidth);
            ResolveObstacleCollisions(player.Leader, obstacles, bounce: false);
        }

        ResolveUnderlingCollisions(players);
        ResolveLeaderCollisions(players, room);
        CheckForWinner(room);
        room.Touch();
    }

    private static void UpdateLeaderMovement(Player player)
    {
        var desiredVelocity = player.PendingDirection.ToVector();
        if (desiredVelocity.LengthSquared > 0.01f)
        {
            desiredVelocity = desiredVelocity.WithLength(GameConstants.LeaderSpeed);
        }
        player.Leader.Velocity = desiredVelocity;
    }

    private static void MaybeNudgeUnderling(Underling underling)
    {
        if (Random.Shared.NextDouble() < 0.02)
        {
            var direction = RandomUnitVector();
            underling.Velocity = direction * GameConstants.UnderlingSpeed;
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

    private static void ResolveUnderlingCollisions(IReadOnlyList<Player> players)
    {
        var allUnderlings = players.SelectMany(p => p.Underlings).ToList();
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
                var leader = player.Leader;
                for (var i = opponent.Underlings.Count - 1; i >= 0; i--)
                {
                    var underling = opponent.Underlings[i];
                    var distanceSq = Vector2.DistanceSquared(leader.Position, underling.Position);
                    // Extra buffer compensates for the leader's optimistic client position
                    // lagging behind the server position by roughly one network round-trip.
                    var radiusSum = leader.Radius + underling.Radius + GameConstants.HitForgivenessRadius;
                    if (distanceSq < radiusSum * radiusSum)
                    {
                        opponent.Underlings.RemoveAt(i);
                        var pushDirection = (leader.Position - underling.Position).Normalized();
                        if (pushDirection.LengthSquared == 0)
                        {
                            pushDirection = RandomUnitVector();
                        }

                        leader.Position += pushDirection * 6f;
                        leader.Velocity = pushDirection * GameConstants.LeaderSpeed;
                        room.Touch();
                    }
                }
            }
        }
    }

    private void CheckForWinner(GameRoom room)
    {
        // Free-for-all: the match ends when at most one player still has underlings.
        var alive = room.Players.Where(p => p.Underlings.Count > 0).ToList();
        if (alive.Count > 1)
        {
            return;
        }

        // Exactly one survivor wins; zero survivors (simultaneous knockout) is a draw.
        var winnerId = alive.Count == 1 ? alive[0].ConnectionId : null;
        room.Stop(winnerId);
        _logger.LogInformation("Room {RoomId} match ended, winner {ConnectionId}", room.Id, winnerId ?? "(draw)");
    }

    // Obstacle geometry is static for the whole app lifetime, so map both
    // variants (half world = rooms 1-4, full world = all 8) once.
    private static readonly IReadOnlyCollection<ObstacleDto> HalfWorldObstacleDtos =
        Level.HalfWorldObstacles.Select(o => new ObstacleDto(o.X, o.Y, o.Width, o.Height)).ToList();
    private static readonly IReadOnlyCollection<ObstacleDto> FullWorldObstacleDtos =
        Level.FullWorldObstacles.Select(o => new ObstacleDto(o.X, o.Y, o.Width, o.Height)).ToList();

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
                    .ToList()))
            .ToList();

        var worldWidth = room.EffectiveWorldWidth;
        var obstacles = worldWidth <= GameConstants.HalfWorldWidth
            ? HalfWorldObstacleDtos
            : FullWorldObstacleDtos;

        return new GameStateDto(
            room.Id, room.IsActive, players, room.WinnerId, serverTime, snapshotId,
            room.HostId, obstacles, worldWidth, GameConstants.WorldHeight);
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
