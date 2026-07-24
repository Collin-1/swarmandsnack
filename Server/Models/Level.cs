namespace SwarmAndSnack.Server.Models;

public enum DoorSide { Top, Bottom, Left, Right }

/// <summary>
/// A rectangular room whose walls are generated as obstacles, with a door gap
/// on one side. Players spawn at their room's centre.
/// </summary>
public readonly record struct LevelRoom(float X, float Y, float Width, float Height, DoorSide Door)
{
    public Vector2 Center => new(X + Width / 2f, Y + Height / 2f);
}

/// <summary>
/// Static world layout: an 8-room map (modelled on the design sketch) inside a
/// 1920x1280 world. Rooms 1-4 occupy the left half, rooms 5-8 the right half,
/// so a match with 4 or fewer players can seal the world at x = HalfWorldWidth
/// and still contain every occupied room.
/// </summary>
public static class Level
{
    // Room index = spawn order (player N gets room N).
    // Left half (x < 960):                       Sketch label
    public static readonly IReadOnlyList<LevelRoom> Rooms = new[]
    {
        new LevelRoom(80f, 80f, 440f, 340f, DoorSide.Bottom),   // 1: top-left
        new LevelRoom(80f, 520f, 280f, 380f, DoorSide.Right),   // 2: left edge
        new LevelRoom(240f, 960f, 480f, 240f, DoorSide.Top),    // 3: bottom-left
        new LevelRoom(560f, 480f, 340f, 360f, DoorSide.Left),   // 4: centre
        // Right half (x > 960):
        new LevelRoom(1040f, 920f, 520f, 280f, DoorSide.Top),   // 5: bottom-centre
        new LevelRoom(1600f, 520f, 260f, 420f, DoorSide.Left),  // 6: right edge
        new LevelRoom(1400f, 80f, 440f, 320f, DoorSide.Bottom), // 7: top-right
        new LevelRoom(1060f, 80f, 240f, 400f, DoorSide.Bottom), // 8: top-centre, tall
    };

    public static readonly IReadOnlyList<Vector2> SpawnPoints =
        Rooms.Select(r => r.Center).ToList();

    /// <summary>Walls for the left-half rooms only (half-world matches).</summary>
    public static readonly IReadOnlyList<Obstacle> HalfWorldObstacles =
        Rooms.Take(4).SelectMany(BuildWalls).ToList();

    /// <summary>Walls for every room (full-world matches).</summary>
    public static readonly IReadOnlyList<Obstacle> FullWorldObstacles =
        Rooms.SelectMany(BuildWalls).ToList();

    public static float WorldWidthFor(int playerCount) =>
        playerCount <= GameConstants.HalfWorldMaxPlayers
            ? GameConstants.HalfWorldWidth
            : GameConstants.WorldWidth;

    public static IReadOnlyList<Obstacle> ObstaclesFor(float worldWidth) =>
        worldWidth <= GameConstants.HalfWorldWidth ? HalfWorldObstacles : FullWorldObstacles;

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
        if (r.Door == DoorSide.Top)
        {
            yield return new Obstacle(r.X, r.Y, cx - d / 2f - r.X, t);
            yield return new Obstacle(cx + d / 2f, r.Y, right - (cx + d / 2f), t);
        }
        else
        {
            yield return new Obstacle(r.X, r.Y, r.Width, t);
        }

        // Bottom
        if (r.Door == DoorSide.Bottom)
        {
            yield return new Obstacle(r.X, bottom - t, cx - d / 2f - r.X, t);
            yield return new Obstacle(cx + d / 2f, bottom - t, right - (cx + d / 2f), t);
        }
        else
        {
            yield return new Obstacle(r.X, bottom - t, r.Width, t);
        }

        // Left
        if (r.Door == DoorSide.Left)
        {
            yield return new Obstacle(r.X, r.Y, t, cy - d / 2f - r.Y);
            yield return new Obstacle(r.X, cy + d / 2f, t, bottom - (cy + d / 2f));
        }
        else
        {
            yield return new Obstacle(r.X, r.Y, t, r.Height);
        }

        // Right
        if (r.Door == DoorSide.Right)
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
