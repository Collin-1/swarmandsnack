(() => {
  // Simplified constants - no complex prediction
  const LEADER_SPEED = 160;
  const LEADER_RADIUS = 18;
  const MAX_PLAYERS = 8;

  // Colour keys must match GameConstants.PlayerColorKeys on the server (join order).
  const PLAYER_PALETTE = {
    cyan: { leader: "#22d3ee", underling: "#67e8f9" },
    rose: { leader: "#f43f5e", underling: "#fb7185" },
    amber: { leader: "#f59e0b", underling: "#fbbf24" },
    violet: { leader: "#8b5cf6", underling: "#a78bfa" },
    lime: { leader: "#84cc16", underling: "#a3e635" },
    orange: { leader: "#fb923c", underling: "#fdba74" },
    sky: { leader: "#38bdf8", underling: "#7dd3fc" },
    fuchsia: { leader: "#e879f9", underling: "#f0abfc" },
  };
  const DEFAULT_COLORS = { leader: "#94a3b8", underling: "#cbd5e1" };
  function paletteFor(teamColor) {
    return PLAYER_PALETTE[teamColor] || DEFAULT_COLORS;
  }

  const BASE_INTERPOLATION_DELAY_MS = 100;
  const MIN_INTERPOLATION_DELAY_MS = 70;
  const MAX_INTERPOLATION_DELAY_MS = 220;
  const SNAPSHOT_RETENTION_MS = 1200;
  const MAX_STATE_BUFFER = 80;
  const MAX_RECONCILE_STEP_PX = 7;
  const DEBUG_MODE = false; // Set to true to enable console diagnostics

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
  const scoreboardEl = document.getElementById("scoreboard");
  const startBtn = document.getElementById("startBtn");

  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  // The canvas is a camera viewport into a larger world; dimensions arrive
  // with each server snapshot (half world with <=4 players, full with more).
  let worldWidth = canvasWidth;
  let worldHeight = canvasHeight;
  const camera = { x: 0, y: 0 };

  let connection;
  let roomId = null;
  let myPlayerId = null;
  let isHost = false;
  let needsLeaderSnap = false;
  let lobbyCount = 0;
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
    // Called every snapshot (~33/s); skip identical writes to avoid DOM churn.
    if (statusEl.textContent !== message) {
      statusEl.textContent = message;
    }
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
      isHost = payload.hostId ? payload.hostId === myPlayerId : true;
      serverState = createEmptyState();
      lobbyCount = 1;
      needsLeaderSnap = true; // adopt our room spawn from the first snapshot
      setInviteLink(roomId);
      hideOverlay();
      updateStatusFromState(serverState);
    });

    connection.on("JoinedGame", (payload) => {
      resetSnapshotPipeline();
      roomId = payload.roomId;
      myPlayerId = payload.player?.playerId ?? myPlayerId;
      isHost = payload.hostId ? payload.hostId === myPlayerId : false;
      serverState = createEmptyState();
      needsLeaderSnap = true; // adopt our room spawn from the first snapshot
      setInviteLink(roomId);
      hideOverlay();
      updateStatusFromState(serverState);
      connection.invoke("RequestState").catch(console.error);
    });

    connection.on("JoinFailed", (payload) => {
      const messages = {
        RoomNotFound: "Room not found. Check the code.",
        RoomFull: "That room is full (8 players max).",
        MatchInProgress: "That match already started. Try again after it ends.",
      };
      setStatus(`Join failed: ${messages[payload.error] || payload.error}`);
    });

    connection.on("PlayerJoined", (payload) => {
      if (payload.hostId && myPlayerId) {
        isHost = payload.hostId === myPlayerId;
      }
      updateStatusFromState({
        isActive: serverState.isActive,
        winnerId: serverState.winnerId,
        players: payload.players,
      });
    });

    connection.on("StartFailed", (payload) => {
      const messages = {
        NotHost: "Only the host can start the match.",
        NotEnoughPlayers: "Need at least 2 players to start.",
        AlreadyStarted: "The match already started.",
      };
      setStatus(messages[payload.error] || `Cannot start: ${payload.error}`);
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

      if (typeof payload.worldWidth === "number") worldWidth = payload.worldWidth;
      if (typeof payload.worldHeight === "number") worldHeight = payload.worldHeight;

      // Sync local leader position from server periodically (soft correction)
      if (myPlayerId && payload.players) {
        const me = payload.players.find((p) => p.connectionId === myPlayerId);
        if (me && me.leader) {
          if (needsLeaderSnap) {
            // Fresh match/spawn: adopt the authoritative position immediately
            // instead of rubber-banding from a stale local position.
            myLocalLeader.x = me.leader.x;
            myLocalLeader.y = me.leader.y;
            myLocalLeader.vx = 0;
            myLocalLeader.vy = 0;
            needsLeaderSnap = false;
          } else {
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
            // Expected honest drift grows with latency (the server's view of us
            // trails by ~RTT). Scale the tolerance with the measured ping so a
            // laggy or heavily loaded setup doesn't trigger a correction on
            // every snapshot (constant rubber-band stutter). Capped below the
            // 100px hard-snap so severe desync still snaps.
            const latencySlackPx = Math.min(
              90,
              LEADER_SPEED * (currentLatency + 0.05),
            );
            const movingPx = Math.max(25, latencySlackPx);
            const stoppedPx = Math.max(50, latencySlackPx * 1.5);
            const driftThreshold = isLocallyStopped
              ? stoppedPx * stoppedPx
              : movingPx * movingPx;

            if (distSq > 10000) {
              // Hard snap only when severely desynced (>100px).
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
      }

      // maybeAssignPlayerId(payload); // REMOVED: Caused race condition where Red player attached to Blue
      updateStatusFromState(payload);
    });
    connection.on("GameOver", (payload) => {
      if (!payload) {
        return;
      }

      const isDraw = !payload.winnerId;
      const winner = isDraw
        ? null
        : serverState.players.find((p) => p.connectionId === payload.winnerId);

      // Ensure state reflects game over so movement stops (truthy sentinel for a draw).
      serverState.winnerId = payload.winnerId || "__draw__";

      const winnerColor = winner ? paletteFor(winner.teamColor).leader : "#ffffff";
      const titleText = winner ? "VICTORY!" : isDraw ? "DRAW" : "GAME OVER";

      if (winner) {
        const winnerName = winner.displayName || winner.teamColor;
        setStatus(`Game Over! Winner: ${winnerName}`);
      } else {
        setStatus(isDraw ? "Game Over! It's a draw." : "Game Over!");
      }

      const bodyText = winner
        ? `<strong style="color:${winnerColor}; text-shadow: 0 0 10px ${winnerColor};">${winner.displayName || winner.teamColor}</strong> devoured the swarm!`
        : isDraw
          ? "Everyone was devoured at once!"
          : "Match complete!";

      const html = `
        <div style="text-align: center;">
            <h1 class="victory-title" style="--winner-color: ${winnerColor};" data-text="${titleText}">
                ${titleText}
            </h1>
            <p style="font-size: 1.5rem; color: #cbd5e1; margin: 0;">
                ${bodyText}
            </p>
            ${isHost ? "" : `<p style="color:#94a3b8; margin-top:1rem;">Waiting for the host to start a rematch…</p>`}
        </div>
      `;

      // Only the host can trigger a rematch.
      if (restartBtn) restartBtn.style.display = isHost ? "" : "none";
      showOverlay(html, true);
    });

    connection.on("MatchStarted", () => {
      hideOverlay();
      setStatus("Match starting!");
      activeKeyDirections.clear();
      setPendingDirection("none");
      lastDirectionSent = "none";
      serverState = createEmptyState();
      resetSnapshotPipeline();
      needsLeaderSnap = true; // adopt spawn position from the first authoritative frame
      correctionCount = 0;
      hardSnapCount = 0;
      if (restartBtn) restartBtn.style.display = "";
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

    if (newerIndex === 0) {
      return stateBuffer[0].state;
    }

    if (newerIndex === -1) {
      // All snapshots are older than renderTime (high latency / buffer lag).
      // Return the newest available state so entities stay at their last known position.
      return stateBuffer[stateBuffer.length - 1].state;
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
      worldWidth - radius,
    );
    const y = clamp(
      lerp(olderEntity.y, newerEntity.y, t),
      radius,
      worldHeight - radius,
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

    lobbyCount = state.players?.length ?? lobbyCount;
    const inLobby = !state.isActive && !state.winnerId;

    // Host-only Start Match button, visible only while sitting in the lobby.
    // Runs every snapshot; only touch the DOM when something actually changes.
    if (startBtn) {
      if (inLobby && isHost && roomId) {
        const label = lobbyCount < 2 ? "Waiting for players…" : "Start Match";
        if (startBtn.style.display !== "block") startBtn.style.display = "block";
        if (startBtn.disabled !== (lobbyCount < 2)) startBtn.disabled = lobbyCount < 2;
        if (startBtn.textContent !== label) startBtn.textContent = label;
      } else if (startBtn.style.display !== "none") {
        startBtn.style.display = "none";
      }
    }

    if (state.isActive) {
      setStatus("Battle in progress!");
    } else if (state.winnerId) {
      // Overlay handles the game-over messaging.
    } else if (lobbyCount < 2) {
      setStatus(`Waiting for players… (${lobbyCount}/${MAX_PLAYERS})`);
    } else if (isHost) {
      setStatus(`Ready — ${lobbyCount}/${MAX_PLAYERS} in lobby. Press Start Match.`);
    } else {
      setStatus(`Waiting for host to start… (${lobbyCount}/${MAX_PLAYERS})`);
    }
  }

  function updateLocalLeader(deltaSeconds) {
    // Move local leader instantly based on input
    const vx = localDirectionVector.x * LEADER_SPEED;
    const vy = localDirectionVector.y * LEADER_SPEED;

    myLocalLeader.x = clamp(
      myLocalLeader.x + vx * deltaSeconds,
      LEADER_RADIUS,
      worldWidth - LEADER_RADIUS,
    );
    myLocalLeader.y = clamp(
      myLocalLeader.y + vy * deltaSeconds,
      LEADER_RADIUS,
      worldHeight - LEADER_RADIUS,
    );
    myLocalLeader.vx = vx;
    myLocalLeader.vy = vy;

    // Slide the optimistic local leader around obstacles so it matches the server
    // (which does the same circle-vs-rectangle resolution) and doesn't clip walls.
    collideLeaderWithObstacles(myLocalLeader);
  }

  function collideLeaderWithObstacles(leader) {
    const obstacles = serverState.obstacles;
    if (!obstacles || obstacles.length === 0) {
      return;
    }
    const radius = LEADER_RADIUS;
    for (const o of obstacles) {
      const maxX = o.x + o.width;
      const maxY = o.y + o.height;
      let nx;
      let ny;
      let penetration;

      if (leader.x >= o.x && leader.x <= maxX && leader.y >= o.y && leader.y <= maxY) {
        // Centre inside the box: eject along the least-penetration axis.
        const left = leader.x - o.x;
        const right = maxX - leader.x;
        const top = leader.y - o.y;
        const bottom = maxY - leader.y;
        const min = Math.min(left, right, top, bottom);
        if (min === left) { nx = -1; ny = 0; penetration = left + radius; }
        else if (min === right) { nx = 1; ny = 0; penetration = right + radius; }
        else if (min === top) { nx = 0; ny = -1; penetration = top + radius; }
        else { nx = 0; ny = 1; penetration = bottom + radius; }
      } else {
        const cx = clamp(leader.x, o.x, maxX);
        const cy = clamp(leader.y, o.y, maxY);
        const dx = leader.x - cx;
        const dy = leader.y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq >= radius * radius) {
          continue;
        }
        const dist = Math.sqrt(distSq);
        if (dist > 0.0001) { nx = dx / dist; ny = dy / dist; } else { nx = 0; ny = -1; }
        penetration = radius - dist;
      }

      leader.x += nx * penetration;
      leader.y += ny * penetration;
      const inward = leader.vx * nx + leader.vy * ny;
      if (inward < 0) {
        leader.vx -= nx * inward;
        leader.vy -= ny * inward;
      }
    }
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

      // Use latest server underlings (not the delayed interpolated ones) so the
      // visual positions match what the server is actually checking for collisions.
      const underlings = latestPlayer?.underlings ?? [];

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

  // The world background (grid + room walls) never changes during play, so it
  // is rasterised once into a world-sized offscreen canvas and the camera's
  // window into it is blitted each frame. Re-rendered only when the world
  // size or obstacle set changes (first snapshot, or half <-> full world).
  const staticLayer = document.createElement("canvas");
  let staticLayerSignature = null;

  function updateCamera() {
    camera.x = clamp(
      myLocalLeader.x - canvasWidth / 2,
      0,
      Math.max(0, worldWidth - canvasWidth),
    );
    camera.y = clamp(
      myLocalLeader.y - canvasHeight / 2,
      0,
      Math.max(0, worldHeight - canvasHeight),
    );
  }

  function renderScene() {
    const signature = `${worldWidth}x${worldHeight}:${serverState.obstacles?.length ?? 0}`;
    if (signature !== staticLayerSignature) {
      staticLayerSignature = signature;
      renderStaticLayer();
    }

    updateCamera();
    ctx.drawImage(
      staticLayer,
      camera.x, camera.y, canvasWidth, canvasHeight,
      0, 0, canvasWidth, canvasHeight,
    );

    const bufferedState = getBufferedStateForRender();
    const renderState = buildRenderState(bufferedState);

    ctx.save();
    ctx.translate(-camera.x, -camera.y);
    drawEntities(renderState);
    ctx.restore();

    drawScoreboard(renderState);
  }

  function renderStaticLayer() {
    staticLayer.width = Math.max(worldWidth, canvasWidth);
    staticLayer.height = Math.max(worldHeight, canvasHeight);
    const sctx = staticLayer.getContext("2d");
    sctx.save();

    // Dark Arcade Background
    sctx.fillStyle = "#0f172a"; // Slate 900
    sctx.fillRect(0, 0, staticLayer.width, staticLayer.height);

    sctx.strokeStyle = "rgba(255, 255, 255, 0.05)"; // Very faint white lines
    sctx.lineWidth = 2;
    const gridSize = 40;
    for (let x = gridSize; x < worldWidth; x += gridSize) {
      sctx.beginPath();
      sctx.moveTo(x + 0.5, 0);
      sctx.lineTo(x + 0.5, worldHeight);
      sctx.stroke();
    }
    for (let y = gridSize; y < worldHeight; y += gridSize) {
      sctx.beginPath();
      sctx.moveTo(0, y + 0.5);
      sctx.lineTo(worldWidth, y + 0.5);
      sctx.stroke();
    }

    // World boundary so the edge of the map reads as a wall, not a void.
    sctx.strokeStyle = "rgba(56, 189, 248, 0.5)";
    sctx.lineWidth = 4;
    sctx.strokeRect(2, 2, worldWidth - 4, worldHeight - 4);

    const obstacles = serverState.obstacles ?? [];
    for (const o of obstacles) {
      sctx.fillStyle = "#1e293b"; // Slate 800
      sctx.strokeStyle = "rgba(148, 163, 184, 0.55)";
      sctx.lineWidth = 2;
      sctx.beginPath();
      sctx.rect(o.x, o.y, o.width, o.height);
      sctx.fill();
      sctx.stroke();

      // Inner accent line for a bit of arcade depth.
      sctx.strokeStyle = "rgba(56, 189, 248, 0.25)";
      sctx.lineWidth = 1;
      sctx.strokeRect(o.x + 3, o.y + 3, o.width - 6, o.height - 6);
    }
    sctx.restore();
  }

  function drawEntities(state) {
    if (!state || !state.players) {
      return;
    }

    // Bouncy wobble animation
    const time = performance.now();

    for (const player of state.players) {
      // Per-player palette (keyed by the server-assigned colour key).
      const colors = paletteFor(player.teamColor);
      const baseColor = colors.leader;
      const underlingColor = colors.underling;

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

  let lastScoreboardHtml = null;

  function drawScoreboard(state) {
    if (!scoreboardEl) return;
    let html = "";
    if (state && state.players && state.players.length > 0) {
      html = state.players
        .map((player) => {
          const color = paletteFor(player.teamColor).leader;
          const name = player.displayName || player.teamColor;
          const remaining = player.underlings?.length ?? 0;
          return `<span style="color:${color};text-shadow:0 0 8px ${color}80">${name}: <strong>${remaining}</strong></span>`;
        })
        .join("");
    }
    // Runs every animation frame; only touch the DOM when the content changes.
    if (html !== lastScoreboardHtml) {
      lastScoreboardHtml = html;
      scoreboardEl.innerHTML = html;
    }
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

    if (document.activeElement?.tagName === "INPUT") {
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

    if (document.activeElement?.tagName === "INPUT") {
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
    if (!roomId) {
      return;
    }
    // Rematch goes through the same host-gated start path.
    try {
      await connection.invoke("StartGame");
    } catch (err) {
      console.error(err);
    }
  });

  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      if (!roomId) {
        return;
      }
      try {
        await connection.invoke("StartGame");
      } catch (err) {
        console.error(err);
      }
    });
  }

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", handleWindowBlur);

  requestAnimationFrame(draw);
  startConnection().catch((err) => {
    console.error(err);
    setStatus("Unable to connect to server.");
  });
})();
