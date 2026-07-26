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
    IReadOnlyCollection<RoomDto> Rooms
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
    IReadOnlyCollection<EntityStateDto> Underlings
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
