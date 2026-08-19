/**
 * One-shot UI sound effects (star hover/select/birth/delete) plus a single
 * looping ambient track for the constellation map.
 *
 * One-shots go through the Web Audio API rather than HTMLAudioElement.
 * The first version of this cloned a template `<audio>` element and called
 * `.play()` on the clone for every trigger — cheap-looking, but each clone
 * is its own independent decode/output pipeline, and firing a lot of them in
 * quick succession (sweeping the pointer across several stars) audibly
 * stalled whatever else was already playing, including the ambient loop.
 * Decoding every effect once into a shared AudioBuffer and playing it
 * through one shared AudioContext avoids that entirely — starting a buffer
 * source is just scheduling a mix, not spinning up a new decoder.
 *
 * Browsers block audio until the page has seen a user gesture. Every play
 * call below swallows that rejection silently (`.catch(() => {})`) rather
 * than surfacing it — a sound effect that doesn't fire because the user
 * hasn't clicked anything yet is expected behavior, not an error.
 */
const SFX_SOURCES = {
  hover: '/assets/audio/hover.mp3',
  select: '/assets/audio/selected.mp3',
  starBorn: '/assets/audio/star-born.mp3',
  starDeleted: '/assets/audio/delete.mp3',
};

let audioCtx = null;
function getContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

const bufferPromises = new Map();

function loadBuffer(name) {
  let promise = bufferPromises.get(name);
  if (!promise) {
    promise = fetch(SFX_SOURCES[name])
      .then((response) => response.arrayBuffer())
      .then((data) => getContext().decodeAudioData(data));
    bufferPromises.set(name, promise);
  }
  return promise;
}

// Kick off decoding right away so the first real trigger doesn't wait on a
// fetch + decode round-trip on top of the browser's own gesture gate.
Object.keys(SFX_SOURCES).forEach((name) => { loadBuffer(name).catch(() => {}); });

/** Plays a one-shot effect. Independent voice per call — overlapping triggers never cut each other off. */
export function playSfx(name, { volume = 1 } = {}) {
  if (!SFX_SOURCES[name]) return;
  const ctx = getContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  loadBuffer(name).then((buffer) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(ctx.destination);
    source.start();
  }).catch(() => {});
}

/**
 * A single looping track, started lazily on the page's first user gesture
 * (autoplay policy) and controllable after that. Used for the constellation
 * map's ambient background music. Kept as a plain HTMLAudioElement rather
 * than routed through the Web Audio API above — it's one long-lived stream
 * rather than something re-triggered constantly, so there's no per-trigger
 * decode cost to avoid here.
 */
export function createAmbientLoop(src, { volume = 0.32 } = {}) {
  const el = new Audio(src);
  el.loop = true;
  el.preload = 'auto';
  el.volume = volume;
  let wantsToPlay = false;
  let armed = false;

  function tryPlay() {
    if (!wantsToPlay) return;
    el.play().catch(() => {});
  }

  /** Arms a one-time listener so playback starts on the very first click/keydown anywhere on the page. */
  function armFirstGesture() {
    if (armed) return;
    armed = true;
    const start = () => { tryPlay(); };
    document.addEventListener('pointerdown', start, { once: true });
    document.addEventListener('keydown', start, { once: true });
  }

  return {
    play() {
      wantsToPlay = true;
      armFirstGesture();
      tryPlay();
    },
    pause() {
      wantsToPlay = false;
      el.pause();
    },
    setMuted(muted) {
      el.muted = muted;
    },
    get muted() {
      return el.muted;
    },
    destroy() {
      wantsToPlay = false;
      el.pause();
      el.src = '';
    },
  };
}
