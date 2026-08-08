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
    // ---- Snack economy ----
    IReadOnlyCollection<EntityStateDto> NeutralUnderlings,
    float SecondsRemaining,
    int WinThreshold,
    IReadOnlyCollection<BankZoneDto> BankZones
);

/// <summary>
/// Where a leader can deliver what it is carrying. One zone per player's home
/// room in a small match; a single shared zone in the contested middle once the
/// room is big enough that nobody could ever contest a bank at your door.
/// OwnerId is null for the shared zone.
/// </summary>
public record BankZoneDto(
    string? OwnerId,
    float X,
    float Y,
    float Radius,
    string ColorKey
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
    // ---- Snack economy ----
    // Snack is carried and at risk; Banked is delivered and safe. The client
    // draws Snack on the creature itself so a loaded player is readable without
    // anyone having to check a number.
    int Snack,
    int Banked,
    bool IsApex,
    float ApexSecondsLeft,
    bool IsProtected,
    float BankProgress
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
