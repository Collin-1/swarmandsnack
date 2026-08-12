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

    /// <summary>
    /// Caught by a super. Dead for the rest of the match, not just the round —
    /// only survivors come back for the next one, so the field narrows until one
    /// player is left.
    /// </summary>
    public bool IsDead { get; set; }

    /// <summary>Rounds won by catching everyone before the clock ran out.</summary>
    public int Wins { get; set; }

    public float CurrentSpeed => IsSuper
        ? GameConstants.LeaderSpeed * GameConstants.SuperSpeedMultiplier
        : GameConstants.LeaderSpeed;

    /// <summary>
    /// Clears what only lasts a round. Death is deliberately not cleared here —
    /// being caught puts you out of the match, not just the round.
    /// </summary>
    public void ResetForRound()
    {
        Eaten = 0;
        IsSuper = false;
    }

    public void UpdateInput(Direction direction)
    {
        PendingDirection = direction;
        LastInputAtUtc = DateTime.UtcNow;
    }
}
