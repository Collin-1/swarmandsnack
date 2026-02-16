(() => {
  const LEADER_SPEED = 160;
  const LEADER_RADIUS = 18;
  const REMOTE_SMOOTHING = 0.25;
  const DEBUG_MODE = false;

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const inviteEl = document.getElementById("invite");
  const overlayEl = document.getElementById("overlay");
  const overlayMessageEl = document.getElementById("overlayMessage");
  const restartBtn = document.getElementById("restartBtn");
  const displayNameInput = document.getElementById("displayName");
  const roomCodeInput = document.getElementById("roomCode");
  const createBtn = document.getElementById("createBtn");
  const joinBtn = document.getElementById("joinBtn");

  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  let socket;
  let roomId = null;
  let myPlayerId = null;
  let lastDirectionSent = "none";
  let pendingDirection = "none";
  let lastFrame = performance.now();

  let serverState = createEmptyState();
  let myLocalLeader = { x: canvasWidth / 2, y: canvasHeight / 2, vx: 0, vy: 0 };
  let localDirectionVector = { x: 0, y: 0 };
  const activeKeyDirections = new Map();
  const interpolatedEntities = new Map();

  let frameCount = 0;
  let lastDebugLog = performance.now();
  let serverUpdateCount = 0;
  let inputsSent = 0;
  let currentLatency = 0.1;
  let lastPingTime = 0;
  let reconnectAttempts = 0;

  const directionByKey = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    w: "up",
    a: "left",
    s: "down",
    d: "right",
    W: "up",
    A: "left",
    S: "down",
    D: "right",
  };

  function createEmptyState() {
    return {
      roomId: null,
      isActive: false,
      winnerId: null,
      players: [],
    };
  }

  function setStatus(message) {
    statusEl.textContent = message;
  }

  function setInviteLink(code) {
    if (!code) {
      inviteEl.textContent = "";
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("code", code);
    inviteEl.textContent = `Invite link: ${url.toString()}`;
    roomCodeInput.value = code;
  }

  function showOverlay(message) {
    overlayMessageEl.textContent = message;
    overlayEl.classList.remove("hidden");
  }

  function hideOverlay() {
    overlayEl.classList.add("hidden");
  }

  function buildWsUrl() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}`;
  }

  function connect() {
    socket = new WebSocket(buildWsUrl());

    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("Connected. Create or join a game.");
      flushDirection();

      const queryCode = new URLSearchParams(window.location.search).get("code");
      if (queryCode) {
        roomCodeInput.value = queryCode.toUpperCase();
        joinBtn.click();
      }
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        return;
      }

      switch (payload.type) {
        case "connected":
          myPlayerId = payload.playerId;
          break;
        case "gameCreated":
          roomId = payload.roomId;
          myPlayerId = payload.player?.playerId ?? myPlayerId;
          serverState = createEmptyState();
          setStatus("Room created. Waiting for an opponent…");
          setInviteLink(roomId);
          hideOverlay();
          break;
        case "joinedGame":
          roomId = payload.roomId;
          myPlayerId = payload.player?.playerId ?? myPlayerId;
          serverState = createEmptyState();
          setStatus("Joined game. Waiting for opponent…");
          setInviteLink(roomId);
          hideOverlay();
          sendMessage("requestState");
          break;
        case "joinFailed":
          setStatus(`Join failed: ${payload.error}`);
          break;
        case "playerJoined":
          if ((payload.players ?? []).length < 2) {
            setStatus("Waiting for opponent to join…");
          } else {
            setStatus("Opponent connected! Get ready.");
          }
          break;
        case "gameStateUpdated":
          serverState = payload.state;
          roomId = payload.state.roomId;
          serverUpdateCount += 1;
          applyLocalCorrection(payload.state);
          updateStatusFromState(payload.state);
          break;
        case "gameOver":
          if (!payload.winnerId) return;
          const winner = serverState.players.find(
            (p) => p.connectionId === payload.winnerId,
          );
          const message = winner
            ? `${winner.displayName} wins!`
            : "Match complete!";
          showOverlay(`${message}\nPress restart to play again.`);
          break;
        case "matchRestarted":
          hideOverlay();
          setStatus("New match starting!");
          activeKeyDirections.clear();
          setPendingDirection("none");
          lastDirectionSent = "none";
          serverState = createEmptyState();
          myLocalLeader = {
            x: canvasWidth / 2,
            y: canvasHeight / 2,
            vx: 0,
            vy: 0,
          };
          interpolatedEntities.clear();
          break;
        case "pong":
          if (payload.ts) {
            const rtt = (performance.now() - payload.ts) / 1000;
            currentLatency = lerp(currentLatency, rtt, 0.2);
          }
          break;
        default:
          break;
      }
    });

    socket.addEventListener("close", () => {
      setStatus("Connection closed. Reconnecting…");
      serverState = createEmptyState();
      activeKeyDirections.clear();
      setPendingDirection("none");
      lastDirectionSent = "none";

      const delay = Math.min(2000, 250 + reconnectAttempts * 250);
      reconnectAttempts += 1;
      setTimeout(connect, delay);
    });
  }

  function sendMessage(type, extra = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type, ...extra }));
  }

  function applyLocalCorrection(state) {
    if (!myPlayerId || !state.players) return;
    const me = state.players.find((p) => p.connectionId === myPlayerId);
    if (!me || !me.leader) return;

    const latencyComp = Math.max(0.05, currentLatency * 1.2);
    const targetX = me.leader.x + me.leader.vx * latencyComp;
    const targetY = me.leader.y + me.leader.vy * latencyComp;
    const dx = myLocalLeader.x - targetX;
    const dy = myLocalLeader.y - targetY;
    const distSq = dx * dx + dy * dy;

    const isLocallyStopped =
      localDirectionVector.x === 0 && localDirectionVector.y === 0;
    const driftThreshold = isLocallyStopped ? 10000 : 2500;

    if (distSq > 40000) {
      myLocalLeader.x = targetX;
      myLocalLeader.y = targetY;
    } else if (distSq > driftThreshold) {
      myLocalLeader.x = lerp(myLocalLeader.x, targetX, 0.02);
      myLocalLeader.y = lerp(myLocalLeader.y, targetY, 0.02);
    }
  }

  function updateStatusFromState(state) {
    if (!state) return;
    if (!state.isActive && state.players.length < 2) {
      setStatus("Waiting for opponent to join…");
    } else if (!state.isActive) {
      setStatus("Match ready. Stay sharp!");
    } else {
      setStatus("Battle in progress!");
    }
  }

  function updateLocalLeader(deltaSeconds) {
    const vx = localDirectionVector.x * LEADER_SPEED;
    const vy = localDirectionVector.y * LEADER_SPEED;

    myLocalLeader.x = clamp(
      myLocalLeader.x + vx * deltaSeconds,
      LEADER_RADIUS,
      canvasWidth - LEADER_RADIUS,
    );
    myLocalLeader.y = clamp(
      myLocalLeader.y + vy * deltaSeconds,
      LEADER_RADIUS,
      canvasHeight - LEADER_RADIUS,
    );
    myLocalLeader.vx = vx;
    myLocalLeader.vy = vy;
  }

  function updateInterpolatedState(deltaSeconds) {
    if (!serverState || !serverState.players) return;

    const activeIds = new Set();

    const processEntity = (entityData, isLocalLeader) => {
      if (!entityData || !entityData.id) return;
      const id = entityData.id;
      activeIds.add(id);

      if (isLocalLeader) return;

      let current = interpolatedEntities.get(id);
      if (!current) {
        current = { ...entityData };
        interpolatedEntities.set(id, current);
      }

      current.x += current.vx * deltaSeconds;
      current.y += current.vy * deltaSeconds;

      const lookahead = Math.min(currentLatency, 0.5);
      const targetX = entityData.x + entityData.vx * lookahead;
      const targetY = entityData.y + entityData.vy * lookahead;

      const isStopped =
        Math.abs(entityData.vx) < 0.01 && Math.abs(entityData.vy) < 0.01;

      if (isStopped) {
        current.vx = 0;
        current.vy = 0;
        current.x = lerp(current.x, targetX, 0.3);
        current.y = lerp(current.y, targetY, 0.3);
      } else {
        current.x = lerp(current.x, targetX, REMOTE_SMOOTHING);
        current.y = lerp(current.y, targetY, REMOTE_SMOOTHING);
        current.vx = lerp(current.vx, entityData.vx, REMOTE_SMOOTHING);
        current.vy = lerp(current.vy, entityData.vy, REMOTE_SMOOTHING);
      }

      current.radius = entityData.radius;
      interpolatedEntities.set(id, current);
    };

    for (const player of serverState.players) {
      processEntity(player.leader, player.connectionId === myPlayerId);
      for (const underling of player.underlings) {
        processEntity(underling, false);
      }
    }

    for (const id of interpolatedEntities.keys()) {
      if (!activeIds.has(id)) {
        interpolatedEntities.delete(id);
      }
    }
  }

  function buildRenderState() {
    if (!serverState.players || serverState.players.length === 0) {
      return serverState;
    }

    const players = serverState.players.map((player) => {
      let leader = player.leader;

      if (player.connectionId === myPlayerId) {
        leader = {
          ...player.leader,
          x: myLocalLeader.x,
          y: myLocalLeader.y,
          vx: myLocalLeader.vx,
          vy: myLocalLeader.vy,
        };
      } else {
        const interpolated = interpolatedEntities.get(player.leader.id);
        if (interpolated) leader = interpolated;
      }

      const underlings = player.underlings.map((u) => {
        return interpolatedEntities.get(u.id) || u;
      });

      return {
        ...player,
        leader,
        underlings,
      };
    });

    return {
      ...serverState,
      players,
    };
  }

  function renderScene() {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    drawGrid();

    const renderState = buildRenderState();
    drawEntities(renderState);
    drawScoreboard(renderState);
  }

  function drawGrid() {
    ctx.save();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = gridSize; x < canvasWidth; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, canvasHeight);
      ctx.stroke();
    }
    for (let y = gridSize; y < canvasHeight; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(canvasWidth, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawEntities(state) {
    if (!state || !state.players) return;

    for (const player of state.players) {
      const baseColor = player.teamColor === "red" ? "#ef4444" : "#3b82f6";
      const underlingColor = lighten(baseColor, 0.35);

      for (const underling of player.underlings) {
        drawCircle(underling.x, underling.y, underling.radius, underlingColor);
        drawEye(underling.x, underling.y, underling.radius, baseColor);
      }

      drawCircle(
        player.leader.x,
        player.leader.y,
        player.leader.radius,
        baseColor,
      );
      drawEye(
        player.leader.x,
        player.leader.y,
        player.leader.radius,
        "#ffffff",
      );
    }
  }

  function drawScoreboard(state) {
    ctx.save();
    ctx.fillStyle = "#f8fafc";
    ctx.font = "18px 'Segoe UI'";
    ctx.textBaseline = "top";

    let y = 10;
    for (const player of state.players ?? []) {
      const color = player.teamColor === "red" ? "#f87171" : "#60a5fa";
      ctx.fillStyle = color;
      const remaining = player.underlings?.length ?? 0;
      const label = `${player.displayName || player.teamColor}: ${remaining} underlings`;
      ctx.fillText(label, 12, y);
      y += 22;
    }

    ctx.restore();
  }

  function drawCircle(x, y, radius, fillStyle) {
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = fillStyle;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawEye(x, y, radius, fillStyle) {
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = fillStyle;
    ctx.arc(x, y - radius / 2.5, radius / 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function lighten(hexColor, amount) {
    const color = hexColor.replace("#", "");
    const num = parseInt(color, 16);
    const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
    const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
    const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
    return `rgb(${r}, ${g}, ${b})`;
  }

  function directionToVector(direction) {
    const key = (direction ?? "none").toLowerCase();
    switch (key) {
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

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function resolveDirectionFromKeys() {
    if (activeKeyDirections.size === 0) return "none";

    let latestTimestamp = -Infinity;
    let resolved = "none";
    for (const { direction, timestamp } of activeKeyDirections.values()) {
      if (timestamp >= latestTimestamp) {
        latestTimestamp = timestamp;
        resolved = direction;
      }
    }
    return resolved;
  }

  function setPendingDirection(direction) {
    const normalized = direction ?? "none";
    pendingDirection = normalized;
    localDirectionVector = directionToVector(normalized);
    flushDirection();
  }

  function flushDirection() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (pendingDirection === lastDirectionSent) return;

    inputsSent += 1;
    if (DEBUG_MODE) {
      console.log(
        `Input #${inputsSent}: ${pendingDirection} (was: ${lastDirectionSent})`,
      );
    }

    lastDirectionSent = pendingDirection;
    sendMessage("move", { direction: pendingDirection });
  }

  function handleKeyDown(event) {
    const direction = directionByKey[event.key];
    if (!direction) return;

    activeKeyDirections.set(event.key, {
      direction,
      timestamp: performance.now(),
    });

    event.preventDefault();

    const resolved = resolveDirectionFromKeys();
    setPendingDirection(resolved);
  }

  function handleKeyUp(event) {
    if (!directionByKey[event.key]) return;

    activeKeyDirections.delete(event.key);

    event.preventDefault();

    const resolved = resolveDirectionFromKeys();
    setPendingDirection(resolved);
  }

  function handleWindowBlur() {
    if (activeKeyDirections.size === 0 && pendingDirection === "none") return;

    activeKeyDirections.clear();
    setPendingDirection("none");
  }

  let lastInputSync = 0;

  function draw(now) {
    if (typeof now !== "number") {
      now = performance.now();
    }

    const deltaSeconds = clamp((now - lastFrame) / 1000, 0, 0.25);
    lastFrame = now;
    frameCount += 1;

    if (now - lastInputSync > 100) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        if (lastDirectionSent !== "none" || pendingDirection !== "none") {
          sendMessage("move", { direction: pendingDirection });
        }
      }
      lastInputSync = now;
    }

    if (now - lastPingTime > 2000) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendMessage("ping", { ts: performance.now() });
      }
      lastPingTime = now;
    }

    updateLocalLeader(deltaSeconds);
    updateInterpolatedState(deltaSeconds);

    if (DEBUG_MODE && now - lastDebugLog > 3000) {
      const fps = Math.round(frameCount / 3);
      const updatesPerSec = Math.round(serverUpdateCount / 3);
      console.log(
        `FPS: ${fps} | Server updates/sec: ${updatesPerSec} | Active keys: ${activeKeyDirections.size} | Current direction: ${pendingDirection}`,
      );
      frameCount = 0;
      serverUpdateCount = 0;
      lastDebugLog = now;
    }

    renderScene();
    requestAnimationFrame(draw);
  }

  createBtn.addEventListener("click", async () => {
    hideOverlay();
    setStatus("Creating room…");
    sendMessage("createGame", { displayName: displayNameInput.value.trim() });
  });

  joinBtn.addEventListener("click", async () => {
    if (!roomCodeInput.value) {
      setStatus("Enter a room code to join.");
      return;
    }
    hideOverlay();
    const code = roomCodeInput.value.trim().toUpperCase();
    setStatus(`Joining ${code}…`);
    sendMessage("joinGame", {
      roomId: code,
      displayName: displayNameInput.value.trim(),
    });
  });

  restartBtn.addEventListener("click", async () => {
    hideOverlay();
    if (!roomId) return;
    sendMessage("restartGame");
  });

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", handleWindowBlur);

  requestAnimationFrame(draw);
  connect();
})();
