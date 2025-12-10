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

  // Debug tracking
  let frameCount = 0;
  let lastDebugLog = performance.now();
  let serverUpdateCount = 0;
  let inputsSent = 0;

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
          // Gentle correction: only if we drift too far (> 50px)
          const dx = myLocalLeader.x - me.leader.x;
          const dy = myLocalLeader.y - me.leader.y;
          const distSq = dx * dx + dy * dy;

          if (DEBUG_MODE && distSq > 100) {
            console.log(
              `Drift: ${Math.sqrt(distSq).toFixed(
                1
              )}px, Local:(${myLocalLeader.x.toFixed(
                0
              )},${myLocalLeader.y.toFixed(0)}) Server:(${me.leader.x.toFixed(
                0
              )},${me.leader.y.toFixed(0)})`
            );
          }

          if (distSq > 2500) {
            // Hard snap if > 50px off
            if (DEBUG_MODE) console.warn("Hard snap correction!");
            myLocalLeader.x = me.leader.x;
            myLocalLeader.y = me.leader.y;
          } else if (distSq > 400) {
            // Gentle correction only if drift > 20px
            // This prevents fighting against latency for small drifts
            myLocalLeader.x = lerp(myLocalLeader.x, me.leader.x, 0.1);
            myLocalLeader.y = lerp(myLocalLeader.y, me.leader.y, 0.1);
          }
        }
      }

      maybeAssignPlayerId(payload);
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
    });
  }

  function maybeAssignPlayerId(state) {
    if (myPlayerId) {
      return;
    }
    const me = state.players.find((p) => p.teamColor === "blue");
    if (me) {
      myPlayerId = me.connectionId;
    }
  }

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

  function buildRenderState() {
    // Build render state: use server state but override my leader
    if (!serverState.players || serverState.players.length === 0) {
      return serverState;
    }

    const players = serverState.players.map((player) => {
      if (player.connectionId === myPlayerId) {
        // Use my local leader position
        return {
          ...player,
          leader: {
            ...player.leader,
            x: myLocalLeader.x,
            y: myLocalLeader.y,
            vx: myLocalLeader.vx,
            vy: myLocalLeader.vy,
          },
        };
      }
      // Remote players: use server data directly (already smooth from 30ms ticks)
      return player;
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

  function draw(now) {
    if (typeof now !== "number") {
      now = performance.now();
    }

    const deltaSeconds = clamp((now - lastFrame) / 1000, 0, 0.25);
    lastFrame = now;
    frameCount++;

    // Update only MY leader locally
    updateLocalLeader(deltaSeconds);

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
