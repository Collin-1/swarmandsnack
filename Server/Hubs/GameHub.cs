using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using SwarmAndSnack.Server.Models;
using SwarmAndSnack.Server.Services;

namespace SwarmAndSnack.Server.Hubs;

public class GameHub : Hub
{
    private static readonly ConcurrentDictionary<string, string> ConnectionRooms = new();
    private readonly GameManager _gameManager;
    private readonly ILogger<GameHub> _logger;

    public GameHub(GameManager gameManager, ILogger<GameHub> logger)
    {
        _gameManager = gameManager;
        _logger = logger;
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (ConnectionRooms.TryRemove(Context.ConnectionId, out var roomId))
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, roomId);
        }

        _gameManager.HandleDisconnect(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    public async Task CreateGame(string? displayName = null)
    {
        var (room, player) = _gameManager.CreateRoom(Context.ConnectionId, displayName);
        ConnectionRooms[Context.ConnectionId] = room.Id;
        await Groups.AddToGroupAsync(Context.ConnectionId, room.Id);

        await Clients.Caller.SendAsync("GameCreated", new
        {
            roomId = room.Id,
            player = MapPlayer(player)
        });

        await BroadcastLobbyUpdate(room.Id);
    }

    public async Task JoinGame(string roomId, string? displayName = null)
    {
        if (!_gameManager.TryJoinRoom(roomId, Context.ConnectionId, displayName, out var player, out var error))
        {
            await Clients.Caller.SendAsync("JoinFailed", new { roomId, error = error ?? "Unknown" });
            return;
        }

        ConnectionRooms[Context.ConnectionId] = roomId;
        await Groups.AddToGroupAsync(Context.ConnectionId, roomId);

        await Clients.Caller.SendAsync("JoinedGame", new
        {
            roomId,
            player = player is null ? null : MapPlayer(player)
        });

        await BroadcastLobbyUpdate(roomId);
    }

    public Task LeaveGame()
    {
        if (!ConnectionRooms.TryRemove(Context.ConnectionId, out var roomId))
        {
            return Task.CompletedTask;
        }

        _gameManager.HandleDisconnect(Context.ConnectionId);
        return Groups.RemoveFromGroupAsync(Context.ConnectionId, roomId);
    }

    public async Task RestartGame()
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return;
        }

        if (_gameManager.TryRestartMatch(roomId))
        {
            await Clients.Group(roomId).SendAsync("MatchRestarted", new { roomId });
        }
    }

    public async Task Move(float x, float y, float vx, float vy, string direction)
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return;
        }

        var parsedDirection = ParseDirection(direction);
        if (!_gameManager.TryRegisterMove(roomId, Context.ConnectionId, x, y, vx, vy, parsedDirection))
        {
            _logger.LogDebug("Move ignored for player {Player} not found in room {Room}", Context.ConnectionId, roomId);
            return;
        }

        // We don't need to broadcast PlayerMoved anymore since state updates handle it
        // But we can keep it if the client relies on it for something else (it doesn't seem to)
    }

    public async Task RequestState()
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return;
        }

        if (!_gameManager.TryGetRoom(roomId, out var room) || room is null)
        {
            return;
        }

        var state = GameManager.BuildStateSnapshot(room);
        await Clients.Caller.SendAsync("GameStateUpdated", state);
    }

    private async Task BroadcastLobbyUpdate(string roomId)
    {
        if (!_gameManager.TryGetRoom(roomId, out var room) || room is null)
        {
            return;
        }

        var lobby = room.Players
            .Select(MapPlayer)
            .ToList();

        await Clients.Group(roomId).SendAsync("PlayerJoined", new
        {
            roomId,
            players = lobby
        });
    }

    private static object MapPlayer(Player player) => new
    {
        playerId = player.ConnectionId,
        player.DisplayName,
        teamColor = player.TeamColor
    };

    private static Direction ParseDirection(string? input)
    {
        if (input is null)
        {
            return Direction.None;
        }

        return input.ToLowerInvariant() switch
        {
            "up" => Direction.Up,
            "down" => Direction.Down,
            "left" => Direction.Left,
            "right" => Direction.Right,
            _ => Direction.None
        };
    }

    public string Ping() => "Pong";
}
