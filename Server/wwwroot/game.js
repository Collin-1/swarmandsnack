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
  const avatarBarEl = document.getElementById("avatarBar");
  const micBtn = document.getElementById("micBtn");
  const micIconEl = document.getElementById("micIcon");
  const micLabelEl = document.getElementById("micLabel");
  const voiceStatusEl = document.getElementById("voiceStatus");

  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  // The canvas is a camera viewport into a larger world; dimensions arrive
  // with each server snapshot (half world with <=4 players, full with more).
  let worldWidth = canvasWidth;
  let worldHeight = canvasHeight;
  let worldRooms = [];
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
      VoiceClient.reset();
    });

    await connection.start();
    VoiceClient.attach(connection, myPlayerId);
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
      VoiceClient.setSelfId(myPlayerId);
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
      VoiceClient.setSelfId(myPlayerId);
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
      // Adopt the mic states of players who were already here.
      VoiceClient.seedMicStates(payload.players);
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
      if (Array.isArray(payload.rooms)) worldRooms = payload.rooms;

      // The snapshot roster is the authoritative "who is in this room" list, in
      // the lobby and mid-match alike, so voice peering follows it.
      syncVoiceRoster(payload.players);

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

  // ---- World textures ----------------------------------------------------
  //
  // Floor and stone are painted with repeating textures. Everything here is
  // baked into the cached static layer below, so texture detail costs nothing
  // per frame no matter how elaborate it gets.
  //
  // The textures are generated procedurally as placeholders. To use real art,
  // drop seamlessly tiling `floor.png` and `wall.png` into wwwroot/textures/
  // and flip USE_IMAGE_TEXTURES to true -- nothing else needs to change.
  const USE_IMAGE_TEXTURES = true;
  const TEXTURE_PATHS = {
    floor: "textures/floor.png",
    wall: "textures/wall.png",
    cap: "textures/cap.png",
    props: "textures/props.png",
  };
  // Art is authored larger than it should appear in game; scaling the pattern
  // keeps the source high-resolution while sizing features to the world. Walls
  // are only 44px thick, so a 512px tile must shrink or a single stone course
  // won't even fit across one.
  const TEXTURE_SCALE = { floor: 0.75, wall: 0.5, cap: 0.5, props: 0.4 };
  // Capstones are a lip along the top edge of a wall, foreshortened by the
  // top-down camera rather than shown at their true depth.
  const CAP_BAND_PX = 14;
  const PROP_GRID = 4; // props.png is a 4x4 sheet
  // Sheet cells grouped by where they belong. Scattering everything uniformly
  // reads as litter; in the reference art scenery crowds the stonework and open
  // floor stays almost clear.
  const PROP_BANNERS = [9, 10, 11]; // hung on wall faces
  const PROP_FOLIAGE = [3, 4, 5]; // bush, fern, moss - piled against walls
  const PROP_CLUTTER = [0, 1, 6, 7, 8, 12, 13, 14]; // rubble, crates, bones...
  const PROP_ROCKS = [2, 15]; // the only things allowed in open floor
  // The hex grid belongs to the sci-fi look; it fights the stone dungeon one.
  const SHOW_HEX_OVERLAY = false;

  const textureSources = {};
  let floorPattern = null;
  let wallPattern = null;

  // Returns the offsets a shape must also be drawn at so it wraps across the
  // texture edges — without this the tiles show visible seams.
  function wrapOffsets(x, y, radius, size) {
    const xs = [0];
    const ys = [0];
    if (x - radius < 0) xs.push(size);
    if (x + radius > size) xs.push(-size);
    if (y - radius < 0) ys.push(size);
    if (y + radius > size) ys.push(-size);
    const out = [];
    for (const ox of xs) for (const oy of ys) out.push([ox, oy]);
    return out;
  }

  function buildFloorTexture(size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");

    g.fillStyle = "#241f1a";
    g.fillRect(0, 0, size, size);

    // Broad light and dark patches: worn ground rather than flat colour.
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 40 + Math.random() * 95;
      const light = Math.random() < 0.5;
      for (const [ox, oy] of wrapOffsets(x, y, r, size)) {
        const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grad.addColorStop(0, light ? "rgba(78,68,54,0.40)" : "rgba(12,10,8,0.45)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }

    // Grit.
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 0.6 + Math.random() * 1.8;
      const shade = Math.random() < 0.5 ? 255 : 0;
      g.fillStyle = `rgba(${shade},${shade},${shade},${0.03 + Math.random() * 0.05})`;
      for (const [ox, oy] of wrapOffsets(x, y, r, size)) {
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        g.fill();
      }
    }

    // A few cracks.
    g.strokeStyle = "rgba(0,0,0,0.28)";
    g.lineWidth = 1.4;
    for (let i = 0; i < 16; i++) {
      let x = Math.random() * size;
      let y = Math.random() * size;
      g.beginPath();
      g.moveTo(x, y);
      for (let seg = 0; seg < 4; seg++) {
        x += (Math.random() - 0.5) * 60;
        y += (Math.random() - 0.5) * 60;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    return canvas;
  }

  function buildWallTexture(size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");

    const blockW = size / 4;
    const blockH = size / 8;

    g.fillStyle = "#1b1c1a"; // mortar showing between blocks
    g.fillRect(0, 0, size, size);

    for (let row = 0; row < size / blockH; row++) {
      const y = row * blockH;
      const offset = row % 2 ? blockW / 2 : 0;
      for (let col = -1; col <= size / blockW; col++) {
        const x = col * blockW + offset;
        const shade = 60 + Math.random() * 26;
        const draws = x + blockW > size ? [0, -size] : x < 0 ? [0, size] : [0];

        for (const ox of draws) {
          const bx = x + ox + 1.5;
          const by = y + 1.5;
          const bw = blockW - 3;
          const bh = blockH - 3;

          g.fillStyle = `rgb(${shade},${shade - 3},${shade - 9})`;
          g.fillRect(bx, by, bw, bh);

          // Lit top edge and shaded bottom give the blocks relief.
          g.fillStyle = "rgba(255,246,225,0.10)";
          g.fillRect(bx, by, bw, 2.5);
          g.fillStyle = "rgba(0,0,0,0.32)";
          g.fillRect(bx, by + bh - 2.5, bw, 2.5);

          // Pitting.
          for (let i = 0; i < 12; i++) {
            const px = bx + Math.random() * bw;
            const py = by + Math.random() * bh;
            g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.09})`;
            g.beginPath();
            g.arc(px, py, 0.7 + Math.random() * 1.7, 0, Math.PI * 2);
            g.fill();
          }

          // Moss, as in the reference art.
          if (Math.random() < 0.22) {
            const mx = bx + Math.random() * bw;
            const my = by + Math.random() * bh;
            const grad = g.createRadialGradient(mx, my, 0, mx, my, blockH * 0.7);
            grad.addColorStop(0, "rgba(96,124,54,0.34)");
            grad.addColorStop(1, "rgba(96,124,54,0)");
            g.fillStyle = grad;
            g.fillRect(bx, by, bw, bh);
          }
        }
      }
    }
    return canvas;
  }

  function ensureTextures() {
    if (!textureSources.floor) textureSources.floor = buildFloorTexture(512);
    if (!textureSources.wall) textureSources.wall = buildWallTexture(256);
  }

  function makePattern(ctx, source, scale) {
    const pattern = ctx.createPattern(source, "repeat");
    if (pattern && scale !== 1 && typeof pattern.setTransform === "function") {
      // Only applies to image art; the procedural tiles are authored at size.
      pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
    }
    return pattern;
  }

  function scaleFor(key) {
    // Procedural placeholders are drawn at their intended size already.
    return textureSources[key] instanceof HTMLImageElement ? TEXTURE_SCALE[key] : 1;
  }

  function getFloorPattern(ctx) {
    ensureTextures();
    if (!floorPattern) floorPattern = makePattern(ctx, textureSources.floor, scaleFor("floor"));
    return floorPattern;
  }

  function getWallPattern(ctx) {
    ensureTextures();
    if (!wallPattern) wallPattern = makePattern(ctx, textureSources.wall, scaleFor("wall"));
    return wallPattern;
  }

  // ---- Wall capstones -----------------------------------------------------

  let capPattern = null;

  /**
   * The capstone art does not wrap horizontally (its edge columns differ by far
   * more than its interior does), so it is mirrored first: a tile followed by a
   * flipped copy of itself always meets seamlessly at both joins, because each
   * boundary puts identical columns next to each other. The result repeats over
   * twice the width, which for a 14px lip is not readable as symmetry.
   */
  function getCapPattern(sctx) {
    const src = textureSources.cap;
    if (!src) return null;
    if (capPattern) return capPattern;

    const w = src.width;
    const h = src.height;
    const mirrored = document.createElement("canvas");
    mirrored.width = w * 2;
    mirrored.height = h;
    const mctx = mirrored.getContext("2d");
    mctx.drawImage(src, 0, 0);
    mctx.save();
    mctx.translate(w * 2, 0);
    mctx.scale(-1, 1);
    mctx.drawImage(src, 0, 0);
    mctx.restore();

    capPattern = sctx.createPattern(mirrored, "repeat");
    if (capPattern && typeof capPattern.setTransform === "function") {
      // Squashed vertically into the lip; horizontal scale matches the wall so
      // capstones line up with the courses below them.
      capPattern.setTransform(
        new DOMMatrix([TEXTURE_SCALE.cap, 0, 0, CAP_BAND_PX / h, 0, 0]),
      );
    }
    return capPattern;
  }

  function drawWallCaps(sctx, obstacles) {
    const pattern = getCapPattern(sctx);
    if (!pattern) return false;
    sctx.save();
    sctx.fillStyle = pattern;
    for (const o of obstacles) {
      // Anchored to the world origin, so caps stay continuous where walls meet.
      sctx.fillRect(o.x, o.y, o.width, Math.min(CAP_BAND_PX, o.height));
    }
    sctx.restore();
    return true;
  }

  // ---- Props -------------------------------------------------------------

  let propSprites = null;

  function getPropSprites() {
    const img = textureSources.props;
    if (!img) return null;
    if (propSprites) return propSprites;
    const cell = img.width / PROP_GRID;
    propSprites = [];
    for (let row = 0; row < PROP_GRID; row++) {
      for (let col = 0; col < PROP_GRID; col++) {
        propSprites.push({
          index: row * PROP_GRID + col,
          sx: col * cell,
          sy: row * cell,
          size: cell,
        });
      }
    }
    return propSprites;
  }

  // Props must land in the same spot every time the world layer is rebuilt,
  // otherwise scenery would jump whenever the half/full world changes.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function overlapsWall(x, y, half, obstacles) {
    for (const o of obstacles) {
      if (
        x + half > o.x - 6 &&
        x - half < o.x + o.width + 6 &&
        y + half > o.y - 6 &&
        y - half < o.y + o.height + 6
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Scenery is placed against the stonework rather than sprinkled over the
   * floor: walked along every wall face, clustered at corners, and only a thin
   * scatter of rocks left in the open. Uniform random placement was the reason
   * the world read as litter on an empty field.
   */
  function drawProps(sctx, obstacles) {
    const img = textureSources.props;
    const sprites = getPropSprites();
    if (!img || !sprites) return;

    const cell = img.width / PROP_GRID;
    const random = seededRandom(1337 + Math.round(worldWidth));
    const pick = (group) => sprites[group[(random() * group.length) | 0]];

    const place = (sprite, cx, cy, size) => {
      const half = size / 2;
      if (cx < half || cy < half || cx > worldWidth - half || cy > worldHeight - half) return false;
      if (overlapsWall(cx, cy, half * 0.55, obstacles)) return false;
      sctx.drawImage(
        img, sprite.sx, sprite.sy, sprite.size, sprite.size,
        cx - half, cy - half, size, size,
      );
      return true;
    };

    // --- moss and grass creeping out from the base of every wall ---
    for (const o of obstacles) {
      const step = 46;
      for (let x = o.x; x < o.x + o.width; x += step) {
        if (random() > 0.55) continue;
        const w = 40 + random() * 46;
        const grad = sctx.createRadialGradient(x, o.y + o.height, 0, x, o.y + o.height, w);
        grad.addColorStop(0, "rgba(84, 104, 46, 0.5)");
        grad.addColorStop(1, "rgba(84, 104, 46, 0)");
        sctx.fillStyle = grad;
        sctx.fillRect(x - w, o.y + o.height - w * 0.5, w * 2, w * 1.2);
      }
    }

    // --- clutter and foliage banked along wall faces ---
    for (const o of obstacles) {
      const sides = [
        { horiz: true, len: o.width, at: (t) => [o.x + t, o.y - 1], out: -1 },
        { horiz: true, len: o.width, at: (t) => [o.x + t, o.y + o.height + 1], out: 1 },
        { horiz: false, len: o.height, at: (t) => [o.x - 1, o.y + t], out: -1 },
        { horiz: false, len: o.height, at: (t) => [o.x + o.width + 1, o.y + t], out: 1 },
      ];
      for (const side of sides) {
        if (side.len < 70) continue;
        for (let t = 30; t < side.len - 20; t += 74) {
          if (random() > 0.5) continue;
          const jitter = (random() - 0.5) * 34;
          const [bx, by] = side.at(t + jitter);
          // Small groups look deliberate where singletons look dropped.
          const count = 1 + ((random() * 2.4) | 0);
          for (let i = 0; i < count; i++) {
            const foliage = random() < 0.55;
            const sprite = pick(foliage ? PROP_FOLIAGE : PROP_CLUTTER);
            const size = cell * (foliage ? 0.42 : 0.38) * (0.8 + random() * 0.5);
            const away = size * (0.45 + random() * 0.3) + i * size * 0.5;
            const slide = (random() - 0.5) * size * 1.4;
            const cx = side.horiz ? bx + slide : bx + away * side.out;
            const cy = side.horiz ? by + away * side.out : by + slide;
            place(sprite, cx, cy, size);
          }
        }
      }
    }

    // --- heavier clusters tucked into wall corners ---
    for (const o of obstacles) {
      if (o.width < 60 || o.height < 60) continue;
      const corners = [
        [o.x, o.y, -1, -1], [o.x + o.width, o.y, 1, -1],
        [o.x, o.y + o.height, -1, 1], [o.x + o.width, o.y + o.height, 1, 1],
      ];
      for (const [cxr, cyr, dx, dy] of corners) {
        if (random() > 0.42) continue;
        const count = 2 + ((random() * 2.6) | 0);
        for (let i = 0; i < count; i++) {
          const sprite = pick(random() < 0.6 ? PROP_FOLIAGE : PROP_CLUTTER);
          const size = cell * 0.4 * (0.75 + random() * 0.55);
          place(
            sprite,
            cxr + dx * (size * (0.5 + random() * 0.9)),
            cyr + dy * (size * (0.5 + random() * 0.9)),
            size,
          );
        }
      }
    }

    // --- a sparse handful of rocks so open floor isn't sterile ---
    // Counts successful placements, not attempts: open ground should stay
    // readable, so this is deliberately a scattering of a dozen or so.
    const openRocks = Math.round((worldWidth * worldHeight) / 420000);
    let rocks = 0;
    for (let attempt = 0; rocks < openRocks && attempt < openRocks * 25; attempt++) {
      const size = cell * 0.32 * (0.7 + random() * 0.5);
      if (place(pick(PROP_ROCKS), random() * worldWidth, random() * worldHeight, size)) {
        rocks++;
      }
    }
  }

  /**
   * Gives each room its own identity: a wash of the colour of the player who
   * spawns there plus a glowing inner edge, so the world reads as a set of
   * places rather than one continuous floor.
   */
  function drawRoomFloors(sctx, rooms) {
    if (!rooms || rooms.length === 0) return;
    for (const room of rooms) {
      const colour = paletteFor(room.colorKey).leader;
      sctx.save();
      sctx.globalAlpha = 0.09;
      sctx.fillStyle = colour;
      sctx.fillRect(room.x, room.y, room.width, room.height);
      sctx.restore();

      // Inner glow hugging the walls of the room.
      sctx.save();
      sctx.globalAlpha = 0.5;
      sctx.strokeStyle = colour;
      sctx.lineWidth = 3;
      sctx.shadowColor = colour;
      sctx.shadowBlur = 26;
      const inset = 44; // matches GameConstants.WallThickness
      sctx.strokeRect(
        room.x + inset, room.y + inset,
        room.width - inset * 2, room.height - inset * 2,
      );
      sctx.restore();
    }
  }

  function drawWallBanners(sctx, obstacles) {
    const img = textureSources.props;
    const sprites = getPropSprites();
    if (!img || !sprites) return;

    const size = (img.width / PROP_GRID) * 0.5;
    const banners = PROP_BANNERS.map((i) => sprites[i]).filter(Boolean);
    if (banners.length === 0) return;
    const random = seededRandom(99 + Math.round(worldWidth));

    for (const o of obstacles) {
      // Only long walls, and only some of them, so banners stay an accent.
      if (o.width < size * 1.6 || o.height < 24) continue;
      if (random() > 0.3) continue;
      const sprite = banners[(random() * banners.length) | 0];
      const cx = o.x + o.width * (0.25 + random() * 0.5);
      // Hangs from the wall face, pole sitting on the stone.
      sctx.drawImage(
        img, sprite.sx, sprite.sy, sprite.size, sprite.size,
        cx - size / 2, o.y + o.height - size * 0.3, size, size,
      );
    }
  }

  // Optional real art. Falls back silently to the procedural textures.
  function loadImageTextures() {
    if (!USE_IMAGE_TEXTURES) return;
    for (const key of Object.keys(TEXTURE_PATHS)) {
      const img = new Image();
      img.onload = () => {
        textureSources[key] = img;
        floorPattern = null;
        wallPattern = null;
        capPattern = null;
        propSprites = null;
        staticLayerSignature = null; // force the world to repaint with it
      };
      img.onerror = () => {};
      img.src = TEXTURE_PATHS[key];
    }
  }

  // The world background (floor + room walls) never changes during play, so it
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
    const signature = `${worldWidth}x${worldHeight}:${serverState.obstacles?.length ?? 0}:${worldRooms.length}`;
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
    // Avatars follow the newest roster rather than the delayed render state.
    drawAvatars(serverState);
  }

  function renderStaticLayer() {
    staticLayer.width = Math.max(worldWidth, canvasWidth);
    staticLayer.height = Math.max(worldHeight, canvasHeight);
    const sctx = staticLayer.getContext("2d");
    sctx.save();

    // Ground
    sctx.fillStyle = "#241f1a";
    sctx.fillRect(0, 0, staticLayer.width, staticLayer.height);
    sctx.fillStyle = getFloorPattern(sctx);
    sctx.fillRect(0, 0, worldWidth, worldHeight);

    // Warm pool of light through the middle, darkening toward the edges, so a
    // world this size doesn't read as one evenly-lit sheet.
    const cx = worldWidth / 2;
    const cy = worldHeight / 2;
    const lit = sctx.createRadialGradient(
      cx, cy, 0,
      cx, cy, Math.max(worldWidth, worldHeight) * 0.72,
    );
    lit.addColorStop(0, "rgba(150, 120, 70, 0.16)");
    lit.addColorStop(0.55, "rgba(60, 48, 30, 0.08)");
    lit.addColorStop(1, "rgba(0, 0, 0, 0.42)");
    sctx.fillStyle = lit;
    sctx.fillRect(0, 0, worldWidth, worldHeight);

    if (SHOW_HEX_OVERLAY) {
      drawHexFloor(sctx);
    }

    const obstacles = serverState.obstacles ?? [];

    drawRoomFloors(sctx, worldRooms);

    // Scenery goes down before the stone, so anything close to a wall is
    // occluded by it rather than sitting on top.
    drawProps(sctx, obstacles);

    // Walls are drawn in three passes so the masonry pattern stays continuous
    // across adjoining blocks instead of restarting per rectangle.
    sctx.save();
    sctx.shadowColor = "rgba(0, 0, 0, 0.72)";
    sctx.shadowBlur = 20;
    sctx.shadowOffsetX = 5;
    sctx.shadowOffsetY = 8;
    sctx.fillStyle = "#000";
    for (const o of obstacles) sctx.fillRect(o.x, o.y, o.width, o.height);
    sctx.restore();

    sctx.fillStyle = getWallPattern(sctx);
    for (const o of obstacles) sctx.fillRect(o.x, o.y, o.width, o.height);

    // Capstone lip, or a plain lit edge when there is no cap art.
    const capped = drawWallCaps(sctx, obstacles);

    for (const o of obstacles) {
      if (!capped) {
        sctx.fillStyle = "rgba(255, 244, 214, 0.13)";
        sctx.fillRect(o.x, o.y, o.width, 3);
      }
      // Shaded base reads as height from a top-down camera.
      sctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      sctx.fillRect(o.x, o.y + o.height - 4, o.width, 4);
      sctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      sctx.lineWidth = 2;
      sctx.strokeRect(o.x + 1, o.y + 1, o.width - 2, o.height - 2);
    }

    drawWallBanners(sctx, obstacles);

    // Darkened edges so the map falls away into shadow rather than ending flat.
    const vig = sctx.createRadialGradient(
      cx, cy, Math.min(worldWidth, worldHeight) * 0.34,
      cx, cy, Math.max(worldWidth, worldHeight) * 0.72,
    );
    vig.addColorStop(0, "rgba(0, 0, 0, 0)");
    vig.addColorStop(1, "rgba(0, 0, 0, 0.6)");
    sctx.fillStyle = vig;
    sctx.fillRect(0, 0, worldWidth, worldHeight);

    // World boundary so the edge of the map reads as a wall, not a void.
    sctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    sctx.lineWidth = 8;
    sctx.strokeRect(4, 4, worldWidth - 8, worldHeight - 8);

    sctx.restore();
  }

  // Hexagonal honeycomb floor, painted as one repeating tile.
  //
  // Drawing every hex as a path across the whole world (~2400 hexes, ~14k
  // segments) cost ~380ms to build and dropped steady-state to 56fps, because a
  // path that large keeps the canvas off the fast path and the per-frame blit
  // pays for it. A small tile + createPattern is one fillRect instead.
  //
  // TILE_W/TILE_H are integers so the pattern repeats without seams; the hex
  // radius is derived from them, which is a <0.1% distortion from a true
  // hexagon and not visible.
  const HEX_TILE_W = 45;
  const HEX_TILE_H = 78; // two rows: 2 * 1.5R
  let hexPattern = null;

  function getHexPattern(sctx) {
    if (hexPattern) return hexPattern;

    const R = HEX_TILE_H / 3; // 26
    const rowStep = R * 1.5;
    const tile = document.createElement("canvas");
    tile.width = HEX_TILE_W;
    tile.height = HEX_TILE_H;
    const tctx = tile.getContext("2d");

    const corners = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 90); // pointy-top
      corners.push([R * Math.cos(angle), R * Math.sin(angle)]);
    }

    tctx.beginPath();
    // Rows -1..2 and columns -1..1 so hexes overlapping the tile edges are
    // drawn too; the grid is periodic, so the tile then butts up seamlessly.
    for (let row = -1; row <= 2; row++) {
      const y = row * rowStep;
      const xOffset = Math.abs(row % 2) === 1 ? HEX_TILE_W / 2 : 0;
      for (let col = -1; col <= 1; col++) {
        const x = xOffset + col * HEX_TILE_W;
        tctx.moveTo(x + corners[0][0], y + corners[0][1]);
        for (let i = 1; i < 6; i++) tctx.lineTo(x + corners[i][0], y + corners[i][1]);
        tctx.closePath();
      }
    }
    // Single stroke: per-hex strokes would double-paint shared edges and the
    // translucent lines would build up unevenly.
    tctx.strokeStyle = "rgba(56, 189, 248, 0.13)";
    tctx.lineWidth = 1.5;
    tctx.stroke();

    hexPattern = sctx.createPattern(tile, "repeat");
    return hexPattern;
  }

  function drawHexFloor(sctx) {
    const pattern = getHexPattern(sctx);
    if (!pattern) return;
    sctx.fillStyle = pattern;
    sctx.fillRect(0, 0, worldWidth, worldHeight);
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

  // ---- Voice roster + avatars -------------------------------------------

  let lastVoiceRosterKey = null;

  function syncVoiceRoster(players) {
    const ids = (players ?? []).map((p) => p.connectionId).filter(Boolean);
    const key = ids.slice().sort().join(",");
    if (key === lastVoiceRosterKey) return;
    lastVoiceRosterKey = key;
    VoiceClient.syncPeers(ids);
  }

  const avatarEls = new Map();
  let avatarRosterKey = null;

  function rebuildAvatars(players) {
    avatarEls.clear();
    avatarBarEl.innerHTML = "";
    for (const player of players) {
      const colors = paletteFor(player.teamColor);
      const name = player.displayName || player.teamColor;

      const wrap = document.createElement("div");
      wrap.className = "avatar";
      wrap.dataset.playerId = player.connectionId;
      if (player.connectionId === myPlayerId) wrap.classList.add("is-self");

      const disc = document.createElement("div");
      disc.className = "avatar-disc";
      disc.style.background = colors.leader;
      disc.textContent = (name[0] || "?").toUpperCase();

      const mic = document.createElement("span");
      mic.className = "avatar-mic";
      disc.appendChild(mic);

      const label = document.createElement("span");
      label.className = "avatar-name";
      label.textContent = player.connectionId === myPlayerId ? `${name} (you)` : name;
      label.title = name;

      wrap.appendChild(disc);
      wrap.appendChild(label);
      avatarBarEl.appendChild(wrap);
      avatarEls.set(player.connectionId, { wrap, mic });
    }
  }

  function drawAvatars(state) {
    if (!avatarBarEl) return;
    const players = state?.players ?? [];

    // Rebuild only when the roster itself changes; per-frame work below is
    // limited to class/text flips that are cheap and guarded.
    const key = players
      .map((p) => `${p.connectionId}:${p.displayName}:${p.teamColor}`)
      .join("|");
    if (key !== avatarRosterKey) {
      avatarRosterKey = key;
      rebuildAvatars(players);
    }

    for (const [id, el] of avatarEls) {
      const micOn = VoiceClient.isMicOn(id);
      const speaking = VoiceClient.isSpeaking(id);
      if (el.wrap._micOn !== micOn) {
        el.wrap._micOn = micOn;
        el.wrap.classList.toggle("muted", !micOn);
        el.mic.textContent = micOn ? "🎤" : "🔇";
      }
      if (el.wrap._speaking !== speaking) {
        el.wrap._speaking = speaking;
        el.wrap.classList.toggle("speaking", speaking);
      }
    }

    updateMicButton();
  }

  let lastMicLabel = null;
  let lastVoiceStatus = null;

  function updateMicButton() {
    if (!micBtn) return;
    const live = VoiceClient.isMicLive();
    const label = live ? "Mic On" : "Enable Mic";
    if (label !== lastMicLabel) {
      lastMicLabel = label;
      micLabelEl.textContent = label;
      micIconEl.textContent = live ? "🎤" : "🔇";
      micBtn.classList.toggle("live", live);
    }
    // Playback blocked outranks the mic state: the player is silently deaf and
    // any click fixes it, so tell them that rather than "Mic live".
    const status = VoiceClient.isAudioBlocked()
      ? "Click to enable sound"
      : VoiceClient.getStatus();
    if (voiceStatusEl && status !== lastVoiceStatus) {
      lastVoiceStatus = status;
      voiceStatusEl.textContent = status;
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

  if (micBtn) {
    if (!VoiceClient.isSupported()) {
      micBtn.disabled = true;
      micBtn.title = window.isSecureContext
        ? "Voice chat is not supported in this browser."
        : "Voice chat needs HTTPS (or localhost).";
    }
    micBtn.addEventListener("click", async () => {
      micBtn.disabled = true;
      try {
        await VoiceClient.toggleMic();
      } finally {
        micBtn.disabled = !VoiceClient.isSupported();
        updateMicButton();
      }
    });
  }

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", handleWindowBlur);

  loadImageTextures();
  requestAnimationFrame(draw);
  startConnection().catch((err) => {
    console.error(err);
    setStatus("Unable to connect to server.");
  });
})();
