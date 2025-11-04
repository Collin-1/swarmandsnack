# Swarm and Snack

Swarm and Snack is a fast-paced two-player arena game built on ASP.NET Core and SignalR. Each player controls a leader surrounded by a swarm of underlings and competes to eat the opponent's swarm before losing their own. The project showcases responsive real-time multiplayer gameplay, deterministic simulation on the server, and client-side prediction for smooth rendering in the browser.

## Features

- Real-time multiplayer powered by SignalR with 50 ms server ticks.
- Deterministic .NET 9 simulation with authoritative collision resolution.
- Client-side prediction, interpolation, and input smoothing implemented in vanilla JavaScript and Canvas 2D.
- Responsive UI with match lobby, invite codes, and restart flow.
- Dockerfile and Render deployment support for hassle-free hosting.

## Technology Stack

- **Server:** ASP.NET Core 9, SignalR, hosted as a Web App.
- **Client:** JavaScript (ES2020), HTML5 Canvas, lightweight UI components.
- **Build & Tooling:** .NET SDK 9.0, npm (for static assets if extended), Docker.

## Prerequisites

- .NET SDK 9.0 or later.
- Node.js (optional, only needed if you extend client tooling).
- Docker Desktop (optional, for containerized runs).

## Getting Started

### Clone the repository

```bash
git clone https://github.com/Collin-1/swarmandsnack.git
cd swarmandsnack
```

### Run locally with the .NET SDK

```bash
dotnet restore
dotnet run --project Server/SwarmAndSnack.Server.csproj
```

Open `http://localhost:5204` (default Kestrel port) in two browser tabs or share the invite code with a friend.

### Run with Docker

```bash
docker build -t swarmandsnack .
docker run --rm -p 8080:8080 swarmandsnack
```

Navigate to `http://localhost:8080` to play.

## Gameplay Overview

1. Create a room to generate an invite code or join an existing code.
2. When two players are present, the match starts automatically.
3. Use arrow keys or WASD to move your leader. The leader directs underlings.
4. Eat opposing underlings by colliding with them. Lose when your swarm is gone.
5. After the match, restart directly from the overlay to play again.

## Deployment Notes

- The `docker` branch contains deployment-specific tweaks for Render.
- Render setup: build command `dotnet publish Server/SwarmAndSnack.Server.csproj -c Release -o build`, start command `dotnet SwarmAndSnack.Server.dll`.
- Environment variables:
  - `ASPNETCORE_URLS` (Render defaults to `http://0.0.0.0:10000`).
  - `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` for slim containers (already handled in Dockerfile).

## Development Guide

- Iteration loop:
  1.  Run `dotnet watch --project Server/SwarmAndSnack.Server.csproj` for hot reload.
  2.  Modify `Server/wwwroot/game.js` for client tweaks; the watch process serves the latest bundle.
- The client prediction system keeps a buffer of server snapshots (`stateBuffer`) and maintains a local prediction of the player's leader for tight controls.
- Server logic lives in `Server/Services/GameManager.cs`, which advances the simulation and broadcasts `GameStateDto` objects.

## Testing & Diagnostics

- Enable SignalR logging by setting `Logging__LogLevel__Microsoft.AspNetCore.SignalR=Debug` in `appsettings.Development.json` when troubleshooting connections.
- Use the browser dev tools performance tab to monitor frame times; constants at the top of `game.js` control interpolation and correction parameters.

## Roadmap Ideas

- Add mobile touch controls.
- Introduce power-ups or map hazards.
- Expand lobby to support spectating and matchmaking queues.

## License

This project is currently unlicensed. Please contact the repository owner before redistributing or deploying commercially.
