import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number.parseInt(process.env.PORT ?? "5204", 10);

const GAME = {
  arenaWidth: 960,
  arenaHeight: 640,
  leaderSpeed: 160,
  leaderRadius: 18,
  underlingSpeed: 120,
  underlingRadius: 12,
  minUnderlings: 3,
  maxUnderlings: 5,
  roomTimeoutMs: 10 * 60 * 1000,
  tickMs: 16,
};

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();
const socketsById = new Map();
const connectionInfo = new Map();

function nowMs() {
  return Date.now();
}

function send(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const player of room.players.values()) {
    const ws = socketsById.get(player.connectionId);
    send(ws, payload);
  }
}

function generateRoomId() {
  let id = "";
  for (let i = 0; i < 6; i += 1) {
    id += roomAlphabet[Math.floor(Math.random() * roomAlphabet.length)];
  }
  return id;
}

function randomUnitVector() {
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function vectorLengthSquared(v) {
  return v.x * v.x + v.y * v.y;
}

function vectorLength(v) {
  return Math.sqrt(vectorLengthSquared(v));
}

function normalize(v) {
  const length = vectorLength(v);
  if (length < 0.0001) return { x: 0, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

function withLength(v, length) {
  const n = normalize(v);
  return { x: n.x * length, y: n.y * length };
}

function directionToVector(direction) {
  switch ((direction ?? "none").toLowerCase()) {
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    default:
      return { x: 0, y: 0 };
  }
}

function createRoom() {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  const room = {
    id: roomId,
    createdAt: nowMs(),
    lastActivity: nowMs(),
    isActive: false,
    winnerId: null,
    winnerBroadcasted: false,
    players: new Map(),
  };

  rooms.set(roomId, room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = nowMs();
}

function isExpired(room) {
  return nowMs() - room.lastActivity > GAME.roomTimeoutMs;
}

function shouldStart(room) {
  return room.players.size === 2 && !room.isActive && room.winnerId == null;
}

function createPlayer(connectionId, teamColor, displayName) {
  return {
    connectionId,
    teamColor,
    displayName:
      displayName && displayName.trim().length > 0 ? displayName : teamColor,
    pendingDirection: "none",
    lastInputAt: nowMs(),
    leader: {
      id: crypto.randomUUID(),
      ownerId: connectionId,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: GAME.leaderRadius,
      type: "leader",
    },
    underlings: [],
  };
}

function initializePlayerEntities(player, spawnLeft) {
  const leaderX = spawnLeft ? GAME.arenaWidth * 0.25 : GAME.arenaWidth * 0.75;
  const leaderY = GAME.arenaHeight * 0.5;
  player.leader.x = leaderX;
  player.leader.y = leaderY;
  player.leader.vx = 0;
  player.leader.vy = 0;
  player.underlings = [];

  const count =
    GAME.minUnderlings +
    Math.floor(Math.random() * (GAME.maxUnderlings - GAME.minUnderlings + 1));
  for (let i = 0; i < count; i += 1) {
    const offsetX = randomFloat(-60, 60);
    const offsetY = randomFloat(-60, 60);
    const positionX = leaderX + offsetX;
    const positionY = leaderY + offsetY;
    const direction = randomUnitVector();
    player.underlings.push({
      id: crypto.randomUUID(),
      ownerId: player.connectionId,
      x: positionX,
      y: positionY,
      vx: direction.x * GAME.underlingSpeed,
      vy: direction.y * GAME.underlingSpeed,
      radius: GAME.underlingRadius,
      type: "underling",
    });
  }
}

function resetRoom(room) {
  for (const player of room.players.values()) {
    const spawnLeft = player.teamColor.toLowerCase() === "blue";
    initializePlayerEntities(player, spawnLeft);
  }
  touchRoom(room);
}

function updateLeaderMovement(player) {
  const desired = directionToVector(player.pendingDirection);
  if (vectorLengthSquared(desired) > 0.01) {
    const velocity = withLength(desired, GAME.leaderSpeed);
    player.leader.vx = velocity.x;
    player.leader.vy = velocity.y;
  } else {
    player.leader.vx = 0;
    player.leader.vy = 0;
  }
}

function maybeNudgeUnderling(underling) {
  if (Math.random() < 0.02) {
    const direction = randomUnitVector();
    underling.vx = direction.x * GAME.underlingSpeed;
    underling.vy = direction.y * GAME.underlingSpeed;
  }
}

function advanceEntity(entity, deltaSeconds) {
  entity.x += entity.vx * deltaSeconds;
  entity.y += entity.vy * deltaSeconds;
}

function bounceOffWalls(entity) {
  let x = entity.x;
  let y = entity.y;
  const r = entity.radius;

  if (x - r < 0) {
    x = r;
    entity.vx = -entity.vx;
  } else if (x + r > GAME.arenaWidth) {
    x = GAME.arenaWidth - r;
    entity.vx = -entity.vx;
  }

  if (y - r < 0) {
    y = r;
    entity.vy = -entity.vy;
  } else if (y + r > GAME.arenaHeight) {
    y = GAME.arenaHeight - r;
    entity.vy = -entity.vy;
  }

  entity.x = x;
  entity.y = y;
}

function resolveUnderlingCollisions(players) {
  const all = [];
  for (const player of players) {
    all.push(...player.underlings);
  }

  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distanceSq = dx * dx + dy * dy;
      const radiusSum = a.radius + b.radius;
      if (distanceSq < radiusSum * radiusSum) {
        const tempVx = a.vx;
        const tempVy = a.vy;
        a.vx = b.vx;
        a.vy = b.vy;
        b.vx = tempVx;
        b.vy = tempVy;

        const direction = normalize({ x: dx, y: dy });
        if (vectorLengthSquared(direction) > 0) {
          const separation = radiusSum - Math.sqrt(distanceSq);
          a.x += direction.x * (separation / 2);
          a.y += direction.y * (separation / 2);
          b.x -= direction.x * (separation / 2);
          b.y -= direction.y * (separation / 2);
        }
      }
    }
  }
}

function resolveLeaderCollisions(players, room) {
  if (players.length !== 2) return;

  const first = players[0].leader;
  const second = players[1].leader;
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  const distanceSq = dx * dx + dy * dy;
  const radiusSum = first.radius + second.radius;
  if (distanceSq < radiusSum * radiusSum) {
    let direction = normalize({ x: dx, y: dy });
    if (vectorLengthSquared(direction) === 0) {
      direction = { x: 1, y: 0 };
    }
    first.vx = direction.x * GAME.leaderSpeed;
    first.vy = direction.y * GAME.leaderSpeed;
    second.vx = -direction.x * GAME.leaderSpeed;
    second.vy = -direction.y * GAME.leaderSpeed;
    first.x += direction.x * 4;
    first.y += direction.y * 4;
    second.x -= direction.x * 4;
    second.y -= direction.y * 4;
  }

  resolveLeaderUnderlingCollisions(players, room);
}

function resolveLeaderUnderlingCollisions(players, room) {
  for (const player of players) {
    for (const opponent of players.filter((p) => p !== player)) {
      const leader = player.leader;
      for (let i = opponent.underlings.length - 1; i >= 0; i -= 1) {
        const underling = opponent.underlings[i];
        const dx = leader.x - underling.x;
        const dy = leader.y - underling.y;
        const distanceSq = dx * dx + dy * dy;
        const radiusSum = leader.radius + underling.radius;
        if (distanceSq < radiusSum * radiusSum) {
          opponent.underlings.splice(i, 1);
          let push = normalize({ x: dx, y: dy });
          if (vectorLengthSquared(push) === 0) {
            push = randomUnitVector();
          }
          leader.x += push.x * 6;
          leader.y += push.y * 6;
          leader.vx = push.x * GAME.leaderSpeed;
          leader.vy = push.y * GAME.leaderSpeed;
          touchRoom(room);
        }
      }
    }
  }
}

function checkForWinner(room) {
  const players = Array.from(room.players.values());
  for (const player of players) {
    const opponent = players.find((p) => p !== player);
    if (!opponent) continue;
    if (opponent.underlings.length === 0) {
      room.isActive = false;
      room.winnerId = player.connectionId;
      room.winnerBroadcasted = false;
      touchRoom(room);
      return;
    }
  }
}

function buildStateSnapshot(room) {
  const players = Array.from(room.players.values()).map((player) => ({
    connectionId: player.connectionId,
    displayName: player.displayName,
    teamColor: player.teamColor,
    leader: {
      id: player.leader.id,
      ownerId: player.leader.ownerId,
      x: player.leader.x,
      y: player.leader.y,
      radius: player.leader.radius,
      color: player.teamColor,
      type: "leader",
      vx: player.leader.vx,
      vy: player.leader.vy,
    },
    underlings: player.underlings.map((u) => ({
      id: u.id,
      ownerId: u.ownerId,
      x: u.x,
      y: u.y,
      radius: u.radius,
      color: player.teamColor,
      type: "underling",
      vx: u.vx,
      vy: u.vy,
    })),
  }));

  return {
    roomId: room.id,
    isActive: room.isActive,
    players,
    winnerId: room.winnerId,
    serverTime: nowMs(),
  };
}

function updateRoom(room, deltaSeconds) {
  const players = Array.from(room.players.values());
  for (const player of players) {
    updateLeaderMovement(player);
  }

  for (const underling of players.flatMap((p) => p.underlings)) {
    maybeNudgeUnderling(underling);
    advanceEntity(underling, deltaSeconds);
    bounceOffWalls(underling);
  }

  for (const player of players) {
    advanceEntity(player.leader, deltaSeconds);
    bounceOffWalls(player.leader);
  }

  resolveUnderlingCollisions(players);
  resolveLeaderCollisions(players, room);
  checkForWinner(room);
  touchRoom(room);
}

function sendLobbyUpdate(room) {
  const lobby = Array.from(room.players.values()).map((player) => ({
    playerId: player.connectionId,
    displayName: player.displayName,
    teamColor: player.teamColor,
  }));

  broadcastRoom(room.id, {
    type: "playerJoined",
    roomId: room.id,
    players: lobby,
  });
}

function handleDisconnect(connectionId, roomId) {
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.players.delete(connectionId);
  touchRoom(room);

  if (room.players.size === 0) {
    rooms.delete(roomId);
    return;
  }

  if (room.isActive) {
    const remaining = Array.from(room.players.values())[0];
    room.isActive = false;
    room.winnerId = remaining.connectionId;
    room.winnerBroadcasted = false;
    touchRoom(room);
  }
}

wss.on("connection", (ws) => {
  const connectionId = crypto.randomUUID();
  socketsById.set(connectionId, ws);
  connectionInfo.set(ws, { id: connectionId, roomId: null });

  send(ws, { type: "connected", playerId: connectionId });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }

    const info = connectionInfo.get(ws);
    if (!info) return;

    switch (message.type) {
      case "createGame": {
        const room = createRoom();
        const player = createPlayer(connectionId, "blue", message.displayName);
        room.players.set(connectionId, player);
        initializePlayerEntities(player, true);
        info.roomId = room.id;
        touchRoom(room);

        send(ws, {
          type: "gameCreated",
          roomId: room.id,
          player: {
            playerId: player.connectionId,
            displayName: player.displayName,
            teamColor: player.teamColor,
          },
        });

        sendLobbyUpdate(room);
        break;
      }
      case "joinGame": {
        const roomId = (message.roomId ?? "").toUpperCase();
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { type: "joinFailed", roomId, error: "RoomNotFound" });
          break;
        }

        if (room.players.size >= 2) {
          send(ws, { type: "joinFailed", roomId, error: "RoomFull" });
          break;
        }

        const team = room.players.size === 0 ? "blue" : "red";
        const player = createPlayer(connectionId, team, message.displayName);
        initializePlayerEntities(player, team === "blue");
        room.players.set(connectionId, player);
        info.roomId = room.id;
        touchRoom(room);

        send(ws, {
          type: "joinedGame",
          roomId: room.id,
          player: {
            playerId: player.connectionId,
            displayName: player.displayName,
            teamColor: player.teamColor,
          },
        });

        sendLobbyUpdate(room);
        break;
      }
      case "leaveGame": {
        handleDisconnect(connectionId, info.roomId);
        info.roomId = null;
        break;
      }
      case "restartGame": {
        const room = rooms.get(info.roomId);
        if (!room || room.players.size < 2) return;
        room.winnerId = null;
        room.winnerBroadcasted = false;
        resetRoom(room);
        room.isActive = true;
        broadcastRoom(room.id, { type: "matchRestarted", roomId: room.id });
        break;
      }
      case "move": {
        const room = rooms.get(info.roomId);
        if (!room) return;
        const player = room.players.get(connectionId);
        if (!player) return;
        player.pendingDirection = message.direction ?? "none";
        player.lastInputAt = nowMs();
        touchRoom(room);
        broadcastRoom(room.id, {
          type: "playerMoved",
          roomId: room.id,
          playerId: connectionId,
          direction: player.pendingDirection,
        });
        break;
      }
      case "requestState": {
        const room = rooms.get(info.roomId);
        if (!room) return;
        send(ws, { type: "gameStateUpdated", state: buildStateSnapshot(room) });
        break;
      }
      case "ping": {
        send(ws, { type: "pong", ts: message.ts ?? nowMs() });
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    const info = connectionInfo.get(ws);
    if (info) {
      handleDisconnect(info.id, info.roomId);
    }
    connectionInfo.delete(ws);
    socketsById.delete(connectionId);
  });
});

let lastTick = nowMs();
setInterval(() => {
  const current = nowMs();
  let deltaSeconds = (current - lastTick) / 1000;
  lastTick = current;
  if (deltaSeconds > 0.5) deltaSeconds = 0.5;

  for (const room of rooms.values()) {
    if (isExpired(room)) {
      rooms.delete(room.id);
      continue;
    }

    let announceWinner = false;

    if (shouldStart(room)) {
      resetRoom(room);
      room.isActive = true;
    }

    if (!room.isActive) {
      const state = buildStateSnapshot(room);
      broadcastRoom(room.id, { type: "gameStateUpdated", state });
    } else {
      updateRoom(room, deltaSeconds);
      const state = buildStateSnapshot(room);
      broadcastRoom(room.id, { type: "gameStateUpdated", state });

      if (room.winnerId && !room.winnerBroadcasted) {
        announceWinner = true;
        room.winnerBroadcasted = true;
      }
    }

    if (announceWinner && room.winnerId) {
      broadcastRoom(room.id, { type: "gameOver", winnerId: room.winnerId });
    }
  }
}, GAME.tickMs);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Swarm and Snack server listening on ${PORT}`);
});
