/**
 * Peer-to-peer voice chat over WebRTC, with SignalR used only as the
 * signalling channel (offers/answers/ICE are relayed by GameHub).
 *
 * Topology: full mesh — every player holds one RTCPeerConnection per other
 * player. That needs no media server, but upstream bandwidth grows with the
 * player count (7 outbound audio streams in a full 8-player room). If that
 * becomes a problem, the swap is contained: replace the peer bookkeeping in
 * this file with a single connection to an SFU; the UI and game code only
 * talk to the small API exposed at the bottom.
 */
(() => {
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // Speaking-indicator tuning.
  const LEVEL_POLL_MS = 100;
  const SPEAKING_THRESHOLD = 0.02; // RMS of the normalised waveform
  const SPEAKING_HANGOVER_MS = 350; // keep the ring lit briefly between words

  let connection = null;
  let selfId = null;
  let attached = false;

  /** peerId -> { pc, sender, audioEl, analyser, buffer, pendingIce, speakingUntil } */
  const peers = new Map();
  /** peerId -> boolean (their announced mic state) */
  const remoteMic = new Map();

  let localStream = null;
  let micTrack = null;
  let micOn = false;
  let micRequested = false;
  let statusText = "Voice off";

  let audioCtx = null;
  let localAnalyser = null;
  let localBuffer = null;
  let localSpeakingUntil = 0;
  let levelTimer = null;

  let audioSink = null;
  // True when the browser refused to start playback because the page has no
  // user activation yet. Joining by invite link is exactly this case: the join
  // is a programmatic click, so a player can be arriving into a call before
  // they have ever interacted with the page.
  let audioBlocked = false;

  function log(...args) {
    if (window.VOICE_DEBUG) console.log("[voice]", ...args);
  }

  function getAudioSink() {
    if (!audioSink) {
      audioSink = document.createElement("div");
      audioSink.id = "voiceAudioSink";
      audioSink.style.display = "none";
      document.body.appendChild(audioSink);
    }
    return audioSink;
  }

  function getAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    // Browsers start the context suspended until a user gesture.
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  /** Starts playback, remembering if the browser refuses. */
  function playRemoteAudio(el) {
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => {
        audioBlocked = true;
      });
    }
  }

  /**
   * Retries anything the autoplay policy previously refused. Safe to call on
   * every user gesture: it returns immediately once nothing is blocked.
   */
  function resumeAudioPlayback() {
    const contextSuspended = audioCtx && audioCtx.state === "suspended";
    if (!audioBlocked && !contextSuspended) {
      return;
    }

    if (contextSuspended) {
      audioCtx.resume().catch(() => {});
    }

    audioBlocked = false;
    for (const peer of peers.values()) {
      if (peer.audioEl && peer.audioEl.paused) {
        playRemoteAudio(peer.audioEl);
      }
    }
  }

  function attachAnalyser(stream) {
    const ctx = getAudioContext();
    if (!ctx) return null;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  function rms(analyser, buffer) {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = (buffer[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buffer.length);
  }

  function startLevelPolling() {
    if (levelTimer) return;
    levelTimer = setInterval(() => {
      const now = performance.now();

      if (localAnalyser && micOn) {
        if (rms(localAnalyser, localBuffer) > SPEAKING_THRESHOLD) {
          localSpeakingUntil = now + SPEAKING_HANGOVER_MS;
        }
      }

      for (const peer of peers.values()) {
        if (!peer.analyser) continue;
        if (rms(peer.analyser, peer.buffer) > SPEAKING_THRESHOLD) {
          peer.speakingUntil = now + SPEAKING_HANGOVER_MS;
        }
      }
    }, LEVEL_POLL_MS);
  }

  function stopLevelPolling() {
    if (levelTimer) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
  }

  function sendSignal(peerId, message) {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    connection
      .invoke("SendVoiceSignal", peerId, JSON.stringify(message))
      .catch((err) => log("signal send failed", err));
  }

  // Deterministic roles avoid glare: the lexicographically smaller id offers.
  function isInitiator(peerId) {
    return String(selfId) < String(peerId);
  }

  function createPeer(peerId) {
    const existing = peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Only the offerer declares the transceiver up front: a transceiver created
    // locally is reserved for an m-line *we* offer, so on the answering side it
    // would be left dangling while the remote offer spawns its own (recvonly)
    // one. The answerer adopts that transceiver in handleSignal instead.
    const transceiver = isInitiator(peerId)
      ? pc.addTransceiver("audio", { direction: "sendrecv" })
      : null;

    const peer = {
      pc,
      sender: transceiver ? transceiver.sender : null,
      audioEl: null,
      analyser: null,
      buffer: null,
      pendingIce: [],
      speakingUntil: 0,
      negotiating: false,
    };
    peers.set(peerId, peer);

    if (micTrack && peer.sender) peer.sender.replaceTrack(micTrack).catch(() => {});

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, { type: "ice", candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      // replaceTrack sends no msid, so event.streams is empty here; wrap the
      // bare track in a stream of our own for playback and level metering.
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (!peer.audioEl) {
        const el = document.createElement("audio");
        el.autoplay = true;
        el.playsInline = true;
        getAudioSink().appendChild(el);
        peer.audioEl = el;
      }
      peer.audioEl.srcObject = stream;
      playRemoteAudio(peer.audioEl);
      peer.analyser = attachAnalyser(stream);
      peer.buffer = peer.analyser ? new Uint8Array(peer.analyser.fftSize) : null;
      startLevelPolling();
      log("track from", peerId);
    };

    pc.onconnectionstatechange = () => {
      log(peerId, pc.connectionState);
      if (pc.connectionState === "failed") {
        // Most often a transient network change; a fresh connection is more
        // reliable than trying to repair this one.
        removePeer(peerId);
        if (peers.size < 64) createPeer(peerId);
      }
    };

    if (isInitiator(peerId)) {
      negotiate(peerId, peer);
    }

    return peer;
  }

  async function negotiate(peerId, peer) {
    if (peer.negotiating) return;
    peer.negotiating = true;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      sendSignal(peerId, { type: "offer", sdp: peer.pc.localDescription });
    } catch (err) {
      log("offer failed", err);
    } finally {
      peer.negotiating = false;
    }
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
    } catch {}
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    remoteMic.delete(peerId);
  }

  async function handleSignal(fromId, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const peer = peers.get(fromId) || createPeer(fromId);

    try {
      if (message.type === "offer") {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
        await flushIce(peer);

        // Adopt the transceiver the remote offer created. It defaults to
        // recvonly while we have no track, which would permanently one-way the
        // call; forcing sendrecv before answering keeps our side able to talk
        // (and lets a later replaceTrack work without renegotiating).
        const audioTransceiver = peer.pc
          .getTransceivers()
          .find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === "audio");
        if (audioTransceiver) {
          audioTransceiver.direction = "sendrecv";
          peer.sender = audioTransceiver.sender;
          if (micTrack) {
            try {
              await peer.sender.replaceTrack(micTrack);
            } catch {}
          }
        }

        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        sendSignal(fromId, { type: "answer", sdp: peer.pc.localDescription });
      } else if (message.type === "answer") {
        if (peer.pc.signalingState === "have-local-offer") {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
          await flushIce(peer);
        }
      } else if (message.type === "ice" && message.candidate) {
        if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
          await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        } else {
          // Candidates can outrun the description they belong to.
          peer.pendingIce.push(message.candidate);
        }
      }
    } catch (err) {
      log("signal handling failed", err);
    }
  }

  async function flushIce(peer) {
    while (peer.pendingIce.length) {
      const candidate = peer.pendingIce.shift();
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        log("late ice failed", err);
      }
    }
  }

  function broadcastMicState() {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    connection.invoke("SetVoiceState", micOn).catch(() => {});
  }

  async function requestMic() {
    if (!window.isSecureContext) {
      statusText = "Voice needs HTTPS";
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      statusText = "Voice unsupported";
      return false;
    }

    micRequested = true;
    statusText = "Requesting mic…";
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      micRequested = false;
      statusText =
        err && err.name === "NotAllowedError"
          ? "Mic blocked"
          : err && err.name === "NotFoundError"
            ? "No mic found"
            : "Mic unavailable";
      return false;
    }

    micTrack = localStream.getAudioTracks()[0] || null;
    if (!micTrack) {
      statusText = "No mic found";
      return false;
    }

    localAnalyser = attachAnalyser(localStream);
    localBuffer = localAnalyser ? new Uint8Array(localAnalyser.fftSize) : null;
    startLevelPolling();

    for (const peer of peers.values()) {
      if (peer.sender) peer.sender.replaceTrack(micTrack).catch(() => {});
    }
    return true;
  }

  async function toggleMic() {
    getAudioContext(); // this call is inside a click handler: unlocks playback
    resumeAudioPlayback(); // and retries anything refused before that gesture

    if (!micTrack) {
      const ok = await requestMic();
      if (!ok) return false;
      micOn = true;
    } else {
      micOn = !micOn;
    }

    micTrack.enabled = micOn;
    statusText = micOn ? "Mic live" : "Mic muted";
    broadcastMicState();
    return micOn;
  }

  function syncPeers(playerIds) {
    if (!attached || !selfId) return;
    const wanted = new Set(playerIds.filter((id) => id && id !== selfId));

    for (const id of peers.keys()) {
      if (!wanted.has(id)) removePeer(id);
    }
    for (const id of wanted) {
      if (!peers.has(id)) createPeer(id);
    }
  }

  function reset() {
    for (const id of [...peers.keys()]) removePeer(id);
    remoteMic.clear();
    micOn = false;
    if (micTrack) micTrack.enabled = false;
    statusText = micTrack ? "Mic muted" : "Voice off";
  }

  function releaseMic() {
    reset();
    stopLevelPolling();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    micTrack = null;
    micRequested = false;
    localAnalyser = null;
    statusText = "Voice off";
  }

  function attach(hubConnection, myId) {
    connection = hubConnection;
    selfId = myId;
    if (attached) return;
    attached = true;

    connection.on("VoiceSignal", (payload) => {
      if (payload && payload.from) handleSignal(payload.from, payload.payload);
    });

    connection.on("VoiceStateChanged", (payload) => {
      if (payload && payload.playerId) {
        remoteMic.set(payload.playerId, !!payload.micEnabled);
      }
    });

    connection.on("PlayerLeft", (payload) => {
      if (payload && payload.playerId) removePeer(payload.playerId);
    });

    // Any genuine interaction gives the page user activation, which is the only
    // thing that lets refused playback start. Captured so it runs even if the
    // click is handled elsewhere, and cheap: it exits immediately once nothing
    // is blocked.
    document.addEventListener("pointerdown", resumeAudioPlayback, true);
    document.addEventListener("keydown", resumeAudioPlayback, true);
  }

  function setSelfId(myId) {
    if (selfId !== myId) {
      // Identity changed (new room): existing peers belong to the old session.
      reset();
      selfId = myId;
    }
  }

  /** Adopt mic states from a lobby payload (players already in the room). */
  function seedMicStates(players) {
    if (!Array.isArray(players)) return;
    for (const p of players) {
      const id = p && (p.playerId || p.connectionId);
      if (id && id !== selfId) remoteMic.set(id, !!p.micEnabled);
    }
  }

  window.VoiceClient = {
    attach,
    setSelfId,
    seedMicStates,
    syncPeers,
    toggleMic,
    reset,
    releaseMic,
    /** Mic state for any player, self or remote. */
    isMicOn(playerId) {
      if (playerId === selfId) return micOn;
      return remoteMic.get(playerId) === true;
    },
    isSpeaking(playerId) {
      const now = performance.now();
      if (playerId === selfId) return micOn && localSpeakingUntil > now;
      const peer = peers.get(playerId);
      return !!peer && peer.speakingUntil > now && remoteMic.get(playerId) === true;
    },
    isMicLive: () => micOn,
    /** True while the browser is refusing to play incoming voice. */
    isAudioBlocked: () => audioBlocked,
    resumeAudioPlayback,
    /** Per-peer connection state and audio flow, for diagnosing call quality. */
    async getInboundStats() {
      const out = [];
      for (const [id, peer] of peers) {
        let packets = 0;
        let bytes = 0;
        let sent = 0;
        try {
          const stats = await peer.pc.getStats();
          stats.forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") {
              packets += r.packetsReceived || 0;
              bytes += r.bytesReceived || 0;
            }
            if (r.type === "outbound-rtp" && r.kind === "audio") {
              sent += r.packetsSent || 0;
            }
          });
        } catch {}
        const tx = peer.pc.getTransceivers().map((t) => ({
          dir: t.direction,
          cur: t.currentDirection,
          send: !!(t.sender && t.sender.track),
          recv: !!(t.receiver && t.receiver.track),
        }));
        out.push({ id, state: peer.pc.connectionState, packets, bytes, sent, tx });
      }
      return out;
    },
    isSupported: () =>
      !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection),
    getStatus: () => statusText,
    peerCount: () => peers.size,
    connectedPeerCount: () => {
      let n = 0;
      for (const p of peers.values()) if (p.pc.connectionState === "connected") n++;
      return n;
    },
  };
})();
