namespace SwarmAndSnack.Server.Models;

public record GameStateDto(
    string RoomId,
    bool IsActive,
    IReadOnlyCollection<PlayerStateDto> Players,
    string? WinnerId,
    long ServerTime,
    long SnapshotId,
    string? HostId,
    IReadOnlyCollection<ObstacleDto> Obstacles,
    float WorldWidth,
    float WorldHeight,
    IReadOnlyCollection<RoomDto> Rooms,
    IReadOnlyCollection<ThicketDto> Thickets,
    // ---- Two phases ----
    string Phase,
    string? SuperId,
    float HuntSecondsRemaining,
    int RoundNumber,
    int UnderlingsToBecomeSuper
);

/// <summary>
/// Undergrowth. Radius is the solid core the server collides against; RadiusX
/// and RadiusY are the wider canopy the client draws around it.
/// </summary>
public record ThicketDto(
    float X,
    float Y,
    float Radius,
    float RadiusX,
    float RadiusY,
    int Seed
);

/// <summary>
/// Room footprints, so the client can give each one its own identity instead of
/// rendering the world as one undifferentiated floor. ColorKey is the colour of
/// the player who spawns there (room order matches join order).
/// </summary>
public record RoomDto(
    float X,
    float Y,
    float Width,
    float Height,
    string ColorKey
);

public record ObstacleDto(
    float X,
    float Y,
    float Width,
    float Height
);

public record PlayerStateDto(
    string ConnectionId,
    string DisplayName,
    string TeamColor,
    EntityStateDto Leader,
    IReadOnlyCollection<EntityStateDto> Underlings,
    // ---- Round state ----
    // Eaten is progress toward turning super, drawn on the creature itself so
    // everyone can see who is close.
    int Eaten,
    bool IsSuper,
    bool IsOut,
    int Wins
);

public record EntityStateDto(
    string Id,
    string OwnerId,
    float X,
    float Y,
    float Radius,
    string Color,
    string Type,
    float Vx,
    float Vy
);
