(() => {
  // Simplified constants - no complex prediction
  const LEADER_SPEED = 160;
  const LEADER_RADIUS = 18;
  const BASE_INTERPOLATION_DELAY_MS = 100;
  const MIN_INTERPOLATION_DELAY_MS = 70;
  const MAX_INTERPOLATION_DELAY_MS = 220;
  const SNAPSHOT_RETENTION_MS = 1200;
  const MAX_STATE_BUFFER = 80;
  const MAX_RECONCILE_STEP_PX = 7;
  const DEBUG_MODE = true; // Set to false to disable logging

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const overlayEl = document.getElementById("overlay");
  const overlayMessageEl = document.getElementById("overlayMessage");
  const restartBtn = document.getElementById("restartBtn");
  const displayNameInput = document.getElementById("displayName");
  const roomCodeInput = document.getElementById("roomCode");
  const createBtn = document.getElementById("createBtn");
  const joinBtn = document.getElementById("joinBtn");
  const inviteSection = document.getElementById("inviteSection");
  const inviteLinkInput = document.getElementById("inviteLinkInput");
  const copyInviteBtn = document.getElementById("copyInviteBtn");
  const howToPlayBtn = document.getElementById("howToPlayBtn");
  const rulesModal = document.getElementById("rulesModal");
  const closeRulesBtn = document.getElementById("closeRulesBtn");
  const mobileControls = document.getElementById("mobileControls");

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
  const stateBuffer = []; // Ordered snapshots for jitter-resistant interpolation
  let serverClockOffsetMs = null;
  let currentInterpolationDelayMs = BASE_INTERPOLATION_DELAY_MS;
  let lastAcceptedSnapshotId = 0;
  const recentSnapshotIntervals = [];

  // Debug tracking
  let frameCount = 0;
  let lastDebugLog = performance.now();
  let serverUpdateCount = 0;
  let inputsSent = 0;
  let currentLatency = 0.1; // Default to 100ms
  let lastPingTime = 0;
  let correctionCount = 0;
  let hardSnapCount = 0;
  let snapshotJitterMs = 0;
  let lastSnapshotServerTime = null;
  let staleSnapshotDrops = 0;

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
      if (inviteSection) inviteSection.style.display = "none";
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("code", code);
    if (inviteLinkInput) inviteLinkInput.value = url.toString();
    if (inviteSection) inviteSection.style.display = "flex";
    roomCodeInput.value = code;
  }

  function showOverlay(content, isHtml = false) {
    if (isHtml) {
      overlayMessageEl.innerHTML = content;
    } else {
      overlayMessageEl.textContent = content;
    }
    overlayEl.classList.remove("hidden");
  }

  function hideOverlay() {
    overlayEl.classList.add("hidden");
  }

  function resetSnapshotPipeline() {
    stateBuffer.length = 0;
    recentSnapshotIntervals.length = 0;
    serverClockOffsetMs = null;
    currentInterpolationDelayMs = BASE_INTERPOLATION_DELAY_MS;
    lastAcceptedSnapshotId = 0;
    snapshotJitterMs = 0;
    lastSnapshotServerTime = null;
    staleSnapshotDrops = 0;
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
      resetSnapshotPipeline();
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
      resetSnapshotPipeline();
      roomId = payload.roomId;
      myPlayerId = payload.player.playerId;
      serverState = createEmptyState();
      setStatus("Room created. Waiting for an opponent…");
      setInviteLink(roomId);
      hideOverlay();
    });

    connection.on("JoinedGame", (payload) => {
      resetSnapshotPipeline();
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
      if (serverState.winnerId) {
        return;
      }

      if (roomId && payload.roomId && payload.roomId !== roomId) {
        resetSnapshotPipeline();
      }

      if (typeof payload.snapshotId === "number") {
        if (payload.snapshotId <= lastAcceptedSnapshotId) {
          staleSnapshotDrops++;
          return;
        }
        lastAcceptedSnapshotId = payload.snapshotId;
      }

      serverState = payload;
      pushStateSnapshot(payload);
      roomId = payload.roomId;
      serverUpdateCount++;

      // Sync local leader position from server periodically (soft correction)
      if (myPlayerId && payload.players) {
        const me = payload.players.find((p) => p.connectionId === myPlayerId);
        if (me && me.leader) {
          // Keep local control immediate and reconcile toward authoritative state.
          const targetX = me.leader.x;
          const targetY = me.leader.y;
          const dx = myLocalLeader.x - targetX;
          const dy = myLocalLeader.y - targetY;
          const distSq = dx * dx + dy * dy;

          if (DEBUG_MODE && distSq > 100) {
            console.log(`Drift: ${Math.sqrt(distSq).toFixed(1)}px`);
          }

          // If we are stopped locally, trust local position to avoid visible post-stop pulls.
          const isLocallyStopped =
            localDirectionVector.x === 0 && localDirectionVector.y === 0;
          const driftThreshold = isLocallyStopped ? 12100 : 6400; // 110px vs 80px squared

          if (distSq > 48400) {
            // Hard snap only when severely desynced.
            if (DEBUG_MODE) console.warn("Hard snap correction!");
            myLocalLeader.x = targetX;
            myLocalLeader.y = targetY;
            hardSnapCount++;
          } else if (distSq > driftThreshold) {
            // Bounded correction avoids visible rubber-band spikes on bursty updates.
            const dist = Math.sqrt(distSq);
            const step = Math.min(MAX_RECONCILE_STEP_PX, dist);
            const correction = step / Math.max(1, dist);
            myLocalLeader.x = lerp(myLocalLeader.x, targetX, correction);
            myLocalLeader.y = lerp(myLocalLeader.y, targetY, correction);
            correctionCount++;
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
        (p) => p.connectionId === payload.winnerId,
      );

      // Ensure state reflects game over so movement stops
      serverState.winnerId = payload.winnerId;

      const winnerName = winner
        ? winner.displayName || winner.teamColor
        : "Unknown";
      setStatus(`Game Over! Winner: ${winnerName}`);
      const winnerColor = winner
        ? winner.teamColor === "red"
          ? "#ff6b6b"
          : "#4ecdc4"
        : "#ffffff";
      const titleText = winner ? "VICTORY!" : "GAME OVER";

      const html = `
        <div style="text-align: center;">
            <h1 class="victory-title" style="--winner-color: ${winnerColor};" data-text="${titleText}">
                ${titleText}
            </h1>
            <p style="font-size: 1.5rem; color: #cbd5e1; margin: 0;">
                ${winner ? `<strong style="color:${winnerColor}; text-shadow: 0 0 10px ${winnerColor};">${winnerName}</strong> devoured the swarm!` : "Match complete!"}
            </p>
        </div>
      `;

      showOverlay(html, true);
    });

    connection.on("MatchRestarted", () => {
      hideOverlay();
      setStatus("New match starting!");
      activeKeyDirections.clear();
      setPendingDirection("none");
      lastDirectionSent = "none";
      serverState = createEmptyState();
      myLocalLeader = { x: canvasWidth / 2, y: canvasHeight / 2, vx: 0, vy: 0 };
      resetSnapshotPipeline();
      correctionCount = 0;
      hardSnapCount = 0;
    });
  }

  function percentile(values, p) {
    if (!values || values.length === 0) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((sorted.length - 1) * p)),
    );
    return sorted[index];
  }

  function updateAdaptiveInterpolationDelay(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    recentSnapshotIntervals.push(intervalMs);
    if (recentSnapshotIntervals.length > 30) {
      recentSnapshotIntervals.shift();
    }

    const p95 = percentile(recentSnapshotIntervals, 0.95);
    const targetDelay = clamp(
      p95 + 15,
      MIN_INTERPOLATION_DELAY_MS,
      MAX_INTERPOLATION_DELAY_MS,
    );
    currentInterpolationDelayMs = lerp(
      currentInterpolationDelayMs,
      targetDelay,
      0.12,
    );
  }

  function pushStateSnapshot(state) {
    const clientNow = Date.now();
    const hasServerTime = typeof state.serverTime === "number";

    if (hasServerTime) {
      const measuredOffset = clientNow - state.serverTime;
      serverClockOffsetMs =
        serverClockOffsetMs === null
          ? measuredOffset
          : lerp(serverClockOffsetMs, measuredOffset, 0.1);
    }

    const estimatedServerTime = hasServerTime
      ? state.serverTime
      : clientNow - (serverClockOffsetMs ?? currentLatency * 1000);

    if (lastSnapshotServerTime !== null) {
      const interval = Math.max(
        1,
        estimatedServerTime - lastSnapshotServerTime,
      );
      const jitterSample = Math.abs(interval - 30);
      snapshotJitterMs = lerp(snapshotJitterMs, jitterSample, 0.15);
      updateAdaptiveInterpolationDelay(interval);
    }
    lastSnapshotServerTime = estimatedServerTime;

    stateBuffer.push({
      state,
      serverTime: estimatedServerTime,
      clientReceivedAt: clientNow,
    });

    if (stateBuffer.length > MAX_STATE_BUFFER) {
      stateBuffer.shift();
    }

    const cutoff = clientNow - SNAPSHOT_RETENTION_MS;
    while (stateBuffer.length > 2 && stateBuffer[1].clientReceivedAt < cutoff) {
      stateBuffer.shift();
    }
  }

  function getBufferedStateForRender() {
    if (stateBuffer.length === 0) {
      return serverState;
    }

    if (stateBuffer.length === 1) {
      return stateBuffer[0].state;
    }

    const clockOffset = serverClockOffsetMs ?? currentLatency * 1000;
    const estimatedServerNow = Date.now() - clockOffset;
    const renderServerTime = estimatedServerNow - currentInterpolationDelayMs;

    let newerIndex = -1;
    for (let i = 0; i < stateBuffer.length; i++) {
      if (stateBuffer[i].serverTime >= renderServerTime) {
        newerIndex = i;
        break;
      }
    }

    if (newerIndex <= 0) {
      return stateBuffer[0].state;
    }

    if (newerIndex === -1) {
      const older = stateBuffer[stateBuffer.length - 2];
      const newer = stateBuffer[stateBuffer.length - 1];
      const span = Math.max(1, newer.serverTime - older.serverTime);
      const rawT = (renderServerTime - older.serverTime) / span;
      return interpolateState(older.state, newer.state, clamp(rawT, 0, 1));
    }

    const older = stateBuffer[newerIndex - 1];
    const newer = stateBuffer[newerIndex];
    const span = Math.max(1, newer.serverTime - older.serverTime);
    const t = clamp((renderServerTime - older.serverTime) / span, 0, 1);
    return interpolateState(older.state, newer.state, t);
  }

  function interpolateState(olderState, newerState, t) {
    const olderPlayers = new Map(
      (olderState.players ?? []).map((p) => [p.connectionId, p]),
    );

    const players = (newerState.players ?? []).map((newerPlayer) => {
      const olderPlayer = olderPlayers.get(newerPlayer.connectionId);

      const leader = olderPlayer
        ? interpolateEntity(olderPlayer.leader, newerPlayer.leader, t)
        : newerPlayer.leader;

      const olderUnderlings = new Map(
        (olderPlayer?.underlings ?? []).map((u) => [u.id, u]),
      );

      const underlings = (newerPlayer.underlings ?? []).map((underling) => {
        const old = olderUnderlings.get(underling.id);
        return old ? interpolateEntity(old, underling, t) : underling;
      });

      return {
        ...newerPlayer,
        leader,
        underlings,
      };
    });

    return {
      ...newerState,
      players,
    };
  }

  function interpolateEntity(olderEntity, newerEntity, t) {
    if (!olderEntity || !newerEntity) {
      return newerEntity ?? olderEntity;
    }

    const radius = lerp(olderEntity.radius, newerEntity.radius, t);
    const x = clamp(
      lerp(olderEntity.x, newerEntity.x, t),
      radius,
      canvasWidth - radius,
    );
    const y = clamp(
      lerp(olderEntity.y, newerEntity.y, t),
      radius,
      canvasHeight - radius,
    );

    return {
      ...newerEntity,
      x,
      y,
      vx: lerp(olderEntity.vx, newerEntity.vx, t),
      vy: lerp(olderEntity.vy, newerEntity.vy, t),
      radius,
    };
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

  function buildRenderState(baseState) {
    // Build render state: use interpolated snapshot and override local leader.
    if (!baseState.players || baseState.players.length === 0) {
      return baseState;
    }

    // Never render entities that no longer exist in the newest authoritative state.
    const latestPlayersById = new Map(
      (serverState.players ?? []).map((p) => [p.connectionId, p]),
    );

    const players = baseState.players.map((player) => {
      let leader = player.leader;
      const latestPlayer = latestPlayersById.get(player.connectionId);

      if (player.connectionId === myPlayerId) {
        // Use my local leader position
        leader = {
          ...player.leader,
          x: myLocalLeader.x,
          y: myLocalLeader.y,
          vx: myLocalLeader.vx,
          vy: myLocalLeader.vy,
        };
      }

      const allowedUnderlingIds = new Set(
        (latestPlayer?.underlings ?? []).map((u) => u.id),
      );
      const underlings = (player.underlings ?? []).filter((u) =>
        allowedUnderlingIds.has(u.id),
      );

      return {
        ...player,
        leader,
        underlings,
      };
    });

    return {
      ...baseState,
      players,
    };
  }

  function renderScene() {
    drawGrid();

    const bufferedState = getBufferedStateForRender();
    const renderState = buildRenderState(bufferedState);
    drawEntities(renderState);
    drawScoreboard(renderState);
  }

  function drawGrid() {
    ctx.save();
    // Dark Arcade Background
    ctx.fillStyle = "#0f172a"; // Slate 900
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)"; // Very faint white lines
    ctx.lineWidth = 2;
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

    // Bouncy wobble animation
    const time = performance.now();

    for (const player of state.players) {
      // Vibrant Pastel Colors
      const baseColor = player.teamColor === "red" ? "#f43f5e" : "#22d3ee"; // Rose 500 / Cyan 400
      const underlingColor = player.teamColor === "red" ? "#fb7185" : "#67e8f9";

      for (const underling of player.underlings) {
        // Underlings
        drawCircle(
          underling.x,
          underling.y,
          underling.radius,
          underlingColor,
          false, // No wobble for small ones
        );
      }

      // Leaders get a wobble effect
      const wobble = Math.sin(time / 150) * 2;

      drawCircle(
        player.leader.x,
        player.leader.y,
        player.leader.radius + wobble,
        baseColor,
        true,
      );
      drawEye(
        player.leader.x,
        player.leader.y,
        player.leader.radius + wobble,
        "#ffffff",
      );
    }
  }

  function drawScoreboard(state) {
    ctx.save();

    // Sticker/Card style HUD
    ctx.fillStyle = "rgba(30, 41, 59, 0.9)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;

    const panelHeight = 20 + (state.players?.length || 0) * 30;

    // Draw box with shadow
    ctx.shadowColor = "rgba(0,0,0,0.2)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 5;
    ctx.fillRect(10, 10, 260, panelHeight);

    ctx.shadowColor = "transparent"; // Reset shadow for stroke
    ctx.strokeRect(10, 10, 260, panelHeight);

    ctx.font = "bold 16px 'Fredoka', sans-serif";
    ctx.textBaseline = "top";

    let y = 25;
    for (const player of state.players ?? []) {
      const color = player.teamColor === "red" ? "#f43f5e" : "#22d3ee";
      ctx.fillStyle = color;
      const remaining = player.underlings?.length ?? 0;
      const name = player.displayName || player.teamColor;

      // Clean text
      ctx.fillText(`${name}: ${remaining}`, 25, y);

      y += 30;
    }

    ctx.restore();
  }

  function drawCircle(x, y, radius, color, isLeader = false) {
    ctx.save();
    ctx.beginPath();

    // Flat color with thick outline (Sticker style)
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = isLeader ? 4 : 2;

    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  function drawEye(x, y, radius, fillStyle) {
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = fillStyle;
    // Bigger, cuter eyes
    ctx.arc(x, y - radius / 3, radius / 3, 0, Math.PI * 2);
    ctx.fill();

    // Pupil
    ctx.beginPath();
    ctx.fillStyle = "#000";
    ctx.arc(x, y - radius / 3, radius / 8, 0, Math.PI * 2);
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
      connection.state !== signalR.HubConnectionState.Connected ||
      serverState.winnerId
    ) {
      return;
    }

    if (pendingDirection === lastDirectionSent) {
      return;
    }

    inputsSent++;
    if (DEBUG_MODE) {
      console.log(
        `Input #${inputsSent}: ${pendingDirection} (was: ${lastDirectionSent})`,
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
    if (!serverState.winnerId) {
      updateLocalLeader(deltaSeconds);
    }

    // Debug logging every 3 seconds
    if (DEBUG_MODE && now - lastDebugLog > 3000) {
      const fps = Math.round(frameCount / 3);
      const updatesPerSec = Math.round(serverUpdateCount / 3);
      console.log(
        `FPS: ${fps} | Server updates/sec: ${updatesPerSec} | Delay: ${currentInterpolationDelayMs.toFixed(0)}ms | Buffer: ${stateBuffer.length} | Jitter: ${snapshotJitterMs.toFixed(1)}ms | Soft corrections: ${correctionCount} | Hard snaps: ${hardSnapCount} | Stale drops: ${staleSnapshotDrops} | Active keys: ${activeKeyDirections.size} | Current direction: ${pendingDirection}`,
      );
      frameCount = 0;
      serverUpdateCount = 0;
      correctionCount = 0;
      hardSnapCount = 0;
      staleSnapshotDrops = 0;
      lastDebugLog = now;
    }

    // Render everything
    renderScene();
    requestAnimationFrame(draw);
  }

  if (copyInviteBtn && inviteLinkInput) {
    copyInviteBtn.addEventListener("click", () => {
      inviteLinkInput.select();
      navigator.clipboard.writeText(inviteLinkInput.value).then(() => {
        const originalText = copyInviteBtn.textContent;
        copyInviteBtn.textContent = "Copied!";
        setTimeout(() => (copyInviteBtn.textContent = originalText), 2000);
      });
    });
  }

  if (howToPlayBtn && rulesModal && closeRulesBtn) {
    howToPlayBtn.addEventListener("click", () => {
      rulesModal.classList.add("open");
    });
    const closeModal = () => rulesModal.classList.remove("open");
    closeRulesBtn.addEventListener("click", closeModal);
    rulesModal.addEventListener("click", (e) => {
      if (e.target === rulesModal) {
        closeModal();
      }
    });
  }

  // Mobile Controls Logic
  if (mobileControls) {
    const dpadButtons = mobileControls.querySelectorAll(".dpad-btn");

    dpadButtons.forEach((btn) => {
      const direction = btn.getAttribute("data-dir");
      const keyId = `Mobile${direction}`; // Unique ID for the map

      const handlePress = (e) => {
        e.preventDefault(); // Prevent mouse emulation/scrolling
        btn.classList.add("active");
        activeKeyDirections.set(keyId, {
          direction: direction,
          timestamp: performance.now(),
        });
        setPendingDirection(resolveDirectionFromKeys());
      };

      const handleRelease = (e) => {
        e.preventDefault();
        btn.classList.remove("active");
        activeKeyDirections.delete(keyId);
        setPendingDirection(resolveDirectionFromKeys());
      };

      btn.addEventListener("pointerdown", handlePress);
      btn.addEventListener("pointerup", handleRelease);
      btn.addEventListener("pointerleave", handleRelease);
    });
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
