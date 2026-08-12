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

    /// <summary>
    /// Underlings per player, fixed. Nothing spawns mid-round and nothing
    /// regrows: the map holds exactly what it started with, so gathering is a
    /// race for a known, shrinking pool rather than a farm that refills.
    ///
    /// This must stay above <see cref="UnderlingsToBecomeSuper"/>. A player can
    /// only eat other players' underlings, so in a two-player match the entire
    /// reachable pool is one opponent's swarm — at four each against a threshold
    /// of five, nobody could ever turn super and the round never ended.
    /// </summary>
    public const int UnderlingsPerPlayer = 6;

    // Underlings are scattered across the whole map and stay scattered. They do
    // not escort anyone — a swarm gathered around its owner is a swarm that can
    // be cleared in one pass, which made catching them far too easy.
    //
    // Instead they run. A leader that could eat one is a threat it steers away
    // from, so every underling is a small chase rather than a pickup.
    public const float UnderlingFleeRadius = 210f;

    // Fleeing has to be slow enough that a chase is winnable, and the ceiling is
    // lower than it looks. Leaders move on four axes only; an underling flees
    // along whatever angle points away. Chasing something diagonally, a leader's
    // 160 is worth only 160/sqrt(2) = 113 of closing speed, so at a flee speed of
    // 110 a diagonal chase closed at about 3px/s — measured, a chaser took
    // ninety seconds to eat nothing, then three minutes to manage four.
    //
    // 85 leaves 28px/s in the worst case and 75px/s straight down an axis. Still
    // evasive, and cornering one against a wall is now the skill.
    public const float UnderlingFleeSpeed = 85f;

    /// <summary>Idle wander. Slower than fleeing, so running away visibly reads as running away.</summary>
    public const float UnderlingDriftSpeed = 55f;

    // Colour keys assigned to players in join order. The client maps these keys to
    // actual render colours, so this list only needs to stay in sync with the client palette.
    public static readonly string[] PlayerColorKeys =
    {
        "cyan", "rose", "amber", "violet", "lime", "orange", "sky", "fuchsia"
    };
}
