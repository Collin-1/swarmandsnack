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

    // ---- Snack economy ---------------------------------------------------

    /// <summary>Eaten but not yet banked. Score-in-waiting, Apex charge, and bounty.</summary>
    public int Snack { get; set; }

    /// <summary>Delivered home. Safe: nothing can take this away.</summary>
    public int Banked { get; set; }

    /// <summary>Seconds of Apex left. Above zero the leader can eat other leaders.</summary>
    public float ApexSecondsLeft { get; set; }

    /// <summary>Progress through the current banking commitment, in seconds.</summary>
    public float BankProgressSeconds { get; set; }

    /// <summary>Briefly untouchable after being eaten, so a kill can't re-fire every tick.</summary>
    public float ProtectedSecondsLeft { get; set; }

    public bool IsApex => ApexSecondsLeft > 0f;
    public bool IsProtected => ProtectedSecondsLeft > 0f;

    /// <summary>
    /// Carrying slows you, which is what makes a full belly dangerous to hold.
    /// Apex clears the penalty, so transforming feels like being unburdened.
    /// </summary>
    public float CurrentSpeed => IsApex
        ? GameConstants.LeaderSpeed * GameConstants.ApexSpeedMultiplier
        : GameConstants.LeaderSpeed *
          (1f - GameConstants.SnackSpeedPenaltyPerUnit * Math.Min(Snack, GameConstants.SnackForApex));

    public void ResetEconomy()
    {
        Snack = 0;
        Banked = 0;
        ApexSecondsLeft = 0f;
        BankProgressSeconds = 0f;
        ProtectedSecondsLeft = 0f;
    }

    public void UpdateInput(Direction direction)
    {
        PendingDirection = direction;
        LastInputAtUtc = DateTime.UtcNow;
    }
}
