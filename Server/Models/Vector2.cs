namespace SwarmAndSnack.Server.Models;

public readonly record struct Vector2(float X, float Y)
{
    public static Vector2 Zero => new(0f, 0f);

    public float LengthSquared => X * X + Y * Y;
    public float Length => (float)Math.Sqrt(LengthSquared);

    public Vector2 Normalized()
    {
        var length = Length;
        return length > 0.0001f ? new Vector2(X / length, Y / length) : Zero;
    }

    public Vector2 WithLength(float length)
    {
        var normalized = Normalized();
        return new Vector2(normalized.X * length, normalized.Y * length);
    }

    public Vector2 ClampTo(float maxLength)
    {
        var lengthSquared = LengthSquared;
        if (lengthSquared <= maxLength * maxLength)
        {
            return this;
        }

        var length = (float)Math.Sqrt(lengthSquared);
        var factor = maxLength / length;
        return new Vector2(X * factor, Y * factor);
    }

    public Vector2 BounceX() => new(-X, Y);
    public Vector2 BounceY() => new(X, -Y);

    public static Vector2 operator +(Vector2 left, Vector2 right) => new(left.X + right.X, left.Y + right.Y);

    public static Vector2 operator -(Vector2 left, Vector2 right) => new(left.X - right.X, left.Y - right.Y);

    public static Vector2 operator *(Vector2 vector, float scale) => new(vector.X * scale, vector.Y * scale);

    public static Vector2 operator /(Vector2 vector, float divisor) => new(vector.X / divisor, vector.Y / divisor);

    public static float DistanceSquared(Vector2 a, Vector2 b)
    {
        var dx = a.X - b.X;
        var dy = a.Y - b.Y;
        return dx * dx + dy * dy;
    }

    public static float Distance(Vector2 a, Vector2 b) => (float)Math.Sqrt(DistanceSquared(a, b));
}
