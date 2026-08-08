namespace SwarmAndSnack.Server.Models;

public class Player
{
    public Player(string connectionId, string teamColor, string displayName)
    {
        ConnectionId = connectionId;
        TeamColor = teamColor;
        DisplayName = string.IsNullOrWhiteSpace(displayName) ? teamColor : displayName;
        Leader = new Leader(connectionId, Vector2.Zero, Vector2.Zero, teamColor);
        Underlings = new List<Underling>();
    }

    public string ConnectionId { get; }
    public string TeamColor { get; }
    public string DisplayName { get; }
    public Leader Leader { get; }
    public List<Underling> Underlings { get; }
    public Direction PendingDirection { get; set; } = Direction.None;
    public DateTime LastInputAtUtc { get; private set; } = DateTime.UtcNow;

    // Assigned in join order; indexes into Level.SpawnPoints so a player keeps
    // the same starting corner across rematches.
    public int SpawnIndex { get; set; }

    // ---- Round state -----------------------------------------------------

    /// <summary>Underlings eaten this round. Hitting the threshold turns you super.</summary>
    public int Eaten { get; set; }

    /// <summary>The hunter. Faster than everyone, and the only one who can eat a leader.</summary>
    public bool IsSuper { get; set; }

    /// <summary>Caught by the super. Out until the round resets.</summary>
    public bool IsOut { get; set; }

    /// <summary>Rounds won by catching everyone before the clock ran out.</summary>
    public int Wins { get; set; }

    /// <summary>
    /// Countdowns for underlings taken off this player. They regrow at the
    /// owner's own room, so being raided costs you the walk to collect them.
    /// </summary>
    public List<float> RegrowTimers { get; } = new();

    /// <summary>How many underlings this player started the round with.</summary>
    public int SwarmCapacity { get; set; }

    public float CurrentSpeed => IsSuper
        ? GameConstants.LeaderSpeed * GameConstants.SuperSpeedMultiplier
        : GameConstants.LeaderSpeed;

    /// <summary>Clears everything that only lasts a round. Wins survive.</summary>
    public void ResetForRound()
    {
        Eaten = 0;
        IsSuper = false;
        IsOut = false;
        RegrowTimers.Clear();
    }

    public void UpdateInput(Direction direction)
    {
        PendingDirection = direction;
        LastInputAtUtc = DateTime.UtcNow;
    }
}
