(() => {
  // Simplified constants - no complex prediction
  const LEADER_SPEED = 160;
  const LEADER_RADIUS = 18;
  const REMOTE_SMOOTHING = 0.15; // Simple lerp factor for remote entities
  const DEBUG_MODE = true; // Set to false to disable logging

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

  let connection;
  let roomId = null;
  let myPlayerId = null;
  let lastDirectionSent = "none";
  let pendingDirection = "none";
  let lastFrame = performance.now();

  // Simplified state: just latest from server + local leader override
  let serverState = createEmptyState();
  let myLocalLeader = { x: canvasWidth / 2, y: canvasHeight / 2, vx: 0, vy: 0 };
  let localDirectionVector = { x: 0, y: 0 };
  const activeKeyDirections = new Map();
  const interpolatedEntities = new Map(); // Stores smooth state for remote entities

  // Debug tracking
  let frameCount = 0;
  let lastDebugLog = performance.now();
  let serverUpdateCount = 0;
  let inputsSent = 0;
  let currentLatency = 0.1; // Default to 100ms
  let lastPingTime = 0;

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

  async function startConnection() {
    connection = new signalR.HubConnectionBuilder()
      .withUrl("/gamehub", { transport: signalR.HttpTransportType.WebSockets })
      .withAutomaticReconnect()
      .build();

    registerHandlers();

    connection.onreconnecting(() => {
      setStatus("Reconnecting…");
      lastDirectionSent = "none";
    });

    connection.onreconnected(() => {
      setStatus("Reconnected. Syncing state…");
      lastDirectionSent = "none";
      flushDirection();
      if (roomId) {
        connection.invoke("RequestState").catch(console.error);
      }
    });

    connection.onclose(() => {
      setStatus("Connection closed. Refresh to retry.");
      serverState = createEmptyState();
      activeKeyDirections.clear();
      setPendingDirection("none");
      lastDirectionSent = "none";
    });

    await connection.start();
    setStatus("Connected. Create or join a game.");
    flushDirection();

    const queryCode = new URLSearchParams(window.location.search).get("code");
    if (queryCode) {
      roomCodeInput.value = queryCode.toUpperCase();
      joinBtn.click();
    }
  }

  function registerHandlers() {
    connection.on("GameCreated", (payload) => {
      roomId = payload.roomId;
      myPlayerId = payload.player.playerId;
      serverState = createEmptyState();
      setStatus("Room created. Waiting for an opponent…");
      setInviteLink(roomId);
      hideOverlay();
    });

    connection.on("JoinedGame", (payload) => {
      roomId = payload.roomId;
      myPlayerId = payload.player?.playerId ?? myPlayerId;
      serverState = createEmptyState();
      setStatus("Joined game. Waiting for opponent…");
      setInviteLink(roomId);
      hideOverlay();
      connection.invoke("RequestState").catch(console.error);
    });

    connection.on("JoinFailed", (payload) => {
      setStatus(`Join failed: ${payload.error}`);
    });

    connection.on("PlayerJoined", (payload) => {
      const count = payload.players.length;
      if (count < 2) {
        setStatus("Waiting for opponent to join…");
      } else {
        setStatus("Opponent connected! Get ready.");
      }
    });

    connection.on("GameStateUpdated", (payload) => {
      serverState = payload;
      roomId = payload.roomId;
      serverUpdateCount++;

      // Sync local leader position from server periodically (soft correction)
      if (myPlayerId && payload.players) {
        const me = payload.players.find((p) => p.connectionId === myPlayerId);
        if (me && me.leader) {
          // Project server position forward by current latency (RTT)
          // This dynamically adjusts to network conditions
          // We add a small buffer (1.2x) to be safe
          const latencyComp = Math.max(0.05, currentLatency * 1.2);
          const targetX = me.leader.x + me.leader.vx * latencyComp;
          const targetY = me.leader.y + me.leader.vy * latencyComp;
          const dx = myLocalLeader.x - targetX;
          const dy = myLocalLeader.y - targetY;
          const distSq = dx * dx + dy * dy;

          if (DEBUG_MODE && distSq > 100) {
            console.log(`Drift: ${Math.sqrt(distSq).toFixed(1)}px`);
          }

          // If we are stopped locally, we trust our position more to prevent "sliding"
          // when the server catches up to our stop command.
          const isLocallyStopped =
            localDirectionVector.x === 0 && localDirectionVector.y === 0;
          const driftThreshold = isLocallyStopped ? 10000 : 2500; // 100px vs 50px squared

          if (distSq > 40000) {
            // Hard snap if > 200px off (Massive desync only)
            if (DEBUG_MODE) console.warn("Hard snap correction!");
            myLocalLeader.x = targetX;
            myLocalLeader.y = targetY;
          } else if (distSq > driftThreshold) {
            // Gentle correction only if drift is significant
            // Very soft pull (0.02) to avoid "choppy" feeling
            myLocalLeader.x = lerp(myLocalLeader.x, targetX, 0.02);
            myLocalLeader.y = lerp(myLocalLeader.y, targetY, 0.02);
          }
        }
      }

      // maybeAssignPlayerId(payload); // REMOVED: Caused race condition where Red player attached to Blue
      updateStatusFromState(payload);
    });
    connection.on("GameOver", (payload) => {
      if (!payload || !payload.winnerId) {
        return;
      }
      const winner = serverState.players.find(
        (p) => p.connectionId === payload.winnerId
      );
      const message = winner
        ? `${winner.displayName} wins!`
        : "Match complete!";
      showOverlay(`${message}\nPress restart to play again.`);
    });

    connection.on("MatchRestarted", () => {
      hideOverlay();
      setStatus("New match starting!");
      activeKeyDirections.clear();
      setPendingDirection("none");
      lastDirectionSent = "none";
      serverState = createEmptyState();
      myLocalLeader = { x: canvasWidth / 2, y: canvasHeight / 2, vx: 0, vy: 0 };
      interpolatedEntities.clear();
    });
  }

  // REMOVED: maybeAssignPlayerId was causing players to attach to the wrong entity
  // if the GameStateUpdated event arrived before JoinedGame.

  function updateStatusFromState(state) {
    if (!state) {
      return;
    }
    if (!state.isActive && state.players.length < 2) {
      setStatus("Waiting for opponent to join…");
    } else if (!state.isActive) {
      setStatus("Match ready. Stay sharp!");
    } else {
      setStatus("Battle in progress!");
    }
  }

  function updateLocalLeader(deltaSeconds) {
    // Move local leader instantly based on input
    const vx = localDirectionVector.x * LEADER_SPEED;
    const vy = localDirectionVector.y * LEADER_SPEED;

    myLocalLeader.x = clamp(
      myLocalLeader.x + vx * deltaSeconds,
      LEADER_RADIUS,
      canvasWidth - LEADER_RADIUS
    );
    myLocalLeader.y = clamp(
      myLocalLeader.y + vy * deltaSeconds,
      LEADER_RADIUS,
      canvasHeight - LEADER_RADIUS
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
        // New entity, snap to position
        current = { ...entityData };
        interpolatedEntities.set(id, current);
      }

      // Predict movement based on current velocity
      current.x += current.vx * deltaSeconds;
      current.y += current.vy * deltaSeconds;

      // Calculate target position with latency compensation
      // We assume the server snapshot is 'currentLatency' old.
      // We want to render where the entity is NOW.
      const lookahead = Math.min(currentLatency, 0.5);
      const targetX = entityData.x + entityData.vx * lookahead;
      const targetY = entityData.y + entityData.vy * lookahead;

      // Smoothly pull towards the target
      const smoothFactor = 0.15;

      // If server says stopped, stop prediction immediately to prevent overshoot
      const isStopped =
        Math.abs(entityData.vx) < 0.01 && Math.abs(entityData.vy) < 0.01;

      if (isStopped) {
        // Stop prediction immediately
        current.vx = 0;
        current.vy = 0;
        // Snap faster to target to avoid "sliding" feel
        current.x = lerp(current.x, targetX, 0.3);
        current.y = lerp(current.y, targetY, 0.3);
      } else {
        current.x = lerp(current.x, targetX, smoothFactor);
        current.y = lerp(current.y, targetY, smoothFactor);

        current.vx = lerp(current.vx, entityData.vx, smoothFactor);
        current.vy = lerp(current.vy, entityData.vy, smoothFactor);
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

    // Cleanup dead entities
    for (const id of interpolatedEntities.keys()) {
      if (!activeIds.has(id)) {
        interpolatedEntities.delete(id);
      }
    }
  }

  function buildRenderState() {
    // Build render state: use server state but override with interpolated positions
    if (!serverState.players || serverState.players.length === 0) {
      return serverState;
    }

    const players = serverState.players.map((player) => {
      let leader = player.leader;

      if (player.connectionId === myPlayerId) {
        // Use my local leader position
        leader = {
          ...player.leader,
          x: myLocalLeader.x,
          y: myLocalLeader.y,
          vx: myLocalLeader.vx,
          vy: myLocalLeader.vy,
        };
      } else {
        // Use interpolated remote leader
        const interpolated = interpolatedEntities.get(player.leader.id);
        if (interpolated) leader = interpolated;
      }

      // Use interpolated underlings
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
    if (!state || !state.players) {
      return;
    }

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
        baseColor
      );
      drawEye(
        player.leader.x,
        player.leader.y,
        player.leader.radius,
        "#ffffff"
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
      const label = `${
        player.displayName || player.teamColor
      }: ${remaining} underlings`;
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
    if (activeKeyDirections.size === 0) {
      return "none";
    }

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
    if (
      !connection ||
      connection.state !== signalR.HubConnectionState.Connected
    ) {
      return;
    }

    if (pendingDirection === lastDirectionSent) {
      return;
    }

    inputsSent++;
    if (DEBUG_MODE) {
      console.log(
        `Input #${inputsSent}: ${pendingDirection} (was: ${lastDirectionSent})`
      );
    }

    // Update immediately to prevent race conditions where rapid inputs
    // (like press-release) are ignored because the previous promise hasn't resolved.
    lastDirectionSent = pendingDirection;

    connection.invoke("Move", pendingDirection).catch((err) => {
      console.error("Move failed:", err);
      // Reset lastDirectionSent so we retry on next flush
      lastDirectionSent = "retry";
    });
  }

  function handleKeyDown(event) {
    const direction = directionByKey[event.key];
    if (!direction) {
      return;
    }

    activeKeyDirections.set(event.key, {
      direction,
      timestamp: performance.now(),
    });

    event.preventDefault();

    const resolved = resolveDirectionFromKeys();
    setPendingDirection(resolved);
  }

  function handleKeyUp(event) {
    if (!directionByKey[event.key]) {
      return;
    }

    activeKeyDirections.delete(event.key);

    event.preventDefault();

    const resolved = resolveDirectionFromKeys();
    setPendingDirection(resolved);
  }

  function handleWindowBlur() {
    if (activeKeyDirections.size === 0 && pendingDirection === "none") {
      return;
    }

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
    frameCount++;

    // Periodic input sync (every 100ms) to ensure server is in sync
    // This acts like a UDP heartbeat, ensuring the server knows our intent even if packets drop
    if (now - lastInputSync > 100) {
      if (
        connection &&
        connection.state === signalR.HubConnectionState.Connected
      ) {
        // Force resend if we are moving, or just to be safe
        if (lastDirectionSent !== "none" || pendingDirection !== "none") {
          connection.invoke("Move", pendingDirection).catch(() => {});
        }
      }
      lastInputSync = now;
    }

    // Measure Latency every 2 seconds
    if (now - lastPingTime > 2000) {
      if (
        connection &&
        connection.state === signalR.HubConnectionState.Connected
      ) {
        const start = performance.now();
        connection
          .invoke("Ping")
          .then(() => {
            const rtt = (performance.now() - start) / 1000; // Seconds
            // Smooth the latency value
            currentLatency = lerp(currentLatency, rtt, 0.2);
            if (DEBUG_MODE && Math.random() < 0.1)
              console.log(`Latency: ${(currentLatency * 1000).toFixed(0)}ms`);
          })
          .catch(() => {});
      }
      lastPingTime = now;
    }

    // Update only MY leader locally
    updateLocalLeader(deltaSeconds);

    // Extrapolate remote entities for smoothness
    updateInterpolatedState(deltaSeconds);

    // Debug logging every 3 seconds
    if (DEBUG_MODE && now - lastDebugLog > 3000) {
      const fps = Math.round(frameCount / 3);
      const updatesPerSec = Math.round(serverUpdateCount / 3);
      console.log(
        `FPS: ${fps} | Server updates/sec: ${updatesPerSec} | Active keys: ${activeKeyDirections.size} | Current direction: ${pendingDirection}`
      );
      frameCount = 0;
      serverUpdateCount = 0;
      lastDebugLog = now;
    }

    // Render everything
    renderScene();
    requestAnimationFrame(draw);
  }
  createBtn.addEventListener("click", async () => {
    hideOverlay();
    setStatus("Creating room…");
    try {
      await connection.invoke("CreateGame", displayNameInput.value.trim());
    } catch (err) {
      console.error(err);
      setStatus("Failed to create game.");
    }
  });

  joinBtn.addEventListener("click", async () => {
    if (!roomCodeInput.value) {
      setStatus("Enter a room code to join.");
      return;
    }
    hideOverlay();
    const code = roomCodeInput.value.trim().toUpperCase();
    setStatus(`Joining ${code}…`);
    try {
      await connection.invoke("JoinGame", code, displayNameInput.value.trim());
    } catch (err) {
      console.error(err);
      setStatus("Failed to join game.");
    }
  });

  restartBtn.addEventListener("click", async () => {
    hideOverlay();
    if (!roomId) {
      return;
    }
    try {
      await connection.invoke("RestartGame");
    } catch (err) {
      console.error(err);
    }
  });

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", handleWindowBlur);

  requestAnimationFrame(draw);
  startConnection().catch((err) => {
    console.error(err);
    setStatus("Unable to connect to server.");
  });
})();
