namespace SwarmAndSnack.Server.Models;

public abstract class GameEntity
{
    protected GameEntity(string ownerId, Vector2 position, Vector2 velocity, float radius)
    {
        Id = Guid.NewGuid();
        OwnerId = ownerId;
        Position = position;
        Velocity = velocity;
        Radius = radius;
    }

    public Guid Id { get; }
    public string OwnerId { get; }
    public Vector2 Position { get; set; }
    public Vector2 Velocity { get; set; }
    public float Radius { get; }

    public void Advance(float deltaSeconds)
    {
        Position = Position + Velocity * deltaSeconds;
    }
}
