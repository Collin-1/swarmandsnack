namespace SwarmAndSnack.Server.Models;

public static class GameConstants
{
    // The world is a multi-room map; the client renders a camera viewport into
    // it. With HalfWorldMaxPlayers or fewer players, only the left half
    // (rooms 1-4) is open and the world is clipped at HalfWorldWidth.
    public const float WorldWidth = 1920f;
    public const float WorldHeight = 1280f;
    public const float HalfWorldWidth = 960f;
    public const int HalfWorldMaxPlayers = 4;
    public const float WallThickness = 20f;
    public const float DoorWidth = 120f;
    public const float LeaderSpeed = 160f; // units per second
    public const float LeaderRadius = 18f;
    public const float UnderlingSpeed = 120f;
    public const float UnderlingRadius = 12f;
    public const int MinUnderlingsPerPlayer = 3;
    public const int MaxUnderlingsPerPlayer = 5;
    public static readonly TimeSpan RoomInactivityTimeout = TimeSpan.FromMinutes(10);
    public const int TargetTickRateMs = 30;
    public const float TickDeltaSeconds = TargetTickRateMs / 1000f;
    public const float HitForgivenessRadius = 12f; // covers ~75ms of lag at LeaderSpeed

    public const int MinPlayersPerRoom = 2;
    public const int MaxPlayersPerRoom = 8;

    // Colour keys assigned to players in join order. The client maps these keys to
    // actual render colours, so this list only needs to stay in sync with the client palette.
    public static readonly string[] PlayerColorKeys =
    {
        "cyan", "rose", "amber", "violet", "lime", "orange", "sky", "fuchsia"
    };
}
