/**
 * One-shot UI sound effects (star hover/select/birth) plus a single looping
 * ambient track for the constellation map. Deliberately plain
 * HTMLAudioElement rather than the Tone.js rig in playback.js — these are
 * fire-and-forget UI cues, not scheduled musical events, so there's nothing
 * to gain from a shared audio-context sampler here.
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

const templates = new Map();

function getTemplate(name) {
  let el = templates.get(name);
  if (!el) {
    el = new Audio(SFX_SOURCES[name]);
    el.preload = 'auto';
    templates.set(name, el);
  }
  return el;
}

/**
 * Plays a one-shot effect. Clones the template element so rapid re-triggers
 * (e.g. sweeping the pointer across several stars) each get their own
 * playhead instead of cutting each other off mid-sound.
 */
export function playSfx(name, { volume = 1 } = {}) {
  const source = SFX_SOURCES[name];
  if (!source) return;
  const node = getTemplate(name).cloneNode(true);
  node.volume = volume;
  node.play().catch(() => {});
}

/**
 * A single looping track, started lazily on the page's first user gesture
 * (autoplay policy) and controllable after that. Used for the constellation
 * map's ambient background music.
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
