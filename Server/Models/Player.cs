namespace SwarmAndSnack.Server.Models;

public class Player
{
    public const int MaxNameLength = 16;

    public Player(string connectionId, string teamColor, string displayName)
    {
        ConnectionId = connectionId;
        TeamColor = teamColor;
        DisplayName = SanitiseName(displayName) ?? teamColor;
        Leader = new Leader(connectionId, Vector2.Zero, Vector2.Zero, teamColor);
        Underlings = new List<Underling>();
    }

    public string ConnectionId { get; }
    public string TeamColor { get; }
    /// <summary>
    /// Settable, because an invite link auto-joins the moment the page connects
    /// — before anyone has had a chance to type a name. Renaming has to work
    /// after the fact or those players are stuck as their team colour.
    /// </summary>
    public string DisplayName { get; private set; }

    public void Rename(string? displayName)
    {
        var clean = SanitiseName(displayName);
        if (clean is null) return;
        DisplayName = clean;
    }

    /// <summary>
    /// Names are shown to every other player, so they are constrained here at
    /// the only place they enter the game rather than trusted from the client.
    /// The input's maxlength is decoration — any hub client bypasses it, and a
    /// 2000-character name with markup in it was accepted verbatim before this.
    /// Returns null when nothing usable survives, leaving the current name.
    /// </summary>
    public static string? SanitiseName(string? displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName)) return null;

        var builder = new System.Text.StringBuilder(MaxNameLength);
        foreach (var ch in displayName.Trim())
        {
            if (builder.Length >= MaxNameLength) break;
            // An allow-list, not a block-list: anything not named here cannot
            // reach another player's screen, whatever it is.
            if (char.IsLetterOrDigit(ch) || ch is ' ' or '-' or '_' or '.')
            {
                builder.Append(ch);
            }
        }

        var result = builder.ToString().Trim();
        return result.Length == 0 ? null : result;
    }

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
