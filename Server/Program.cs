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
        else if (builder.Environment.IsDevelopment())
        {
            // Loopback only, so a second dev server or a file:// harness can talk
            // to the hub without opening the door to the whole internet.
            policy.AllowAnyHeader()
                .AllowAnyMethod()
                .AllowCredentials()
                .SetIsOriginAllowed(origin =>
                    Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.IsLoopback);
        }
        // Otherwise: no cross-origin access at all. The server hosts its own
        // client from wwwroot, so same-origin play needs no CORS policy — and the
        // previous default here reflected *any* origin back with
        // AllowCredentials, which lets any page on the web drive a logged-in
        // player's hub connection. Set GAME_CLIENT_ORIGINS to a semicolon-
        // separated list to host the client somewhere else.
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
