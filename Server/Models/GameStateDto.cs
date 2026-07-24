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
    float WorldHeight
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
