namespace SwarmAndSnack.Server.Models;

public enum DoorSide { Top, Bottom, Left, Right }

/// <summary>
/// A rectangular room whose walls are generated as obstacles, with a door gap
/// on each listed side. Players spawn at their room's centre. Rooms with two
/// doors are through-routes rather than dead ends, so a swarm can't be cornered
/// against a single exit.
/// </summary>
public readonly record struct LevelRoom(
    float X, float Y, float Width, float Height, IReadOnlyList<DoorSide> Doors)
{
    public Vector2 Center => new(X + Width / 2f, Y + Height / 2f);
    public bool HasDoor(DoorSide side) => Doors.Contains(side);
}

/// <summary>
/// Static world layout: an 8-room map inside a 2880x1920 world, plus
/// free-standing wall shapes (L, T, U, cross, staircase, bars, pillars) filling
/// the space between rooms. Rooms 1-4 and their surrounding shapes sit entirely
/// in the left half, rooms 5-8 in the right, so a match with 4 or fewer players
/// can seal the world at x = HalfWorldWidth and still contain every open room.
///
/// Shapes are composed from axis-aligned rectangles because collision is
/// circle-vs-AABB; staircases stand in for diagonals.
/// </summary>
public static class Level
{
    // Room index = spawn order (player N gets room N). Most rooms have two
    // doors so they can be entered and left from different sides.
    private static readonly DoorSide[] BottomRight = { DoorSide.Bottom, DoorSide.Right };
    private static readonly DoorSide[] TopRight = { DoorSide.Top, DoorSide.Right };
    private static readonly DoorSide[] LeftRight = { DoorSide.Left, DoorSide.Right };
    private static readonly DoorSide[] TopLeft = { DoorSide.Top, DoorSide.Left };
    private static readonly DoorSide[] BottomLeft = { DoorSide.Bottom, DoorSide.Left };
    private static readonly DoorSide[] RightOnly = { DoorSide.Right };
    private static readonly DoorSide[] LeftOnly = { DoorSide.Left };
    private static readonly DoorSide[] BottomOnly = { DoorSide.Bottom };

    public static readonly IReadOnlyList<LevelRoom> Rooms = new[]
    {
        // Left half (x < 1440)
        new LevelRoom(120f, 120f, 520f, 400f, BottomRight),   // 1: top-left
        new LevelRoom(120f, 700f, 380f, 520f, RightOnly),     // 2: mid-left
        new LevelRoom(300f, 1420f, 600f, 340f, TopRight),     // 3: bottom-left
        new LevelRoom(780f, 640f, 480f, 480f, LeftRight),     // 4: centre-left, through-route
        // Right half (x > 1440)
        new LevelRoom(1560f, 1400f, 640f, 380f, TopLeft),     // 5: bottom-centre
        new LevelRoom(2400f, 760f, 360f, 560f, LeftOnly),     // 6: right edge
        new LevelRoom(2180f, 140f, 560f, 420f, BottomLeft),   // 7: top-right
        new LevelRoom(1600f, 140f, 340f, 540f, BottomOnly),   // 8: top-centre, tall
    };

    public static readonly IReadOnlyList<Vector2> SpawnPoints =
        Rooms.Select(r => r.Center).ToList();

    private const float T = 24f; // default wall thickness for free-standing shapes

    /// <summary>Free-standing walls in the left half (always present).</summary>
    private static readonly IReadOnlyList<Obstacle> LeftShapes = BuildLeftShapes().ToList();

    /// <summary>Free-standing walls in the right half (full-world matches only).</summary>
    private static readonly IReadOnlyList<Obstacle> RightShapes = BuildRightShapes().ToList();

    public static readonly IReadOnlyList<Obstacle> HalfWorldObstacles =
        Rooms.Take(4).SelectMany(BuildWalls).Concat(LeftShapes).ToList();

    public static readonly IReadOnlyList<Obstacle> FullWorldObstacles =
        Rooms.SelectMany(BuildWalls).Concat(LeftShapes).Concat(RightShapes).ToList();

    public static float WorldWidthFor(int playerCount) =>
        playerCount <= GameConstants.HalfWorldMaxPlayers
            ? GameConstants.HalfWorldWidth
            : GameConstants.WorldWidth;

    public static IReadOnlyList<Obstacle> ObstaclesFor(float worldWidth) =>
        worldWidth <= GameConstants.HalfWorldWidth ? HalfWorldObstacles : FullWorldObstacles;

    private static IEnumerable<Obstacle> BuildLeftShapes()
    {
        foreach (var o in LShape(700f, 180f, 260f, 220f, T)) yield return o;
        foreach (var o in Staircase(1060f, 160f, 3, 120f, 110f, 22f)) yield return o;
        foreach (var o in Cross(580f, 1180f, 210f, 200f, T)) yield return o;
        foreach (var o in TShape(1000f, 1460f, 300f, 190f, T)) yield return o;
        yield return new Obstacle(1350f, 520f, 22f, 560f);   // long vertical line
        yield return new Obstacle(180f, 1330f, 22f, 300f);   // short vertical line
        yield return new Obstacle(560f, 560f, 64f, 64f);     // pillar
        yield return new Obstacle(1310f, 1240f, 70f, 70f);   // pillar
    }

