namespace SwarmAndSnack.Server.Models;

public static class GameConstants
{
    public const float ArenaWidth = 960f;
    public const float ArenaHeight = 640f;
    public const float LeaderSpeed = 160f; // units per second
    public const float LeaderRadius = 18f;
    public const float UnderlingSpeed = 120f;
    public const float UnderlingRadius = 12f;
    public const int MinUnderlingsPerPlayer = 3;
    public const int MaxUnderlingsPerPlayer = 5;
    public static readonly TimeSpan RoomInactivityTimeout = TimeSpan.FromMinutes(10);
    public const int TargetTickRateMs = 30;
    public const float TickDeltaSeconds = TargetTickRateMs / 1000f;
}
