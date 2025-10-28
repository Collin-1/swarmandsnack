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
            while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
            {
                await _gameManager.TickAsync(stoppingToken);
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
