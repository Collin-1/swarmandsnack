# Swarm and Snack

Swarm and Snack is a fast-paced two-player arena game built on Node.js and WebSockets. Each player controls a leader surrounded by a swarm of underlings and competes to eat the opponent's swarm before losing their own. The project showcases responsive real-time multiplayer gameplay, deterministic simulation on the server, and client-side prediction for smooth rendering in the browser.

## Features

- Real-time multiplayer powered by WebSockets with 30 ms server ticks for ultra-smooth gameplay.
- Deterministic Node.js simulation with authoritative collision resolution.
- Optimistic client-side input for zero-latency local player control.
- Responsive UI with match lobby, invite codes, and restart flow.
- Dockerfile and Render deployment support for hassle-free hosting.

## Technology Stack

- **Server:** Node.js, Express, WebSocket (ws).
- **Client:** JavaScript (ES2020), HTML5 Canvas, lightweight UI components.
- **Build & Tooling:** npm, Docker.

## Prerequisites

- Node.js 20 or later.
- Docker Desktop (optional, for containerized runs).

## Getting Started

### Clone the repository

```bash
git clone https://github.com/Collin-1/swarmandsnack.git
cd swarmandsnack
```

### Run locally with Node.js

```bash
cd Server
npm install
npm start
```

Open `http://localhost:5204` (default server port) in two browser tabs or share the invite code with a friend.

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

- Environment variables:
  - `PORT` (defaults to 5204 locally; containers use 8080).

## Development Guide

- Iteration loop:
  1.  Run `npm start` in `Server/`.
  2.  Modify `Server/public/game.js` for client tweaks; refresh the browser.
- The client uses **optimistic local updates** for zero-latency controls: your leader moves instantly on screen while the server validates in the background.
- Server logic lives in `Server/server.js`, which advances the simulation and broadcasts state objects at 30ms intervals.
- See `ARCHITECTURE.md` for detailed explanation of the simplified client-server model.

## Testing & Diagnostics

- Enable SignalR logging by setting `Logging__LogLevel__Microsoft.AspNetCore.SignalR=Debug` in `appsettings.Development.json` when troubleshooting connections.
- Use the browser dev tools performance tab to monitor frame times; constants at the top of `game.js` control interpolation and correction parameters.

## Roadmap Ideas

- Add mobile touch controls.
- Introduce power-ups or map hazards.
- Expand lobby to support spectating and matchmaking queues.

## License

This project is currently unlicensed. Please contact the repository owner before redistributing or deploying commercially.
