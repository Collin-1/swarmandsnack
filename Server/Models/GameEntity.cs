namespace SwarmAndSnack.Server.Models;

public abstract class GameEntity
{
    protected GameEntity(string ownerId, Vector2 position, Vector2 velocity, float radius)
    {
        OwnerId = ownerId;
        Position = position;
        Velocity = velocity;
        Radius = radius;
    }

    public string OwnerId { get; }
    public Vector2 Position { get; set; }
    public Vector2 Velocity { get; set; }
    public float Radius { get; }

    public void Advance(float deltaSeconds)
    {
        Position = Position + Velocity * deltaSeconds;
    }
}
