namespace SwarmAndSnack.Server.Models;

/// <summary>
/// Static arena layout: player spawn points and obstacle geometry.
/// The layout is point-symmetric about the arena centre so a free-for-all stays fair.
/// </summary>
public static class Level
{
    // Spawn points in assignment order. Indices 0 and 1 mirror the original
    // left/right two-player layout, so 2-player matches feel unchanged.
    public static readonly IReadOnlyList<Vector2> SpawnPoints = new[]
    {
        new Vector2(140f, 320f), // 0: left-centre
        new Vector2(820f, 320f), // 1: right-centre
        new Vector2(480f, 110f), // 2: top-centre
        new Vector2(480f, 530f), // 3: bottom-centre
        new Vector2(200f, 150f), // 4: top-left
        new Vector2(760f, 150f), // 5: top-right
        new Vector2(200f, 490f), // 6: bottom-left
        new Vector2(760f, 490f), // 7: bottom-right
    };

    public static readonly IReadOnlyList<Obstacle> Obstacles = new[]
    {
        new Obstacle(430f, 270f, 100f, 100f), // central pillar
        new Obstacle(400f, 150f, 160f, 24f),  // top bar
        new Obstacle(400f, 466f, 160f, 24f),  // bottom bar
        new Obstacle(218f, 240f, 24f, 160f),  // left bar
        new Obstacle(718f, 240f, 24f, 160f),  // right bar
    };
}
