using SwarmAndSnack.Server.Hubs;
using SwarmAndSnack.Server.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddCors(options =>
{
    options.AddPolicy("ClientCors", policy =>
    {
        var configuredOrigins = builder.Configuration["GAME_CLIENT_ORIGINS"]
            ?? builder.Configuration["ClientOrigins"]
            ?? string.Empty;

        var origins = configuredOrigins
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (origins.Length > 0)
        {
            policy.WithOrigins(origins)
                .AllowAnyHeader()
                .AllowAnyMethod()
                .AllowCredentials();
        }
        else
        {
            policy.AllowAnyHeader()
                .AllowAnyMethod()
                .AllowCredentials()
                .SetIsOriginAllowed(_ => true);
        }
    });
});

builder.Services.AddSingleton<GameManager>();
builder.Services.AddHostedService<GameLoopService>();

var app = builder.Build();

app.UseCors("ClientCors");
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapHub<GameHub>("/gamehub");
app.MapGet("/healthz", () => Results.Ok("ok"));

app.Run();