    private static IEnumerable<Obstacle> BuildRightShapes()
    {
        foreach (var o in UShape(1990f, 200f, 180f, 270f, T)) yield return o;
        foreach (var o in Staircase(1500f, 780f, 4, 120f, 110f, 22f)) yield return o;
        foreach (var o in Cross(2040f, 1150f, 220f, 215f, 26f)) yield return o;
        foreach (var o in LShape(2500f, 1450f, 260f, 220f, T, flipX: true)) yield return o;
        foreach (var o in TShape(2250f, 600f, 300f, 140f, T)) yield return o;
        yield return new Obstacle(1450f, 1250f, 300f, 20f);  // long horizontal line
        yield return new Obstacle(2820f, 700f, 20f, 420f);   // wall-hugging line
        yield return new Obstacle(2650f, 1760f, 70f, 70f);   // pillar
        yield return new Obstacle(1470f, 1500f, 64f, 64f);   // pillar
    }

    // ---- Shape builders -----------------------------------------------------

    /// <summary>Corner piece: one horizontal arm and one vertical arm.</summary>
    private static IEnumerable<Obstacle> LShape(
        float x, float y, float w, float h, float t, bool flipX = false, bool flipY = false)
    {
        var armY = flipY ? y + h - t : y;
        var armX = flipX ? x + w - t : x;
        yield return new Obstacle(x, armY, w, t);
        yield return new Obstacle(armX, y, t, h);
    }

    /// <summary>Bar across the top with a stem descending from its centre.</summary>
    private static IEnumerable<Obstacle> TShape(float x, float y, float w, float h, float t)
    {
        yield return new Obstacle(x, y, w, t);
        yield return new Obstacle(x + w / 2f - t / 2f, y, t, h);
    }

    /// <summary>Three sides of a box, open at the top.</summary>
    private static IEnumerable<Obstacle> UShape(float x, float y, float w, float h, float t)
    {
        yield return new Obstacle(x, y, t, h);
        yield return new Obstacle(x + w - t, y, t, h);
        yield return new Obstacle(x, y + h - t, w, t);
    }

    /// <summary>Plus sign: intersecting horizontal and vertical bars.</summary>
    private static IEnumerable<Obstacle> Cross(float x, float y, float w, float h, float t)
    {
        yield return new Obstacle(x, y + h / 2f - t / 2f, w, t);
        yield return new Obstacle(x + w / 2f - t / 2f, y, t, h);
    }

    /// <summary>Stepped diagonal running right and down, as treads and risers.</summary>
    private static IEnumerable<Obstacle> Staircase(
        float x, float y, int steps, float stepW, float stepH, float t)
    {
        var cx = x;
        var cy = y;
        for (var i = 0; i < steps; i++)
        {
            yield return new Obstacle(cx, cy, stepW, t);       // tread
            cx += stepW - t;
            yield return new Obstacle(cx, cy, t, stepH);       // riser
            cy += stepH - t;
        }
    }

    // Emit the four wall rectangles of a room, splitting the door side into
    // two segments around a centred gap.
    private static IEnumerable<Obstacle> BuildWalls(LevelRoom r)
    {
        var t = GameConstants.WallThickness;
        var d = GameConstants.DoorWidth;
        var cx = r.X + r.Width / 2f;
        var cy = r.Y + r.Height / 2f;
        var right = r.X + r.Width;
        var bottom = r.Y + r.Height;

        // Top
        if (r.HasDoor(DoorSide.Top))
        {
            yield return new Obstacle(r.X, r.Y, cx - d / 2f - r.X, t);
            yield return new Obstacle(cx + d / 2f, r.Y, right - (cx + d / 2f), t);
        }
        else
        {
            yield return new Obstacle(r.X, r.Y, r.Width, t);
        }

        // Bottom
        if (r.HasDoor(DoorSide.Bottom))
        {
            yield return new Obstacle(r.X, bottom - t, cx - d / 2f - r.X, t);
            yield return new Obstacle(cx + d / 2f, bottom - t, right - (cx + d / 2f), t);
        }
        else
        {
            yield return new Obstacle(r.X, bottom - t, r.Width, t);
        }

        // Left
        if (r.HasDoor(DoorSide.Left))
        {
            yield return new Obstacle(r.X, r.Y, t, cy - d / 2f - r.Y);
            yield return new Obstacle(r.X, cy + d / 2f, t, bottom - (cy + d / 2f));
        }
        else
        {
            yield return new Obstacle(r.X, r.Y, t, r.Height);
        }

        // Right
        if (r.HasDoor(DoorSide.Right))
        {
            yield return new Obstacle(right - t, r.Y, t, cy - d / 2f - r.Y);
            yield return new Obstacle(right - t, cy + d / 2f, t, bottom - (cy + d / 2f));
        }
        else
        {
            yield return new Obstacle(right - t, r.Y, t, r.Height);
        }
    }
}
