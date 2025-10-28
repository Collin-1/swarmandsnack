namespace SwarmAndSnack.Server.Models;

public sealed class Leader : GameEntity
{
    public Leader(string ownerId, Vector2 position, Vector2 velocity, string color)
        : base(ownerId, position, velocity, GameConstants.LeaderRadius)
    {
        Color = color;
    }

    public string Color { get; }
}
