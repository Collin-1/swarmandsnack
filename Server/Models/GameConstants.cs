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

    // ---- Two phases ------------------------------------------------------
    //
    // GATHERING: underlings are on the map and everyone races to eat them.
    // HUNTING:   the first player to eat enough turns SUPER. Every underling
    //            leaves the map and the super has two minutes to catch the other
    //            leaders. Catch them all and the super wins the match; if anyone
    //            is still alive when the clock runs out, the round resets and
    //            gathering starts again.
    //
    // The whole game is those two states and the moment between them.

    /// <summary>Underlings one player must eat to trigger the hunt.</summary>
    public const int UnderlingsToBecomeSuper = 5;

    public const float HuntDurationSeconds = 120f;

    // The super has to be faster than the people running from it or it cannot
    // hunt at all. Measured on the previous design: at parity a hunter chased a
    // fleeing opponent for a full window and never closed, because escaping was
    // just holding one direction. Enough that running in a straight line loses,
    // little enough that doors, thickets and corners still save you.
    public const float SuperSpeedMultiplier = 1.18f;

    // A caught leader is out for the rest of the round, but the round begins
    // with everyone briefly untouchable so the hunt cannot start on top of
    // somebody. On the previous design a kill with no such guard re-fired every
    // tick the leaders overlapped, 255 times in one window.
    public const float HuntStartGraceSeconds = 3f;

    // Underlings escort their owner, which is what makes a swarm something you
    // raid rather than scattered dots with no defender. The leash is loose so
    // the escort trails and spreads instead of clumping on one point.
    public const float UnderlingFollowRadius = 190f;
    public const float UnderlingLeashRadius = 340f;
    // A follower beyond the leash this long is walked back to the swarm.
    // Steering straight at the owner presses a follower into whatever wall is
    // between them and holds it there — one was measured stranded 1198px away
    // against a 340px leash.
    public const float UnderlingLostSeconds = 6f;

    // Eaten underlings regrow for the player they were taken from, at that
    // player's own room, so raiding stays worth doing and nobody is permanently
    // crippled — but being raided costs you the walk to collect them again.
    public const float UnderlingRegrowSeconds = 8f;

    // Colour keys assigned to players in join order. The client maps these keys to
    // actual render colours, so this list only needs to stay in sync with the client palette.
    public static readonly string[] PlayerColorKeys =
    {
        "cyan", "rose", "amber", "violet", "lime", "orange", "sky", "fuchsia"
    };
}
