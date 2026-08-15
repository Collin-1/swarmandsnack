using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using SwarmAndSnack.Server.Models;
using SwarmAndSnack.Server.Services;

namespace SwarmAndSnack.Server.Hubs;

public class GameHub : Hub
{
    private static readonly ConcurrentDictionary<string, string> ConnectionRooms = new();
    // Last announced microphone state per connection, so players joining later
    // see who is already unmuted without waiting for the next toggle.
    private static readonly ConcurrentDictionary<string, bool> VoiceStates = new();
    private readonly GameManager _gameManager;
    private readonly ILogger<GameHub> _logger;

    public GameHub(GameManager gameManager, ILogger<GameHub> logger)
    {
        _gameManager = gameManager;
        _logger = logger;
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        VoiceStates.TryRemove(Context.ConnectionId, out _);

        if (ConnectionRooms.TryRemove(Context.ConnectionId, out var roomId))
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, roomId);
            _gameManager.HandleDisconnect(Context.ConnectionId);

            // Tell the room who left so peers can tear down their voice
            // connections and drop the avatar immediately.
            await Clients.Group(roomId).SendAsync("PlayerLeft", new
            {
                roomId,
                playerId = Context.ConnectionId
            });
            await BroadcastLobbyUpdate(roomId);
        }
        else
        {
            _gameManager.HandleDisconnect(Context.ConnectionId);
        }

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
            player = MapPlayer(player),
            hostId = room.HostId
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

        _gameManager.TryGetRoom(roomId, out var joinedRoom);
        await Clients.Caller.SendAsync("JoinedGame", new
        {
            roomId,
            player = player is null ? null : MapPlayer(player),
            hostId = joinedRoom?.HostId
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

    // Host-gated. Used for both the initial start from the lobby and rematches.
    public async Task StartGame()
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return;
        }

        if (_gameManager.TryStartMatch(roomId, Context.ConnectionId, out var error))
        {
            await Clients.Group(roomId).SendAsync("MatchStarted", new { roomId });
        }
        else
        {
            await Clients.Caller.SendAsync("StartFailed", new { roomId, error = error ?? "Unknown" });
        }
    }

    public async Task Move(string direction)
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return;
        }

        var parsedDirection = ParseDirection(direction);
        if (!_gameManager.TryRegisterMove(roomId, Context.ConnectionId, parsedDirection))
        {
            _logger.LogDebug("Move ignored for player {Player} not found in room {Room}", Context.ConnectionId, roomId);
            return;
        }

        await Clients.Group(roomId).SendAsync("PlayerMoved", new
        {
            playerId = Context.ConnectionId,
            direction = parsedDirection.ToString().ToLowerInvariant(),
            roomId
        });
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

    /// <summary>
    /// Relays a WebRTC signalling message (offer/answer/ICE candidate) to one
    /// peer. The server never inspects the payload; it only guarantees both
    /// parties are in the same room so a connection can't be probed from outside.
    /// </summary>
    public async Task SendVoiceSignal(string targetConnectionId, string payload)
    {
        if (string.IsNullOrEmpty(targetConnectionId) || targetConnectionId == Context.ConnectionId)
        {
            return;
        }

        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId) ||
            !ConnectionRooms.TryGetValue(targetConnectionId, out var targetRoomId) ||
            roomId != targetRoomId)
        {
            return;
        }

        await Clients.Client(targetConnectionId).SendAsync("VoiceSignal", new
        {
            from = Context.ConnectionId,
            payload
        });
    }

    /// <summary>Announces whether this player's microphone is live, for avatar UI.</summary>
    /// <summary>
    /// Rename after joining. An invite link joins as soon as the page connects,
    /// so the player has not typed a name yet; without this they are stuck with
    /// whatever the field happened to hold.
    /// </summary>
    public Task SetDisplayName(string? displayName)
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return Task.CompletedTask;
        }

        _gameManager.TryRename(roomId, Context.ConnectionId, displayName);
        // The next state broadcast carries the new name, so nothing extra to send.
        return Task.CompletedTask;
    }

    public async Task SetVoiceState(bool micEnabled)
    {
        if (!ConnectionRooms.TryGetValue(Context.ConnectionId, out var roomId))
        {
            return;
        }

        VoiceStates[Context.ConnectionId] = micEnabled;
        await Clients.Group(roomId).SendAsync("VoiceStateChanged", new
        {
            playerId = Context.ConnectionId,
            micEnabled
        });
    }

    private async Task BroadcastLobbyUpdate(string roomId)
    {
        if (!_gameManager.TryGetRoom(roomId, out var room) || room is null)
        {
            return;
        }

        var lobby = room.Players
            .OrderBy(p => p.SpawnIndex)
            .Select(MapPlayer)
            .ToList();

        await Clients.Group(roomId).SendAsync("PlayerJoined", new
        {
            roomId,
            players = lobby,
            hostId = room.HostId
        });
    }

    private static object MapPlayer(Player player) => new
    {
        playerId = player.ConnectionId,
        player.DisplayName,
        teamColor = player.TeamColor,
        micEnabled = VoiceStates.TryGetValue(player.ConnectionId, out var mic) && mic
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
