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
            var consecutiveFailures = 0;

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

                // One bad tick must not end the loop. This catch used to sit
                // outside the while, so a single exception — from one room, one
                // player, one dropped connection — returned from ExecuteAsync and
                // froze every match on the server permanently. Nothing restarts a
                // completed BackgroundService, and /healthz kept answering 200,
                // so the process looked alive while no game advanced again.
                try
                {
                    await _gameManager.TickAsync(deltaSeconds, stoppingToken);
                    consecutiveFailures = 0;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    consecutiveFailures++;
                    // A tick fires 33 times a second, so an unconditional log would
                    // bury the first occurrence under thousands of copies. Log the
                    // first few, then every ~10 seconds while it keeps failing.
                    if (consecutiveFailures <= 3 || consecutiveFailures % 300 == 0)
                    {
                        _logger.LogError(ex, "Game tick failed ({Count} in a row); skipping this tick", consecutiveFailures);
                    }
                }
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
