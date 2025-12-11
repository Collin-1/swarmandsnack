using SwarmAndSnack.Server.Models;

namespace SwarmAndSnack.Server.Services;

public sealed class GameLoopService : BackgroundService
{
    private readonly GameManager _gameManager;
    private readonly ILogger<GameLoopService> _logger;

    public GameLoopService(GameManager gameManager, ILogger<GameLoopService> logger)
    {
        _gameManager = gameManager;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var tickInterval = TimeSpan.FromMilliseconds(GameConstants.TargetTickRateMs);
        _logger.LogInformation("Game loop started with interval {Interval}ms", GameConstants.TargetTickRateMs);
        try
        {
            using var timer = new PeriodicTimer(tickInterval);
            var lastTick = DateTimeOffset.UtcNow;

            while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
            {
                var now = DateTimeOffset.UtcNow;
                var deltaSeconds = (now - lastTick).TotalSeconds;
                lastTick = now;

                // Clamp delta to prevent huge jumps if the server stalls (max 500ms)
                // Increased from 100ms to allow server to catch up after GC pauses or CPU throttling
                if (deltaSeconds > 0.5)
                {
                    deltaSeconds = 0.5;
                }

                await _gameManager.TickAsync(deltaSeconds, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Game loop terminated unexpectedly");
        }
    }
}
