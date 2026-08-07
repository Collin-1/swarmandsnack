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
  const audioBtn = document.getElementById("audioBtn");
  const audioIconEl = document.getElementById("audioIcon");
  const audioVolumeEl = document.getElementById("audioVolume");

  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  // The canvas is a camera viewport into a larger world; dimensions arrive
  // with each server snapshot (half world with <=4 players, full with more).
  let worldWidth = canvasWidth;
  let worldHeight = canvasHeight;
  let worldRooms = [];
  let worldThickets = [];
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
      if (Array.isArray(payload.thickets)) worldThickets = payload.thickets;

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

      GameAudio.playTrack("victory");

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

    // Music follows the room state. The victory sting is started by the
    // GameOver handler instead, so don't tread on it while a winner stands.
    if (state.isActive) {
      GameAudio.playTrack("match");
    } else if (inLobby) {
      GameAudio.playTrack("lobby");
    }

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
    collideLeaderWithThickets(myLocalLeader);
  }

  // Mirrors ResolveThicketCollisions on the server so the optimistic leader
  // stops at the undergrowth instead of walking in and being pulled back out.
  function collideLeaderWithThickets(leader) {
    for (const thicket of worldThickets) {
      const dx = leader.x - thicket.x;
      const dy = leader.y - thicket.y;
      const minDistance = thicket.radius + LEADER_RADIUS;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDistance * minDistance) continue;

      const dist = Math.sqrt(distSq);
      const nx = dist > 0.0001 ? dx / dist : 1;
      const ny = dist > 0.0001 ? dy / dist : 0;
      leader.x = thicket.x + nx * minDistance;
      leader.y = thicket.y + ny * minDistance;
      const inward = leader.vx * nx + leader.vy * ny;
      if (inward < 0) {
        leader.vx -= nx * inward;
        leader.vy -= ny * inward;
      }
    }
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
  // Axes each texture has to be mirrored on to wrap. See mirroredTile for the
  // measurements behind these.
  //
  // Measured on the current art (wrap-edge delta over interior baseline; 1.0 is
  // a perfect wrap, past ~3 is a visible line):
  //
  //           horizontal   vertical
  //   floor        0.93       1.52     tiles honestly on both axes
  //   wall         1.57       4.42     wraps across, seams top to bottom
  //   cap          1.65        n/a     only ever tiled horizontally
  //
  // So the floor needs no mirroring at all now, which is what removes the
  // symmetry that used to repeat across the deck every two tiles.
  const TEXTURE_MIRROR = {
    wall: { x: false, y: true },
  };
  // Capstones are a lip along the top edge of a wall, foreshortened by the
  // top-down camera rather than shown at their true depth.
  const CAP_BAND_PX = 14;
  const PROP_GRID = 4; // props.png is a 4x4 sheet
  // Sheet cells grouped by where they belong. Scattering everything uniformly
  // reads as litter; in the reference art scenery crowds the stonework and open
  // floor stays almost clear.
  const PROP_BANNERS = [9, 10, 11]; // hung on wall faces
  // Crystal formation, plasma bloom, conduit tangle. Used only for thickets,
  // which are solid, so a glowing mass reliably means "impassable".
  const PROP_FOLIAGE = [3, 4, 5];
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

  // Deck plating: regular panels with recessed seams and dim power lines
  // routed through them. Panels sit on an exact grid so the tile wraps.
  function buildFloorTexture(size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");

    const panel = size / 4;
    g.fillStyle = "#0a0f18";
    g.fillRect(0, 0, size, size);

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        // Deterministic per-panel tone so the variation tiles with the grid.
        const n = ((row * 7 + col * 13) % 5) / 5;
        const shade = 22 + n * 10;
        g.fillStyle = `rgb(${shade - 4},${shade + 2},${shade + 12})`;
        g.fillRect(col * panel + 1.5, row * panel + 1.5, panel - 3, panel - 3);

        // Lit top-left inner edge, shaded bottom-right: shallow relief only.
        g.fillStyle = "rgba(150, 200, 255, 0.05)";
        g.fillRect(col * panel + 1.5, row * panel + 1.5, panel - 3, 1.5);
        g.fillStyle = "rgba(0, 0, 0, 0.35)";
        g.fillRect(col * panel + 1.5, (row + 1) * panel - 3, panel - 3, 1.5);

        // Fasteners at the panel corners.
        g.fillStyle = "rgba(120, 160, 200, 0.16)";
        for (const [fx, fy] of [[9, 9], [panel - 9, 9], [9, panel - 9], [panel - 9, panel - 9]]) {
          g.beginPath();
          g.arc(col * panel + fx, row * panel + fy, 1.8, 0, Math.PI * 2);
          g.fill();
        }
      }
    }

    // Power conduits inset into some seams. Kept dim and spread evenly: a
    // bright run would repeat like wallpaper once the tile is laid out.
    g.strokeStyle = "rgba(56, 189, 248, 0.16)";
    g.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      if (i % 2 === 0) {
        g.beginPath();
        g.moveTo(0, i * panel);
        g.lineTo(size, i * panel);
        g.stroke();
      } else {
        g.beginPath();
        g.moveTo(i * panel, 0);
        g.lineTo(i * panel, size);
        g.stroke();
      }
    }

    // Fine brushed grain.
    for (let i = 0; i < 2400; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const light = Math.random() < 0.5;
      g.fillStyle = light
        ? `rgba(150,190,230,${0.02 + Math.random() * 0.03})`
        : `rgba(0,0,0,${0.03 + Math.random() * 0.05})`;
      g.fillRect(x, y, 1 + Math.random() * 2, 1);
    }
    return canvas;
  }

  // Bulkhead seen from above: armoured segments divided by recessed channels
  // with power routed along them.
  function buildWallTexture(size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");

    const rows = 6;
    const cols = 4;
    const segH = size / rows;
    const segW = size / cols;

    g.fillStyle = "#080d14"; // channel colour showing between segments
    g.fillRect(0, 0, size, size);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const n = ((row * 5 + col * 11) % 4) / 4;
        const shade = 26 + n * 9;
        const x = col * segW + 2.5;
        const y = row * segH + 2.5;
        const w = segW - 5;
        const h = segH - 5;

        g.fillStyle = `rgb(${shade - 6},${shade},${shade + 10})`;
        g.fillRect(x, y, w, h);

        g.fillStyle = "rgba(150, 200, 255, 0.07)";
        g.fillRect(x, y, w, 2);
        g.fillStyle = "rgba(0, 0, 0, 0.4)";
        g.fillRect(x, y + h - 2, w, 2);

        // Vent slots on some segments.
        if ((row + col) % 3 === 0) {
          g.fillStyle = "rgba(0, 0, 0, 0.35)";
          for (let v = 0; v < 3; v++) {
            g.fillRect(x + w * 0.25, y + h * 0.3 + v * 5, w * 0.5, 2);
          }
        }

        // Fasteners.
        g.fillStyle = "rgba(130, 170, 210, 0.18)";
        for (const [fx, fy] of [[6, 6], [w - 6, 6], [6, h - 6], [w - 6, h - 6]]) {
          g.beginPath();
          g.arc(x + fx, y + fy, 1.6, 0, Math.PI * 2);
          g.fill();
        }
      }
    }

    // Energy running along the horizontal channels.
    g.strokeStyle = "rgba(56, 189, 248, 0.3)";
    g.lineWidth = 1.5;
    for (let row = 1; row < rows; row++) {
      g.beginPath();
      g.moveTo(0, row * segH);
      g.lineTo(size, row * segH);
      g.stroke();
    }
    return canvas;
  }

  function ensureTextures() {
    if (!textureSources.floor) textureSources.floor = buildFloorTexture(512);
    if (!textureSources.wall) textureSources.wall = buildWallTexture(256);
  }

  /**
   * Builds a tile that wraps on the requested axes by mirroring: a tile
   * followed by a flipped copy of itself always meets seamlessly, because each
   * boundary places identical rows or columns side by side.
   *
   * Measured on the shipped art, wrap difference against interior variation
   * (1.0 is a perfect wrap, anything past ~3 is a visible line):
   *   floor.png  horizontal 1.1 (fine)   vertical 12.0 (seam)
   *   wall.png   horizontal 7.6 (seam)   vertical 11.3 (seam)
   * So the floor only needs mirroring vertically, while the wall needs both.
   * The cost is mirror symmetry every two tiles, which on subtle plating reads
   * as nothing at all, unlike a bright line every 512px.
   */
  function mirroredTile(source, mirrorX, mirrorY) {
    if (!mirrorX && !mirrorY) return source;
    const w = source.width;
    const h = source.height;
    const canvas = document.createElement("canvas");
    canvas.width = mirrorX ? w * 2 : w;
    canvas.height = mirrorY ? h * 2 : h;
    const ctx = canvas.getContext("2d");

    const stamp = (flipX, flipY) => {
      ctx.save();
      ctx.translate(flipX ? w * 2 : 0, flipY ? h * 2 : 0);
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      ctx.drawImage(source, 0, 0);
      ctx.restore();
    };

    stamp(false, false);
    if (mirrorX) stamp(true, false);
    if (mirrorY) stamp(false, true);
    if (mirrorX && mirrorY) stamp(true, true);
    return canvas;
  }

  function makePattern(ctx, source, scale, mirror) {
    const tile = mirror
      ? mirroredTile(source, !!mirror.x, !!mirror.y)
      : source;
    const pattern = ctx.createPattern(tile, "repeat");
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

  // Only the image art needs mirroring; the procedural fallbacks already wrap.
  function mirrorFor(key) {
    return textureSources[key] instanceof HTMLImageElement ? TEXTURE_MIRROR[key] : null;
  }

  function getFloorPattern(ctx) {
    ensureTextures();
    if (!floorPattern) {
      floorPattern = makePattern(ctx, textureSources.floor, scaleFor("floor"), mirrorFor("floor"));
    }
    return floorPattern;
  }

  function getWallPattern(ctx) {
    ensureTextures();
    if (!wallPattern) {
      wallPattern = makePattern(ctx, textureSources.wall, scaleFor("wall"), mirrorFor("wall"));
    }
    return wallPattern;
  }

  // ---- Wall capstones -----------------------------------------------------

  let capPattern = null;

  /**
   * The cap is mirrored before use: a tile followed by a flipped copy of itself
   * always meets seamlessly at both joins, because each boundary puts identical
   * columns side by side. The result repeats over twice the width, which for a
   * 14px lip is not readable as symmetry.
   *
   * The current art measures 1.65 across the horizontal wrap, which is nearly
   * clean enough to use as-is. It stays mirrored anyway because the cap's
   * brightest feature is a continuous lit strip running its whole length, and a
   * break in that is far more noticeable than symmetry in the dark ribs around
   * it. The mirror costs nothing here; a visible join would cost a lot.
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
  function drawProps(sctx, obstacles, roomRects) {
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
        grad.addColorStop(0, "rgba(56, 189, 248, 0.28)");
        grad.addColorStop(1, "rgba(56, 189, 248, 0)");
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
        for (let t = 26; t < side.len - 18; t += 58) {
          if (random() > 0.56) continue;
          const jitter = (random() - 0.5) * 30;
          const [bx, by] = side.at(t + jitter);
          // Only hard equipment is stood against walls. The glowing growth is
          // reserved for thickets, which are solid: keeping the two apart means
          // a glowing mass always means "you cannot walk through this", and
          // keeps bright cyan away from the cyan player token.
          const count = 1;
          for (let i = 0; i < count; i++) {
            const sprite = pick(PROP_CLUTTER);
            const size = cell * 0.38 * (0.75 + random() * 0.5);
            const away = size * (0.42 + random() * 0.34);
            const slide = (random() - 0.5) * size * 1.2;
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
          const sprite = pick(PROP_CLUTTER);
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

    // --- thickets: vegetation grown into masses, not spaced singles ---
    //
    // A bush every N pixels reads as a row of separate objects. Real
    // undergrowth clumps: dense in the middle, ragged at the fringe, with the
    // sprites overlapping into one canopy. Each thicket picks a centre in open
    // ground and grows outward from it.
    const drawRotated = (sprite, cx, cy, size, rot) => {
      sctx.save();
      sctx.translate(cx, cy);
      if (rot) sctx.rotate(rot);
      sctx.drawImage(
        img, sprite.sx, sprite.sy, sprite.size, sprite.size,
        -size / 2, -size / 2, size, size,
      );
      sctx.restore();
    };

    // Thickets are level geometry now: the server owns their positions and
    // collides against their solid cores, so the client grows the canopy around
    // what it is told rather than inventing its own.
    const canopy = [];
    for (const thicket of worldThickets) {
      const cx0 = thicket.x;
      const cy0 = thicket.y;
      const rx = thicket.radiusX;
      const ry = thicket.radiusY;
      // Seeded per thicket so the same bushes grow every rebuild.
      const grow = seededRandom(thicket.seed >>> 0);

      // Shade on the ground so the mass sits in the world rather than floating.
      const shade = sctx.createRadialGradient(
        cx0, cy0 + ry * 0.2, 0, cx0, cy0 + ry * 0.2, Math.max(rx, ry) * 1.15,
      );
      shade.addColorStop(0, "rgba(18, 26, 12, 0.45)");
      shade.addColorStop(1, "rgba(18, 26, 12, 0)");
      sctx.fillStyle = shade;
      sctx.fillRect(cx0 - rx * 1.5, cy0 - ry * 1.5, rx * 3, ry * 3);

      const clumps = 26 + ((grow() * 22) | 0);
      for (let i = 0; i < clumps; i++) {
        // Averaging two samples biases toward the centre, so density falls off
        // outward and the silhouette stays irregular. Squaring it packs the
        // solid core tightly enough that it reads as impassable.
        const angle = grow() * Math.PI * 2;
        const spread = Math.pow((grow() + grow()) / 2, 1.35);
        const px = cx0 + Math.cos(angle) * rx * spread;
        const py = cy0 + Math.sin(angle) * ry * spread;
        if (overlapsWall(px, py, 8, obstacles)) continue;
        canopy.push({
          sprite: sprites[PROP_FOLIAGE[(grow() * PROP_FOLIAGE.length) | 0]],
          px,
          py,
          // Biggest at the core, smaller toward the edge.
          size: cell * (0.32 + (1 - spread) * 0.28) * (0.85 + grow() * 0.4),
          rot: (grow() - 0.5) * 0.55,
        });
      }
    }
    // Back to front, so overlapping foliage layers instead of fighting.
    canopy.sort((a, b) => a.py - b.py);
    for (const leaf of canopy) drawRotated(leaf.sprite, leaf.px, leaf.py, leaf.size, leaf.rot);

    // --- rocks in scree piles rather than lone pebbles ---
    const screeTarget = Math.round((worldWidth * worldHeight) / 620000);
    let scree = 0;
    for (let attempt = 0; scree < screeTarget && attempt < screeTarget * 30; attempt++) {
      const cx0 = 70 + random() * (worldWidth - 140);
      const cy0 = 70 + random() * (worldHeight - 140);
      if (insideAnyRoom(cx0, cy0, roomRects, 20)) continue;
      if (overlapsWall(cx0, cy0, 70, obstacles)) continue;
      scree++;
      const stones = 3 + ((random() * 5) | 0);
      for (let i = 0; i < stones; i++) {
        const size = cell * 0.3 * (0.6 + random() * 0.7);
        place(
          pick(PROP_ROCKS),
          cx0 + (random() - 0.5) * 96,
          cy0 + (random() - 0.5) * 74,
          size,
        );
      }
    }
  }

  function insideAnyRoom(x, y, rooms, margin) {
    if (!rooms) return false;
    for (const r of rooms) {
      if (
        x > r.x - margin && x < r.x + r.width + margin &&
        y > r.y - margin && y < r.y + r.height + margin
      ) {
        return true;
      }
    }
    return false;
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
    const signature = `${worldWidth}x${worldHeight}:${serverState.obstacles?.length ?? 0}:${worldRooms.length}:${worldThickets.length}`;
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
    lit.addColorStop(0, "rgba(70, 130, 180, 0.15)");
    lit.addColorStop(0.55, "rgba(30, 60, 96, 0.08)");
    lit.addColorStop(1, "rgba(0, 0, 0, 0.45)");
    sctx.fillStyle = lit;
    sctx.fillRect(0, 0, worldWidth, worldHeight);

    if (SHOW_HEX_OVERLAY) {
      drawHexFloor(sctx);
    }

    const obstacles = serverState.obstacles ?? [];

    drawRoomFloors(sctx, worldRooms);

    // Scenery goes down before the stone, so anything close to a wall is
    // occluded by it rather than sitting on top.
    drawProps(sctx, obstacles, worldRooms);

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

  // ---- Creatures ---------------------------------------------------------
  //
  // At 36px for a leader and 24px for an underling, illustrated detail is
  // invisible but motion reads instantly, so the liveliness is all animation:
  // eyes that lead the direction of travel, stretch along velocity, an idle
  // bob, a thruster flare while under way, and a reaction when something gets eaten.
  //
  // Everything here is derived from vx/vy already in the snapshot, so none of
  // it costs the server anything.

  /** id -> { lookX, lookY, phase, pop } */
  const creatureAnim = new Map();
  const eatBursts = [];
  let animPruneCounter = 0;

  // id -> { x, y, colour, frame }. Entries are mutated in place and stamped with
  // the frame that last saw them, rather than rebuilding a map of fresh objects
  // every frame — at eight players that would be forty allocations per frame.
  const underlingTrack = new Map();
  let creatureFrame = 0;

  // Stable per-entity phase so creatures don't all breathe in unison.
  function phaseFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
  }

  function animFor(id) {
    let a = creatureAnim.get(id);
    if (!a) {
      a = { lookX: 0, lookY: 1, phase: phaseFor(id), pop: 0 };
      creatureAnim.set(id, a);
    }
    return a;
  }

  // ---- Creature sprites ---------------------------------------------------
  //
  // The dock art is rendered with real lighting, so flat filled discs sat on top
  // of it looking like stickers. These creatures need volume: a light-side
  // falloff, a rim catch on the dark side, a specular, and a shadow on the deck.
  //
  // Doing that per entity per frame would mean rebuilding four gradients for
  // each of up to 48 creatures. Instead each appearance is baked once into an
  // offscreen canvas — eight team colours times leader and underling is sixteen
  // sprites for the whole game — and the frame just blits one. That is fewer
  // canvas operations than the flat version it replaces.
  // A creature is two baked layers, and they are split because they need
  // opposite things from the transform:
  //
  //   shell — dark armour plates with glowing slots. Part of the character's
  //           orientation, so it ROTATES to face travel. Kept deliberately flat
  //           and low contrast; the glowing slots are what should read as
  //           turning, not a shading gradient sweeping round the plates.
  //   orb   — the glossy lit body. Its highlight has to stay lit from the upper
  //           left like every crate in the dock, so it does NOT rotate.
  //
  // Baking both means a frame is two drawImage calls per creature instead of a
  // dozen gradient rebuilds.
  const SPRITE_BAKE_RADIUS = 48; // generous, so downscaling to 12-24px stays crisp
  const SPRITE_GLOW_SCALE = 1.7;
  const ORB_RATIO = 0.74;        // orb sits nested inside the shell ring
  const creatureSprites = new Map();

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /** amount > 0 lifts toward white, < 0 sinks toward black. */
  function shade(hex, amount) {
    const [r, g, b] = hexToRgb(hex);
    const t = amount > 0 ? 255 : 0;
    const k = Math.abs(amount);
    return `rgb(${Math.round(r + (t - r) * k)},${Math.round(g + (t - g) * k)},${Math.round(b + (t - b) * k)})`;
  }
  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function blankSprite() {
    const half = Math.ceil(SPRITE_BAKE_RADIUS * SPRITE_GLOW_SCALE);
    const c = document.createElement("canvas");
    c.width = c.height = half * 2;
    const g = c.getContext("2d");
    g.translate(half, half);
    return { canvas: c, g, half };
  }

  // The glossy body. Keyed on the colour itself rather than the team name, so
  // the caller can pass the palette entry it already has.
  function orbSprite(base, isLeader) {
    const key = `orb|${base}|${isLeader ? "L" : "U"}`;
    const cached = creatureSprites.get(key);
    if (cached) return cached;

    const { canvas, g } = blankSprite();
    const R = SPRITE_BAKE_RADIUS * ORB_RATIO;

    // No bloom here — it lives in the shell sprite, which is drawn first. Baking
    // it into the orb painted the glow straight over the armour plates and
    // washed the shell out to a faint ring.

    // Body. Light comes from the upper left, same as the crates and drums.
    const body = g.createRadialGradient(-R * 0.34, -R * 0.4, R * 0.1, 0, 0, R);
    body.addColorStop(0, shade(base, 0.28));
    body.addColorStop(0.45, base);
    body.addColorStop(1, shade(base, -0.5));
    g.fillStyle = body;
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();

    // Rim light on the shadow side. This is what actually reads as roundness —
    // without it a gradient alone still looks like a flat disc.
    g.save();
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.clip();
    const rim = g.createLinearGradient(-R, -R, R, R);
    rim.addColorStop(0, rgba(base, 0));
    rim.addColorStop(0.6, rgba(base, 0));
    rim.addColorStop(1, shade(base, 0.5));
    g.strokeStyle = rim;
    g.lineWidth = R * 0.17;
    g.beginPath();
    g.arc(0, 0, R * 0.93, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    // A broad soft sheen rather than a tight wet highlight. The hard specular
    // this replaces made the creatures look like polished glass against a dock
    // built from matte plate. Wide, dim, and falling off early keeps the sense
    // of a curved surface without the shine.
    const spec = g.createRadialGradient(-R * 0.34, -R * 0.4, 0, -R * 0.34, -R * 0.4, R * 0.55);
    spec.addColorStop(0, "rgba(255,255,255,0.26)");
    spec.addColorStop(0.45, "rgba(255,255,255,0.09)");
    spec.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = spec;
    g.beginPath();
    g.ellipse(-R * 0.34, -R * 0.4, R * 0.5, R * 0.36, -0.6, 0, Math.PI * 2);
    g.fill();

    creatureSprites.set(key, canvas);
    return canvas;
  }

  // The armour shell: dark segmented plates around the orb with lit slots set
  // into them. Baked with the front pointing along +X, and rotated to face
  // travel at draw time.
  //
  // The slots glow in the team colour rather than a fixed accent hue. The
  // reference art pairs cyan with magenta, but a fixed second hue collides with
  // half of an eight-colour roster — magenta trim on the fuchsia and rose teams
  // reads as a different player. The forward slot is instead brightened toward
  // white, which gives the same two-tone look and still marks which way the
  // creature is pointing.
  function shellSprite(base, isLeader) {
    const key = `shell|${base}|${isLeader ? "L" : "U"}`;
    const cached = creatureSprites.get(key);
    if (cached) return cached;

    const { canvas, g } = blankSprite();
    const R = SPRITE_BAKE_RADIUS;
    const outer = R * 0.99;
    const inner = R * 0.68;
    const mid = (outer + inner) / 2;
    const thickness = outer - inner;

    // Emissive bloom goes down first, so it haloes the whole creature from
    // behind instead of painting over the plates.
    const glow = g.createRadialGradient(0, 0, R * 0.8, 0, 0, R * SPRITE_GLOW_SCALE);
    glow.addColorStop(0, rgba(base, isLeader ? 0.38 : 0.28));
    glow.addColorStop(1, rgba(base, 0));
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0, 0, R * SPRITE_GLOW_SCALE, 0, Math.PI * 2);
    g.fill();

    const plates = isLeader ? 6 : 4;
    const gap = isLeader ? 0.16 : 0.24; // radians of bare space between plates
    const step = (Math.PI * 2) / plates;

    // Plates. Near-flat dark metal: any strong shading here would sweep around
    // the ring as the creature turns and fight the fixed lighting on the orb.
    // Light enough to stay legible against both the deck and the bloom.
    g.lineCap = "butt";
    g.lineWidth = thickness;
    for (let i = 0; i < plates; i++) {
      const centre = i * step;
      const plate = g.createLinearGradient(0, -outer, 0, outer);
      plate.addColorStop(0, "#33425c");
      plate.addColorStop(0.5, "#1d2942");
      plate.addColorStop(1, "#0d1526");
      g.strokeStyle = plate;
      g.beginPath();
      g.arc(0, 0, mid, centre - step / 2 + gap / 2, centre + step / 2 - gap / 2);
      g.stroke();
    }

    // Dark seat under the orb so the plates read as sitting behind it.
    g.fillStyle = "#080d16";
    g.beginPath();
    g.arc(0, 0, inner + thickness * 0.12, 0, Math.PI * 2);
    g.fill();

    // Lit slots. Front is hottest so facing is unmistakable at 24px.
    const slots = isLeader
      ? [{ a: 0, w: 0.30, hot: 0.75 }, { a: Math.PI * 0.62, w: 0.22, hot: 0.15 },
         { a: -Math.PI * 0.62, w: 0.22, hot: 0.15 }, { a: Math.PI, w: 0.18, hot: -0.1 }]
      : [{ a: 0, w: 0.30, hot: 0.6 }, { a: Math.PI * 0.7, w: 0.2, hot: 0.05 },
         { a: -Math.PI * 0.7, w: 0.2, hot: 0.05 }];

    g.lineCap = "round";
    for (const slot of slots) {
      g.save();
      g.shadowColor = rgba(base, 0.9);
      g.shadowBlur = R * 0.3;
      g.strokeStyle = shade(base, slot.hot);
      g.lineWidth = thickness * 0.42;
      g.beginPath();
      g.arc(0, 0, mid, slot.a - slot.w / 2, slot.a + slot.w / 2);
      g.stroke();
      // Second pass without blur keeps the core of the slot crisp.
      g.shadowBlur = 0;
      g.stroke();
      g.restore();
    }

    // Outline, so the silhouette holds against a busy deck.
    g.strokeStyle = "rgba(2,6,16,0.7)";
    g.lineWidth = R * 0.05;
    g.beginPath();
    g.arc(0, 0, outer, 0, Math.PI * 2);
    g.stroke();

    creatureSprites.set(key, canvas);
    return canvas;
  }

  function drawCreature(entity, anim, colors, isLeader, time, seconds) {
    const speed = Math.hypot(entity.vx || 0, entity.vy || 0);

    // Ease the gaze toward travel so eyes swing rather than snap, and hold the
    // last direction when stopped instead of resetting.
    if (speed > 4) {
      const nx = entity.vx / speed;
      const ny = entity.vy / speed;
      const ease = Math.min(1, seconds * 9);
      anim.lookX += (nx - anim.lookX) * ease;
      anim.lookY += (ny - anim.lookY) * ease;
    }
    const lookLen = Math.hypot(anim.lookX, anim.lookY) || 1;
    const lx = anim.lookX / lookLen;
    const ly = anim.lookY / lookLen;

    // Idle bob when still, faster pulse when moving.
    const bob = Math.sin(time / (speed > 4 ? 120 : 420) + anim.phase) * (isLeader ? 1.6 : 0.9);
    const radius = entity.radius + bob + anim.pop;

    // Stretch along the direction of travel, squashing across it. Kept subtle
    // now that the body wears a rigid armour shell — the heavier squash that
    // suited a soft blob made the plated ring read as a flattened hoop.
    const stretch = Math.min(0.1, (speed / LEADER_SPEED) * 0.1);
    const rx = radius * (1 + stretch);
    const ry = radius * (1 - stretch * 0.75);
    const angle = Math.atan2(ly, lx);

    // Contact shadow. Everything in the dock casts one, and without it the
    // creatures read as floating above the deck rather than standing on it.
    // Offset down-right, away from the upper-left key light baked into the body.
    ctx.save();
    ctx.globalAlpha = isLeader ? 0.34 : 0.26;
    ctx.fillStyle = "#01040a";
    ctx.beginPath();
    ctx.ellipse(entity.x + radius * 0.14, entity.y + radius * 0.2,
                rx * 0.94, ry * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const base = isLeader ? colors.leader : colors.underling;
    const shell = shellSprite(base, isLeader);
    const orb = orbSprite(base, isLeader);
    const half = shell.width / 2;
    const k = radius / SPRITE_BAKE_RADIUS;
    const sx = k * (1 + stretch);
    const sy = k * (1 - stretch * 0.75);

    // Thruster wash trailing the shell while under way, as in the move state of
    // the reference sheet. Fades out entirely when idle so a parked creature is
    // a clean silhouette.
    const thrust = Math.min(1, speed / LEADER_SPEED);
    if (thrust > 0.15) {
      ctx.save();
      ctx.translate(entity.x, entity.y);
      ctx.rotate(angle);
      ctx.globalAlpha = thrust * (isLeader ? 0.5 : 0.38);
      const flare = ctx.createLinearGradient(-radius * 0.7, 0, -radius * 2.4, 0);
      flare.addColorStop(0, rgba(base, 0.85));
      flare.addColorStop(1, rgba(base, 0));
      ctx.fillStyle = flare;
      ctx.beginPath();
      ctx.moveTo(-radius * 0.7, -radius * 0.5);
      ctx.lineTo(-radius * (1.3 + thrust * 1.1), 0);
      ctx.lineTo(-radius * 0.7, radius * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Shell rotates: which way the armour points IS the character facing.
    ctx.save();
    ctx.translate(entity.x, entity.y);
    ctx.rotate(angle);
    ctx.scale(sx, sy);
    ctx.drawImage(shell, -half, -half);
    ctx.restore();

    // Orb does not. Composing R·S·R⁻¹ stretches the silhouette along the
    // direction of travel exactly as R·S would, but leaves the sprite's content
    // screen-aligned — so the baked highlight and rim stay lit from the upper
    // left like everything else in the dock, instead of swinging around the body
    // as the creature turns.
    ctx.save();
    ctx.translate(entity.x, entity.y);
    ctx.rotate(angle);
    ctx.scale(sx, sy);
    ctx.rotate(-angle);
    ctx.drawImage(orb, -half, -half);
    ctx.restore();

    // Eyes are drawn unrotated so they stay upright, offset toward the way the
    // creature is heading. Sized against the orb rather than the whole creature,
    // since the shell now takes the outer quarter of the radius.
    const orbR = radius * ORB_RATIO;
    const eyeR = orbR * (isLeader ? 0.46 : 0.55);
    const ex = entity.x + lx * orbR * 0.32;
    const ey = entity.y + ly * orbR * 0.32;

    ctx.save();

    // Socket: a dark ring so the eye sits in the body rather than on it.
    ctx.fillStyle = "rgba(3,8,18,0.5)";
    ctx.beginPath();
    ctx.arc(ex, ey, eyeR * 1.16, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f4f8ff";
    ctx.beginPath();
    ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#0b1020";
    ctx.beginPath();
    ctx.arc(ex + lx * eyeR * 0.34, ey + ly * eyeR * 0.34, eyeR * 0.46, 0, Math.PI * 2);
    ctx.fill();

    // Catchlight, on the same upper-left key light as the body sheen. Kept
    // brighter than the body highlight on purpose — a live eye needs it, and at
    // this size it is only a couple of pixels.
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.beginPath();
    ctx.arc(ex - eyeR * 0.34, ey - eyeR * 0.4, eyeR * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawEntities(state) {
    if (!state || !state.players) {
      return;
    }

    const time = performance.now();
    const seconds = Math.min(0.05, (time - lastCreatureFrame) / 1000);
    lastCreatureFrame = time;

    const seen = new Set();
    creatureFrame++;

    // The leader wake that used to be drawn here is gone. It sampled positions
    // once a frame and drew a circle at each, which read as a string of discrete
    // beads behind a moving leader — fine behind a plain disc, but obviously
    // wrong next to the thruster flare the shell now emits. The flare carries
    // the sense of speed on its own.

    for (const player of state.players) {
      const colors = paletteFor(player.teamColor);

      for (const underling of player.underlings) {
        seen.add(underling.id);
        trackUnderling(underling, colors.underling);
        const anim = animFor(underling.id);
        anim.pop *= 0.86;
        drawCreature(underling, anim, colors, false, time, seconds);
      }

      seen.add(player.leader.id);
      const anim = animFor(player.leader.id);
      anim.pop *= 0.82;
      drawCreature(player.leader, anim, colors, true, time, seconds);
    }

    detectEatBursts(state);
    drawEatBursts(seconds);

    // Keep the animation table from growing across matches.
    if (++animPruneCounter > 120) {
      animPruneCounter = 0;
      for (const id of creatureAnim.keys()) {
        if (!seen.has(id)) creatureAnim.delete(id);
      }
    }
  }

  let lastCreatureFrame = performance.now();

  function onScreen(x, y) {
    return x >= camera.x && x <= camera.x + canvasWidth
      && y >= camera.y && y <= camera.y + canvasHeight;
  }

  function trackUnderling(underling, colour) {
    let entry = underlingTrack.get(underling.id);
    if (!entry) {
      entry = { x: 0, y: 0, colour, frame: 0 };
      underlingTrack.set(underling.id, entry);
    }
    entry.x = underling.x;
    entry.y = underling.y;
    entry.colour = colour;
    entry.frame = creatureFrame;
  }

  // An underling that was on screen last frame and is gone now was eaten.
  // Burst where it died and pop whichever leader is closest, which is the one
  // that took it.
  //
  // Two things that are not an eat can also empty ids out of the roster: the
  // lobby-to-battle handover replaces every underling at once, and a player
  // leaving takes their whole swarm. Both were measured firing a screenful of
  // bursts. Eating is inherently one-at-a-time and happens in contact, so a
  // vanish only counts when the frame is otherwise calm and a leader is on top
  // of it.
  const MAX_EATS_PER_FRAME = 2;
  const EAT_REACH = 90;

  function detectEatBursts(state) {
    let gone = 0;
    for (const entry of underlingTrack.values()) {
      if (entry.frame !== creatureFrame) gone++;
    }
    if (!gone) return;

    // Too many at once to be eating — forget them without any fanfare.
    const bulk = gone > MAX_EATS_PER_FRAME;

    for (const [id, entry] of underlingTrack) {
      if (entry.frame === creatureFrame) continue;
      underlingTrack.delete(id);
      if (bulk) continue;

      let best = null;
      let bestDist = EAT_REACH * EAT_REACH;
      for (const player of state.players) {
        const dx = player.leader.x - entry.x;
        const dy = player.leader.y - entry.y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = player.leader.id; }
      }
      if (!best) continue;
      eatBursts.push({ x: entry.x, y: entry.y, colour: entry.colour, age: 0 });
      animFor(best).pop = 5;

      // Only sound off for kills you can actually see. Eight players eating
      // across a 2880x1920 map would otherwise be a constant chatter of chomps
      // for things happening off screen.
      if (onScreen(entry.x, entry.y)) GameAudio.eat();
    }
  }

  function drawEatBursts(seconds) {
    ctx.save();
    for (let i = eatBursts.length - 1; i >= 0; i--) {
      const burst = eatBursts[i];
      burst.age += seconds;
      const t = burst.age / 0.42;
      if (t >= 1) { eatBursts.splice(i, 1); continue; }
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = burst.colour;
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(burst.x, burst.y, 8 + t * 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
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

  function updateAudioButton() {
    if (!audioBtn) return;
    const muted = GameAudio.isMuted();
    const icon = muted ? "🔇" : "🔊";
    if (audioIconEl && audioIconEl.textContent !== icon) audioIconEl.textContent = icon;
    audioBtn.classList.toggle("muted", muted);
    audioBtn.title = muted ? "Unmute game audio" : "Mute game audio";
  }

  if (audioBtn) {
    audioBtn.addEventListener("click", () => {
      GameAudio.toggleMute();
      updateAudioButton();
    });
  }
  if (audioVolumeEl) {
    audioVolumeEl.value = String(Math.round(GameAudio.getVolume() * 100));
    audioVolumeEl.addEventListener("input", () => {
      GameAudio.setVolume(Number(audioVolumeEl.value) / 100);
      updateAudioButton();
    });
  }
  GameAudio.onChange(updateAudioButton);
  updateAudioButton();

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
