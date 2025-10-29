(() => {
  const INTERPOLATION_DELAY_MS = 60;
  const EXTRAPOLATION_LIMIT_MS = 120;
  const MAX_BUFFER_SIZE = 24;
  const DRIFT_CORRECTION_FACTOR = 0.05;
  const LEADER_SPEED = 160;
  const LEADER_RADIUS = 18;
  const SMOOTHING_STIFFNESS = 16;

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

  let latestState = null;
  let renderState = createEmptyState();
  const stateBuffer = [];
  let serverTimeOffset = null;
  let localDirectionVector = { x: 0, y: 0 };
  const activeKeyDirections = new Map();

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
      serverTime: 0,
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

  function clearStateBuffer(resetRender = false) {
    stateBuffer.length = 0;
    serverTimeOffset = null;
    if (resetRender) {
      latestState = null;
      renderState = createEmptyState();
    }
  }

  async function startConnection() {
    connection = new signalR.HubConnectionBuilder()
      .withUrl("/gamehub", { transport: signalR.HttpTransportType.WebSockets })
      .withAutomaticReconnect()
      .build();

    registerHandlers();

    connection.onreconnecting(() => {
      setStatus("Reconnecting…");
      clearStateBuffer();
      lastDirectionSent = "none";
    });

    connection.onreconnected(() => {
      setStatus("Reconnected. Syncing state…");
      clearStateBuffer();
      lastDirectionSent = "none";
      flushDirection();
      if (roomId) {
        connection.invoke("RequestState").catch(console.error);
      }
    });

    connection.onclose(() => {
      setStatus("Connection closed. Refresh to retry.");
      clearStateBuffer(true);
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
      clearStateBuffer(true);
      setStatus("Room created. Waiting for an opponent…");
      setInviteLink(roomId);
      hideOverlay();
    });

    connection.on("JoinedGame", (payload) => {
      roomId = payload.roomId;
      myPlayerId = payload.player?.playerId ?? myPlayerId;
      clearStateBuffer(true);
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
      latestState = payload;
      roomId = payload.roomId;
      bufferState(payload);
      maybeAssignPlayerId(payload);
      updateStatusFromState(payload);
    });

    connection.on("GameOver", (payload) => {
      if (!payload || !payload.winnerId) {
        return;
      }
      const source = latestState ?? renderState;
      const winner = source.players.find(
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
      clearStateBuffer();
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

  function bufferState(state) {
    if (serverTimeOffset === null) {
      serverTimeOffset = performance.now() - state.serverTime;
    } else {
      const expectedLocal = state.serverTime + serverTimeOffset;
      const drift = performance.now() - expectedLocal;
      serverTimeOffset += drift * DRIFT_CORRECTION_FACTOR;
    }

    stateBuffer.push({ time: state.serverTime, state });
    if (stateBuffer.length > MAX_BUFFER_SIZE) {
      stateBuffer.shift();
    }
  }

  function applyLocalPrediction(state, now) {
    if (!state || !myPlayerId || !Array.isArray(state.players)) {
      return state;
    }

    const index = state.players.findIndex((p) => p.connectionId === myPlayerId);
    if (index === -1) {
      return state;
    }

    const player = state.players[index];
    if (!player || !player.leader) {
      return state;
    }

    const vx = localDirectionVector.x * LEADER_SPEED;
    const vy = localDirectionVector.y * LEADER_SPEED;

    let predictedX = player.leader.x;
    let predictedY = player.leader.y;
    let changed = player.leader.vx !== vx || player.leader.vy !== vy;

    if (serverTimeOffset !== null) {
      const predictedLocalTime = state.serverTime + serverTimeOffset;
      const deltaMs = now - predictedLocalTime;
      if (deltaMs > 0 && (vx !== 0 || vy !== 0)) {
        const deltaSeconds = Math.min(deltaMs, EXTRAPOLATION_LIMIT_MS) / 1000;
        predictedX = clamp(
          predictedX + vx * deltaSeconds,
          LEADER_RADIUS,
          canvasWidth - LEADER_RADIUS
        );
        predictedY = clamp(
          predictedY + vy * deltaSeconds,
          LEADER_RADIUS,
          canvasHeight - LEADER_RADIUS
        );
        if (
          Math.abs(predictedX - player.leader.x) > 0.01 ||
          Math.abs(predictedY - player.leader.y) > 0.01
        ) {
          changed = true;
        }
      }
    }

    if (!changed) {
      return state;
    }

    const adjustedLeader = {
      ...player.leader,
      vx,
      vy,
      x: predictedX,
      y: predictedY,
    };

    const adjustedPlayers = state.players.slice();
    adjustedPlayers[index] = {
      ...player,
      leader: adjustedLeader,
    };

    return {
      ...state,
      players: adjustedPlayers,
    };
  }

  function updateRenderState(now, deltaSeconds) {
    if (stateBuffer.length === 0) {
      const target = latestState
        ? applyLocalPrediction(latestState, now)
        : applyLocalPrediction(renderState, now);
      renderState = smoothState(renderState, target, deltaSeconds);
      return;
    }

    if (serverTimeOffset === null) {
      const snapshot = stateBuffer[stateBuffer.length - 1].state;
      renderState = smoothState(
        renderState,
        applyLocalPrediction(snapshot, now),
        deltaSeconds
      );
      return;
    }

    const targetServerTime = now - serverTimeOffset - INTERPOLATION_DELAY_MS;
    while (stateBuffer.length >= 2 && stateBuffer[1].time <= targetServerTime) {
      stateBuffer.shift();
    }

    const current = stateBuffer[0];
    const next = stateBuffer[1];

    let computedState;
    if (!next) {
      const deltaMs = Math.max(0, targetServerTime - current.time);
      const clampedDelta = Math.min(deltaMs, EXTRAPOLATION_LIMIT_MS);
      computedState = extrapolateState(current.state, clampedDelta);
    } else {
      const total = next.time - current.time;
      const alpha = clamp(
        (targetServerTime - current.time) / (total || 1),
        0,
        1
      );
      computedState = interpolateState(current.state, next.state, alpha);
    }

    const predicted = applyLocalPrediction(computedState, now);
    renderState = smoothState(renderState, predicted, deltaSeconds);
  }

  function renderScene() {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    drawGrid();
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

  function interpolateState(fromState, toState, alpha) {
    const playerMap = new Map(
      toState.players.map((player) => [player.connectionId, player])
    );

    const players = fromState.players.map((player) => {
      const target = playerMap.get(player.connectionId) ?? player;
      playerMap.delete(player.connectionId);
      return interpolatePlayer(player, target, alpha);
    });

    for (const player of playerMap.values()) {
      players.push(interpolatePlayer(player, player, alpha));
    }

    return {
      roomId: toState.roomId,
      isActive: toState.isActive,
      winnerId: toState.winnerId,
      serverTime: lerp(fromState.serverTime, toState.serverTime, alpha),
      players,
    };
  }

  function interpolatePlayer(fromPlayer, toPlayer, alpha) {
    return {
      connectionId: toPlayer.connectionId,
      displayName: toPlayer.displayName ?? fromPlayer.displayName,
      teamColor: toPlayer.teamColor ?? fromPlayer.teamColor,
      leader: interpolateEntity(fromPlayer.leader, toPlayer.leader, alpha),
      underlings: interpolateEntityList(
        fromPlayer.underlings,
        toPlayer.underlings,
        alpha
      ),
    };
  }

  function interpolateEntityList(fromList = [], toList = [], alpha) {
    if (toList.length === 0) {
      return [];
    }

    const matches = matchEntities(fromList, toList);
    return matches.map(({ previous, next }) =>
      interpolateEntity(previous ?? next, next, alpha)
    );
  }

  function interpolateEntity(fromEntity, toEntity, alpha) {
    const start = fromEntity ?? toEntity;
    const end = toEntity ?? fromEntity ?? start;
    if (!start || !end) {
      return cloneEntity(start ?? end);
    }
    return {
      ownerId: end.ownerId ?? start.ownerId,
      radius: end.radius ?? start.radius,
      color: end.color ?? start.color,
      type: end.type ?? start.type,
      x: lerp(start.x, end.x, alpha),
      y: lerp(start.y, end.y, alpha),
      vx: lerp(start.vx ?? 0, end.vx ?? 0, alpha),
      vy: lerp(start.vy ?? 0, end.vy ?? 0, alpha),
    };
  }

  function extrapolateState(state, deltaMs) {
    const deltaSeconds = deltaMs / 1000;
    const players = state.players.map((player) => {
      const leader = extrapolateEntity(player.leader, deltaSeconds);
      const underlings = player.underlings.map((entity) =>
        extrapolateEntity(entity, deltaSeconds)
      );
      return {
        connectionId: player.connectionId,
        displayName: player.displayName,
        teamColor: player.teamColor,
        leader,
        underlings,
      };
    });

    return {
      roomId: state.roomId,
      isActive: state.isActive,
      winnerId: state.winnerId,
      serverTime: state.serverTime + deltaMs,
      players,
    };
  }

  function extrapolateEntity(entity, deltaSeconds) {
    const copy = cloneEntity(entity);
    copy.x += (copy.vx ?? 0) * deltaSeconds;
    copy.y += (copy.vy ?? 0) * deltaSeconds;
    if (copy.type === "leader") {
      copy.x = clamp(copy.x, LEADER_RADIUS, canvasWidth - LEADER_RADIUS);
      copy.y = clamp(copy.y, LEADER_RADIUS, canvasHeight - LEADER_RADIUS);
    } else {
      const radius = copy.radius ?? 0;
      copy.x = clamp(copy.x, radius, canvasWidth - radius);
      copy.y = clamp(copy.y, radius, canvasHeight - radius);
    }
    return copy;
  }

  function cloneEntity(entity) {
    if (!entity) {
      return {
        ownerId: "",
        x: 0,
        y: 0,
        radius: 0,
        color: "#000000",
        type: "unknown",
        vx: 0,
        vy: 0,
      };
    }
    return {
      ownerId: entity.ownerId,
      x: entity.x,
      y: entity.y,
      radius: entity.radius,
      color: entity.color,
      type: entity.type,
      vx: entity.vx ?? 0,
      vy: entity.vy ?? 0,
    };
  }

  function matchEntities(previousList = [], nextList = []) {
    const remainingPrevious = previousList.slice();
    return nextList.map((next) => {
      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let i = 0; i < remainingPrevious.length; i++) {
        const prior = remainingPrevious[i];
        const score = entityMatchScore(prior, next);
        if (score < bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const previous =
        bestIndex >= 0 ? remainingPrevious.splice(bestIndex, 1)[0] : null;
      return { previous, next };
    });
  }

  function entityMatchScore(a, b) {
    if (!a) {
      return Number.POSITIVE_INFINITY;
    }
    let score = 0;
    if (a.type !== b.type) {
      score += 50;
    }
    if (a.ownerId !== b.ownerId) {
      score += 100;
    }
    if (a.color !== b.color) {
      score += 10;
    }
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    score += dx * dx + dy * dy;
    return score;
  }

  function smoothState(previous, next, deltaSeconds) {
    if (!next) {
      return previous;
    }

    if (!previous || !previous.players || previous.players.length === 0) {
      return cloneState(next);
    }

    const smoothing =
      deltaSeconds > 0 ? 1 - Math.exp(-SMOOTHING_STIFFNESS * deltaSeconds) : 1;

    const previousPlayers = new Map(
      (previous.players ?? []).map((player) => [player.connectionId, player])
    );

    const blendedPlayers = (next.players ?? []).map((player) => {
      const prior = previousPlayers.get(player.connectionId);
      return blendPlayer(prior, player, smoothing);
    });

    return {
      roomId: next.roomId,
      isActive: next.isActive,
      winnerId: next.winnerId,
      serverTime: next.serverTime,
      players: blendedPlayers,
    };
  }

  function cloneState(state) {
    return {
      roomId: state.roomId,
      isActive: state.isActive,
      winnerId: state.winnerId,
      serverTime: state.serverTime,
      players: (state.players ?? []).map((player) => clonePlayer(player)),
    };
  }

  function clonePlayer(player) {
    return {
      connectionId: player.connectionId,
      displayName: player.displayName,
      teamColor: player.teamColor,
      leader: cloneEntity(player.leader),
      underlings: (player.underlings ?? []).map((entity) =>
        cloneEntity(entity)
      ),
    };
  }

  function blendPlayer(previous, next, smoothing) {
    if (!previous) {
      return clonePlayer(next);
    }

    return {
      connectionId: next.connectionId,
      displayName: next.displayName,
      teamColor: next.teamColor,
      leader: blendEntity(previous.leader, next.leader, smoothing),
      underlings: blendEntityList(
        previous.underlings ?? [],
        next.underlings ?? [],
        smoothing
      ),
    };
  }

  function blendEntityList(previousList = [], nextList = [], smoothing) {
    if (nextList.length === 0) {
      return [];
    }

    if (previousList.length === 0 || previousList.length !== nextList.length) {
      return nextList.map((entity) => cloneEntity(entity));
    }

    const matches = matchEntities(previousList, nextList);
    return matches.map(({ previous, next }) =>
      blendEntity(previous ?? next, next, smoothing)
    );
  }

  function blendEntity(previous, next, smoothing) {
    if (!previous) {
      return cloneEntity(next);
    }

    const blend = clamp(smoothing, 0, 1);
    return {
      ownerId: next.ownerId ?? previous.ownerId,
      x: lerp(previous.x, next.x, blend),
      y: lerp(previous.y, next.y, blend),
      radius: next.radius ?? previous.radius,
      color: next.color ?? previous.color,
      type: next.type ?? previous.type,
      vx: lerp(previous.vx ?? 0, next.vx ?? 0, blend),
      vy: lerp(previous.vy ?? 0, next.vy ?? 0, blend),
    };
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

    connection
      .invoke("Move", pendingDirection)
      .then(() => {
        lastDirectionSent = pendingDirection;
      })
      .catch((err) => {
        console.error(err);
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
    updateRenderState(now, deltaSeconds);
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
