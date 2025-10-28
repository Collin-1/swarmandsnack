namespace SwarmAndSnack.Server.Models;

public sealed class Underling : GameEntity
{
    public Underling(string ownerId, Vector2 position, Vector2 velocity)
        : base(ownerId, position, velocity, GameConstants.UnderlingRadius)
    {
    }
}
