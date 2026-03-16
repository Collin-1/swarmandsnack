using System.Collections.Concurrent;

namespace SwarmAndSnack.Server.Models;

public class GameRoom
{
    private readonly ConcurrentDictionary<string, Player> _players = new();
    private readonly object _stateLock = new();

    public GameRoom(string id)
    {
        Id = id;
        CreatedAtUtc = DateTime.UtcNow;
        LastActivityUtc = CreatedAtUtc;
    }

    public string Id { get; }
    public DateTime CreatedAtUtc { get; }
    public DateTime LastActivityUtc { get; private set; }
    public bool IsActive { get; private set; }
    public string? WinnerId { get; private set; }
    public bool WinnerBroadcasted { get; private set; }
    internal object SyncRoot => _stateLock;

    public IEnumerable<Player> Players => _players.Values;

    public bool TryAddPlayer(Player player)
    {
        if (_players.Count >= 2)
        {
            return false;
        }

        var added = _players.TryAdd(player.ConnectionId, player);
        if (added)
        {
            Touch();
        }
        return added;
    }

    public bool TryGetPlayer(string connectionId, out Player? player) => _players.TryGetValue(connectionId, out player);

    public bool RemovePlayer(string connectionId)
    {
        var removed = _players.TryRemove(connectionId, out _);
        if (removed)
        {
            Touch();
            if (_players.IsEmpty)
            {
                IsActive = false;
            }
        }
        return removed;
    }

    public void Touch()
    {
        LastActivityUtc = DateTime.UtcNow;
    }

    public bool ShouldStart => _players.Count == 2 && !IsActive;

    public void Start()
    {
        lock (_stateLock)
        {
            IsActive = true;
            WinnerId = null;
            WinnerBroadcasted = false;
            Touch();
        }
    }

    public void Stop(string? winnerId)
    {
        lock (_stateLock)
        {
            WinnerId = winnerId;
            IsActive = false;
            WinnerBroadcasted = false;
            Touch();
        }
    }

    public void MarkWinnerBroadcasted()
    {
        WinnerBroadcasted = true;
    }

    public bool IsEmpty => _players.IsEmpty;

    public bool IsExpired => DateTime.UtcNow - LastActivityUtc > GameConstants.RoomInactivityTimeout;
}
