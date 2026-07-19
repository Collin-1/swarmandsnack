namespace SwarmAndSnack.Server.Models;

/// <summary>
/// A static axis-aligned rectangular wall/obstacle. Origin (X, Y) is the top-left corner.
/// </summary>
public readonly record struct Obstacle(float X, float Y, float Width, float Height)
{
    public float MaxX => X + Width;
    public float MaxY => Y + Height;

    /// <summary>Closest point on the rectangle to <paramref name="point"/> (clamped inside the box).</summary>
    public Vector2 ClosestPoint(Vector2 point)
    {
        var cx = Math.Clamp(point.X, X, MaxX);
        var cy = Math.Clamp(point.Y, Y, MaxY);
        return new Vector2(cx, cy);
    }

    public bool ContainsCenter(Vector2 point) =>
        point.X >= X && point.X <= MaxX && point.Y >= Y && point.Y <= MaxY;
}
