namespace SwarmAndSnack.Server.Models;

public static class GameConstants
{
    // The world is a multi-room map; the client renders a camera viewport into
    // it. With HalfWorldMaxPlayers or fewer players, only the left half
    // (rooms 1-4) is open and the world is clipped at HalfWorldWidth.
    // 3x3 camera viewports for the full world; the half world is 1.5x3.
    public const float WorldWidth = 2880f;
    public const float WorldHeight = 1920f;
    public const float HalfWorldWidth = 1440f;
    public const int HalfWorldMaxPlayers = 4;
    // Thick enough for stonework to read as blocks rather than a smudge. Walls
    // are drawn inside the room footprint, so this shrinks room interiors but
    // never narrows the corridors between rooms.
    public const float WallThickness = 44f;
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

    // ---- Snack economy ---------------------------------------------------
    //
    // One number does three jobs. Snack is what a leader has eaten and not yet
    // banked: it is score-in-waiting, it is the charge toward Apex, and it is
    // the bounty another player collects by catching you. Because it is one
    // number, every decision is the same fork — cash out, or push your luck.

    public const int SnackForApex = 5;
    public const float ApexDurationSeconds = 12f;

    // Apex has to be faster than an empty leader or it cannot hunt at all.
    // Measured: at parity an Apex chased a fleeing opponent for a full window
    // and never closed, because "escape" was just holding one direction. The
    // edge is deliberately small — enough that fleeing in a straight line loses,
    // little enough that doors, thickets and corners still save you.
    public const float ApexSpeedMultiplier = 1.15f;

    // Being eaten has to leave you briefly untouchable. Without it the kill
    // re-fires on every tick the two leaders overlap: one Apex farmed a single
    // victim 255 times in one window, because respawning put the prey back in
    // reach of a hunter that was still chasing.
    public const float RespawnProtectionSeconds = 2.5f;

    // Carrying is slow. This is the pressure that stops a player quietly
    // accumulating to Apex in a corner, and it is why holding 4 is the
    // frightening part. Apex clears the penalty entirely, so the transformation
    // reads as relief as well as power.
    public const float SnackSpeedPenaltyPerUnit = 0.025f;

    // Banking is a commitment, not a touch. Reaching home with a full belly
    // should be a climax, so it takes a moment and an enemy leader can spoil it.
    public const float BankSecondsRequired = 1f;
    public const float BankInterruptRadius = 90f;

    // Food is conserved: nothing is destroyed by being banked, it re-enters the
    // world in the contested middle. That keeps the map fed and makes the centre
    // permanently worth fighting over.
    public const float FoodRespawnIntervalSeconds = 15f;
    public const int FoodRespawnBatchMin = 3;
    public const int FoodRespawnBatchMax = 5;
    public const int MaxNeutralUnderlings = 24;
    // Half the shorter world axis: wide enough to be a region, not a point.
    public const float MidfieldRadius = 420f;

    // With four or fewer players each player banks in their own room, which is
    // where the interrupt drama lives. Above that the rooms are too far apart
    // for anyone to ever be at your door, so banking moves to one shared zone in
    // the contested middle and scoring means walking into danger instead of away
    // from it.
    public const int HomeBankMaxPlayers = 4;
    public const float SharedBankRadius = 200f;

    public const float MatchDurationSeconds = 360f; // 6 minutes

    /// <summary>
    /// Banked total needed to win outright. More players chasing the same food
    /// makes every bank harder to complete, so the bar comes down as the room
    /// fills; otherwise a big match could only ever be decided on the clock.
    /// </summary>
    public static int WinThreshold(int playerCount) => playerCount <= HomeBankMaxPlayers ? 12 : 9;

    // Colour keys assigned to players in join order. The client maps these keys to
    // actual render colours, so this list only needs to stay in sync with the client palette.
    public static readonly string[] PlayerColorKeys =
    {
        "cyan", "rose", "amber", "violet", "lime", "orange", "sky", "fuchsia"
    };
}
