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

    // ---- Snack economy ---------------------------------------------------

    /// <summary>
    /// Food belonging to nobody. Underlings enter this pool when they respawn in
    /// the midfield and when a loaded leader is caught and spills what it was
    /// carrying, so a kill puts its bounty back on the table for everyone rather
    /// than handing it to the killer.
    /// </summary>
    public List<Underling> NeutralUnderlings { get; } = new();

    /// <summary>Seconds of match left. Guarantees a match ends on the clock.</summary>
    public float SecondsRemaining { get; set; }

    /// <summary>Counts down to the next midfield food drop.</summary>
    public float FoodTimerSeconds { get; set; }

    /// <summary>Banked total that wins outright, fixed when the match starts.</summary>
    public int WinThreshold { get; private set; }

    /// <summary>
    /// With four or fewer players everyone banks at home; above that the rooms
    /// are too far apart for a bank to ever be contested, so it moves to one
    /// shared zone in the middle.
    /// </summary>
    public bool SharedBank { get; private set; }

    public void Start()
    {
        lock (_stateLock)
        {
            _frozenWorldWidth = Level.WorldWidthFor(_players.Count);
            IsActive = true;
            WinnerId = null;
            WinnerBroadcasted = false;
            MatchEnded = false;
            NeutralUnderlings.Clear();
            SecondsRemaining = GameConstants.MatchDurationSeconds;
            FoodTimerSeconds = GameConstants.FoodRespawnIntervalSeconds;
            WinThreshold = GameConstants.WinThreshold(_players.Count);
            SharedBank = _players.Count > GameConstants.HomeBankMaxPlayers;
            foreach (var player in _players.Values)
            {
                player.ResetEconomy();
            }
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
