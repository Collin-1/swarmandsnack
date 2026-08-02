// Game audio: streamed music beds plus a synthesised eat blip.
//
// Follows the same shape as voice.js — one global, driven by game.js.
//
// Two decisions worth knowing:
//
// Music is <audio> streaming rather than decoded buffers. The tracks are
// minutes long and several megabytes; decoding them into memory would cost tens
// of megabytes of PCM per track and stall the main thread while it happened.
// Streaming starts playing after a few hundred KB and never blocks the render
// loop.
//
// The eat sound is synthesised, not a file. It fires several times a second in
// an eight-player scrum, so it has to be zero-latency and cheap, and it needs a
// different pitch every time — an identical sample on repeat is what makes a
// game grating. Generating it costs nothing to download and nothing to license.
(function () {
  "use strict";

  const STORAGE_KEY = "swarmsnack.audio";
  const FADE_MS = 700;

  // Deliberately low. Music sits under a voice-chat mix, and a track that feels
  // right in isolation buries people talking.
  const TRACK_VOLUME = {
    lobby: 0.35,
    match: 0.25,
    victory: 0.6,
  };

  const TRACKS = {
    lobby: { src: "audio/lobby.mp3", loop: true },
    match: { src: "audio/match.mp3", loop: true },
    victory: { src: "audio/victory.mp3", loop: false },
  };

  const elements = new Map();
  let current = null;
  let pending = null;
  let unlocked = false;
  let audioCtx = null;
  let eatVoices = 0;

  let settings = { muted: false, volume: 0.8 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      settings.muted = !!saved.muted;
      if (typeof saved.volume === "number") {
        settings.volume = Math.min(1, Math.max(0, saved.volume));
      }
    }
  } catch {
    // A corrupt or blocked localStorage is not worth failing audio over.
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private browsing — run with defaults */
    }
  }

  const listeners = new Set();
  function notify() {
    for (const fn of listeners) fn();
  }

  function elementFor(name) {
    let el = elements.get(name);
    if (el) return el;

    const track = TRACKS[name];
    if (!track) return null;

    el = new Audio();
    el.src = track.src;
    el.loop = track.loop;
    // Nothing is fetched until something asks to play, so the lobby page does
    // not pull twenty megabytes on load.
    el.preload = "none";
    el.volume = 0;
    elements.set(name, el);
    return el;
  }

  function targetVolume(name) {
    if (settings.muted) return 0;
    return (TRACK_VOLUME[name] ?? 0.3) * settings.volume;
  }

  // Ramps an element's volume and optionally pauses it at the end. Each element
  // keeps its own timer so overlapping fades can't fight each other.
  function fade(el, to, ms, thenPause) {
    if (el._fade) clearInterval(el._fade);
    const from = el.volume;
    const start = performance.now();
    if (ms <= 0) {
      el.volume = to;
      if (thenPause && to === 0) el.pause();
      return;
    }
    el._fade = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / ms);
      el.volume = Math.min(1, Math.max(0, from + (to - from) * t));
      if (t >= 1) {
        clearInterval(el._fade);
        el._fade = null;
        if (thenPause && to === 0) el.pause();
      }
    }, 25);
  }

  function startTrack(name) {
    const el = elementFor(name);
    if (!el) return;
    el.preload = "auto";
    const play = el.play();
    if (play && typeof play.catch === "function") {
      play.catch(() => {
        // Autoplay refused: remember what we wanted and wait for a gesture.
        pending = name;
      });
    }
    fade(el, targetVolume(name), FADE_MS, false);
  }

  function playTrack(name) {
    if (!TRACKS[name]) return;
    if (!unlocked) {
      pending = name;
      return;
    }
    if (current === name && !elementFor(name).paused) return;

    if (current && current !== name) {
      const old = elementFor(current);
      if (old) fade(old, 0, FADE_MS, true);
    }
    current = name;
    startTrack(name);
  }

  function stopMusic() {
    if (!current) return;
    const el = elementFor(current);
    if (el) fade(el, 0, FADE_MS, true);
    current = null;
  }

  // ---- eat blip ---------------------------------------------------------

  function ensureContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // A short square blip whose pitch drops — a coin rises, a bite falls. The
  // low-pass takes the shrillness off so it survives being heard a hundred
  // times a match.
  function eat() {
    if (settings.muted || !unlocked) return;
    const ctx = ensureContext();
    if (!ctx) return;

    // In a scrum a leader clears several underlings within a few frames.
    // Without a cap they stack into a clipped wall of noise.
    if (eatVoices >= 4) return;
    eatVoices++;

    const now = ctx.currentTime;
    const detune = 0.85 + Math.random() * 0.3;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = "square";
    osc.frequency.setValueAtTime(420 * detune, now);
    osc.frequency.exponentialRampToValueAtTime(110 * detune, now + 0.09);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2200, now);

    const peak = 0.5 * settings.volume;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
    osc.onended = () => {
      eatVoices--;
      osc.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  // ---- unlocking --------------------------------------------------------

  // Browsers refuse audio until the user has interacted with the page. This
  // already caught the project once: invite-link joins were silent because
  // joinBtn.click() is programmatic and grants no user activation. So rather
  // than trusting any particular button, listen for the first real gesture.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    ensureContext();
    if (pending) {
      const name = pending;
      pending = null;
      playTrack(name);
    }
    notify();
  }

  function installGestureHooks() {
    const onGesture = () => unlock();
    for (const evt of ["pointerdown", "keydown", "touchstart"]) {
      window.addEventListener(evt, onGesture, { capture: true, once: false, passive: true });
    }
  }

  // ---- settings ---------------------------------------------------------

  function applyVolume() {
    for (const [name, el] of elements) {
      if (el.paused) continue;
      fade(el, name === current ? targetVolume(name) : 0, 120, false);
    }
    persist();
    notify();
  }

  function setVolume(v) {
    settings.volume = Math.min(1, Math.max(0, v));
    if (settings.volume > 0 && settings.muted) settings.muted = false;
    applyVolume();
  }

  function toggleMute() {
    settings.muted = !settings.muted;
    if (settings.muted) {
      for (const el of elements.values()) if (!el.paused) fade(el, 0, 200, false);
      persist();
      notify();
    } else {
      applyVolume();
      // Unmuting mid-match should resume whatever should be playing.
      if (current) startTrack(current);
    }
    return settings.muted;
  }

  installGestureHooks();

  window.GameAudio = {
    unlock,
    playTrack,
    stopMusic,
    eat,
    setVolume,
    toggleMute,
    isMuted: () => settings.muted,
    getVolume: () => settings.volume,
    isUnlocked: () => unlocked,
    currentTrack: () => current,
    onChange: (fn) => listeners.add(fn),

    // The music elements are never added to the document, so there is no way to
    // inspect them from outside. Audio failures are close to invisible — a
    // silent game looks identical to a muted one — so expose enough to tell
    // "playing", "blocked" and "failed to load" apart.
    trackState: () =>
      [...elements.entries()].map(([name, el]) => ({
        name,
        paused: el.paused,
        volume: +el.volume.toFixed(3),
        currentTime: +el.currentTime.toFixed(2),
        readyState: el.readyState,
        error: el.error ? el.error.code : null,
      })),
  };
})();
