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

    public void UpdateInput(Direction direction)
    {
        PendingDirection = direction;
        LastInputAtUtc = DateTime.UtcNow;
    }
}
