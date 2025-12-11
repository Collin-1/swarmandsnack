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
        var player = CreatePlayer(connectionId, "blue", displayName);
        room.TryAddPlayer(player);
        InitializePlayerEntities(player, spawnLeft: true);
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

        var existingCount = room.Players.Count();
        if (existingCount >= 2)
        {
            error = "RoomFull";
            return false;
        }

        var team = existingCount == 0 ? "blue" : "red";
        player = CreatePlayer(connectionId, team, displayName);
        InitializePlayerEntities(player, spawnLeft: team == "blue");

        if (!room.TryAddPlayer(player))
        {
            error = "RoomFull";
            return false;
        }

        _logger.LogInformation("Player {ConnectionId} joined room {RoomId}", connectionId, roomId);
        return true;
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
                if (!room.IsEmpty && room.IsActive)
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

    public bool TryRestartMatch(string roomId)
    {
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            return false;
        }

        lock (room.SyncRoot)
        {
            if (room.Players.Count() < 2)
            {
                return false;
            }

            ResetRoom(room);
            room.Start();
            _logger.LogInformation("Room {RoomId} match restarted", roomId);
            return true;
        }
    }

    public async Task TickAsync(double deltaSeconds, CancellationToken cancellationToken)
    {
        var rooms = _rooms.Values.ToList();
        foreach (var room in rooms)
        {
            if (room.IsExpired)
            {
                _rooms.TryRemove(room.Id, out _);
                _logger.LogInformation("Room {RoomId} expired and was removed", room.Id);
                continue;
            }

            bool shouldBroadcast;
            GameStateDto? state;
            string? winnerId;
            bool announceWinner;

            lock (room.SyncRoot)
            {
                winnerId = room.WinnerId;
                announceWinner = winnerId is not null && !room.WinnerBroadcasted;

                if (room.ShouldStart)
                {
                    ResetRoom(room);
                    room.Start();
                    _logger.LogInformation("Room {RoomId} match started", room.Id);
                }

                if (!room.IsActive)
                {
                    state = BuildStateSnapshot(room);
                    shouldBroadcast = true;
                }
                else
                {
                    UpdateRoom(room, (float)deltaSeconds);
                    winnerId = room.WinnerId;
                    if (winnerId is not null && !room.WinnerBroadcasted)
                    {
                        announceWinner = true;
                    }
                    state = BuildStateSnapshot(room);
                    shouldBroadcast = true;
                }

                if (announceWinner && winnerId is not null)
                {
                    room.MarkWinnerBroadcasted();
                }
            }

            if (shouldBroadcast && state is not null)
            {
                await _hubContext.Clients.Group(room.Id)
                    .SendAsync("GameStateUpdated", state, cancellationToken);
            }

            if (announceWinner && winnerId is not null)
            {
                await _hubContext.Clients.Group(room.Id)
                    .SendAsync("GameOver", new { winnerId }, cancellationToken);
            }
        }
    }

    private static Player CreatePlayer(string connectionId, string team, string? displayName)
    {
        return new Player(connectionId, team, displayName ?? team);
    }

    private static void InitializePlayerEntities(Player player, bool spawnLeft)
    {
        var leaderX = spawnLeft ? GameConstants.ArenaWidth * 0.25f : GameConstants.ArenaWidth * 0.75f;
        var leaderY = GameConstants.ArenaHeight * 0.5f;
        player.Leader.Position = new Vector2(leaderX, leaderY);
        player.Leader.Velocity = Vector2.Zero;
        player.Underlings.Clear();

        var underlingCount = Random.Shared.Next(GameConstants.MinUnderlingsPerPlayer, GameConstants.MaxUnderlingsPerPlayer + 1);
        for (var i = 0; i < underlingCount; i++)
        {
            var offsetX = RandomFloat(-60f, 60f);
            var offsetY = RandomFloat(-60f, 60f);
            var position = new Vector2(leaderX + offsetX, leaderY + offsetY);
            var direction = RandomUnitVector();
            var velocity = direction * GameConstants.UnderlingSpeed;
            player.Underlings.Add(new Underling(player.ConnectionId, position, velocity));
        }
    }

    private static void ResetRoom(GameRoom room)
    {
        foreach (var player in room.Players)
        {
            var spawnLeft = player.TeamColor.Equals("blue", StringComparison.OrdinalIgnoreCase);
            InitializePlayerEntities(player, spawnLeft);
        }
        room.Touch();
    }

    private void UpdateRoom(GameRoom room, float deltaSeconds)
    {
        var players = room.Players.ToList();

        foreach (var player in players)
        {
            UpdateLeaderMovement(player);
        }

        foreach (var underling in players.SelectMany(p => p.Underlings))
        {
            MaybeNudgeUnderling(underling);
            underling.Advance(deltaSeconds);
            BounceOffWalls(underling);
        }

        foreach (var player in players)
        {
            player.Leader.Advance(deltaSeconds);
            BounceOffWalls(player.Leader);
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

    private static void BounceOffWalls(GameEntity entity)
    {
        var pos = entity.Position;
        var radius = entity.Radius;

        if (pos.X - radius < 0f)
        {
            pos = new Vector2(radius, pos.Y);
            entity.Velocity = entity.Velocity.BounceX();
        }
        else if (pos.X + radius > GameConstants.ArenaWidth)
        {
            pos = new Vector2(GameConstants.ArenaWidth - radius, pos.Y);
            entity.Velocity = entity.Velocity.BounceX();
        }

        if (pos.Y - radius < 0f)
        {
            pos = new Vector2(pos.X, radius);
            entity.Velocity = entity.Velocity.BounceY();
        }
        else if (pos.Y + radius > GameConstants.ArenaHeight)
        {
            pos = new Vector2(pos.X, GameConstants.ArenaHeight - radius);
            entity.Velocity = entity.Velocity.BounceY();
        }

        entity.Position = pos;
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
        if (players.Count != 2)
        {
            return;
        }

        var first = players[0].Leader;
        var second = players[1].Leader;
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
                    var radiusSum = leader.Radius + underling.Radius;
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
        foreach (var player in room.Players)
        {
            var opponent = room.Players.FirstOrDefault(p => p != player);
            if (opponent is null)
            {
                continue;
            }

            if (opponent.Underlings.Count == 0)
            {
                room.Stop(player.ConnectionId);
                _logger.LogInformation("Room {RoomId} winner {ConnectionId}", room.Id, player.ConnectionId);
                return;
            }
        }
    }

    internal static GameStateDto BuildStateSnapshot(GameRoom room)
    {
        var serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var players = room.Players
            .Select(player => new PlayerStateDto(
                player.ConnectionId,
                player.DisplayName,
                player.TeamColor,
                new EntityStateDto(
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

        return new GameStateDto(room.Id, room.IsActive, players, room.WinnerId, serverTime);
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
