using System.Collections.Concurrent;

namespace SwarmAndSnack.Server.Models;

public class GameRoom
{
    private readonly ConcurrentDictionary<string, Player> _players = new();
    private readonly object _stateLock = new();
    private long _snapshotCounter;

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
    // True once a started match has finished (win or draw). Distinguishes a
    // just-ended match from a lobby room that never started, so a draw
    // (null WinnerId) is still announced exactly once.
    public bool MatchEnded { get; private set; }
    public string? HostId { get; private set; }
    internal object SyncRoot => _stateLock;

    public IEnumerable<Player> Players => _players.Values;

    public int PlayerCount => _players.Count;

    public bool TryAddPlayer(Player player)
    {
        if (_players.Count >= GameConstants.MaxPlayersPerRoom)
        {
            return false;
        }

        var added = _players.TryAdd(player.ConnectionId, player);
        if (added)
        {
            HostId ??= player.ConnectionId;
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
            if (connectionId == HostId)
            {
                // Promote the next remaining player to host so the room stays startable.
                HostId = _players.Keys.FirstOrDefault();
            }
            if (_players.IsEmpty)
            {
                IsActive = false;
            }
        }
        return removed;
    }

    public bool IsHost(string connectionId) => HostId is not null && HostId == connectionId;

    public void Touch()
    {
        LastActivityUtc = DateTime.UtcNow;
    }

    public bool CanStart => _players.Count >= GameConstants.MinPlayersPerRoom && !IsActive;

    private float _frozenWorldWidth = GameConstants.HalfWorldWidth;

    // In the lobby the world tracks the live player count (so joining a 5th
    // player visibly opens the right half); once a match starts the width is
    // frozen so mid-match disconnects can't shrink the world around players.
    public float EffectiveWorldWidth =>
        IsActive ? _frozenWorldWidth : Level.WorldWidthFor(_players.Count);

    public void Start()
    {
        lock (_stateLock)
        {
            _frozenWorldWidth = Level.WorldWidthFor(_players.Count);
            IsActive = true;
            WinnerId = null;
            WinnerBroadcasted = false;
            MatchEnded = false;
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
            MatchEnded = true;
            Touch();
        }
    }

    public void MarkWinnerBroadcasted()
    {
        WinnerBroadcasted = true;
    }

    public bool IsEmpty => _players.IsEmpty;

    public bool IsExpired => DateTime.UtcNow - LastActivityUtc > GameConstants.RoomInactivityTimeout;

    public long AllocateSnapshotId()
    {
        return Interlocked.Increment(ref _snapshotCounter);
    }
}
