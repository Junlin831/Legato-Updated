import { SUPPORT_MESSAGES, pickSupportMessage } from '../data/support-messages.js';
import { createSheetMusicParticles } from '../sheet-music/particles.js';

export const STARTUP_SPLASH_DURATION_MS = 1500;
export const STARTUP_SPLASH_BLACKOUT_MS = 220;
export const STARTUP_SPLASH_REVEAL_MS = 220;
export const STARTUP_HANDOFF_MIN_MS = 900;
export const STARTUP_HANDOFF_MAX_MS = 1400;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Prepare one startup overture: choose its sentence and reuse the sheet-music
 * WebGL engine to assemble the miniature staff from particles left-to-right.
 */
export function mountStartupSplash(splash, {
  random = Math.random,
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches,
} = {}) {
  if (!splash) return { message: '', destroy() {} };

  const message = pickSupportMessage(random);
  const messageEl = splash.querySelector('#startup-splash-message');
  if (messageEl) messageEl.textContent = message;

  const stage = splash.querySelector('.startup-splash-score-stage');
  const svg = stage?.querySelector('.startup-splash-score');
  const canvas = stage?.querySelector('.startup-splash-particles');
  if (!stage || !svg || !canvas) return { message, destroy() {} };

  const particles = createSheetMusicParticles(canvas);
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  particles.setSheetMusic(svg, [{
    index: 0,
    x: width * 18 / 920,
    width: width * 884 / 920,
    staffTop: height * 20 / 76,
    lineGap: height * 9 / 76,
  }]);

  let progressFrame = 0;
  if (reducedMotion) {
    particles.setProgress(1, 0);
  } else {
    particles.beginPlayback();
    particles.setProgress(0, 0);
    const startedAt = performance.now();
    const updateProgress = (now) => {
      const progress = Math.min(1, (now - startedAt) / STARTUP_SPLASH_DURATION_MS);
      particles.setProgress(progress, 0);
      if (progress < 1) progressFrame = requestAnimationFrame(updateProgress);
    };
    progressFrame = requestAnimationFrame(updateProgress);
  }

  return {
    message,
    destroy() {
      if (progressFrame) cancelAnimationFrame(progressFrame);
      particles.destroy();
    },
  };
}

export { SUPPORT_MESSAGES };

/** Pin the splash character to its painted viewport coordinates. */
export function pinStartupCharacter(splash) {
  const character = splash?.querySelector('.startup-splash-character');
  if (!character) return null;
  const rect = character.getBoundingClientRect();
  Object.assign(character.style, {
    position: 'fixed',
    left: `${ rect.left }px`,
    top: `${ rect.top }px`,
    width: `${ rect.width }px`,
    height: `${ rect.height }px`,
    margin: '0',
    animation: 'none',
    transform: 'none',
  });
  return character;
}

/**
 * Hold the full loading composition for 1.5 seconds, then fade every element
 * except the character so the next view can be mounted behind an opaque black
 * veil.
 */
export async function beginStartupHandoff(splash, {
  elapsedMs = 0,
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  wait = delay,
  pin = pinStartupCharacter,
} = {}) {
  if (!splash) return null;
  const holdMs = Math.max(0, STARTUP_SPLASH_DURATION_MS - elapsedMs);
  if (holdMs) await wait(holdMs);
  const character = pin(splash);
  splash.classList.add('is-handoff');
  if (!reducedMotion) await wait(STARTUP_SPLASH_BLACKOUT_MS);
  return character;
}

/**
 * Only accept a brand mark after its view identifies itself as ready. The
 * editor mounts its brand before score layout finishes; accepting that early
 * node would race the destination view's own layout pass.
 */
export function queryStartupHandoffTarget(root = document) {
  return root.querySelector('.constellation-shell .brand-mark, .app-shell[data-view-ready] .brand-mark');
}

export async function waitForStartupHandoffTarget(root = document, {
  timeoutMs = 2400,
  now = () => performance.now(),
  nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve)),
} = {}) {
  const startedAt = now();
  let target = queryStartupHandoffTarget(root);
  while (!target && now() - startedAt < timeoutMs) {
    await nextFrame();
    target = queryStartupHandoffTarget(root);
  }
  return target;
}

export function startupHandoffDuration(fromRect, toRect) {
  if (!fromRect || !toRect) return STARTUP_HANDOFF_MIN_MS;
  const fromX = fromRect.left + fromRect.width / 2;
  const fromY = fromRect.top + fromRect.height / 2;
  const toX = toRect.left + toRect.width / 2;
  const toY = toRect.top + toRect.height / 2;
  const distance = Math.hypot(toX - fromX, toY - fromY);
  return Math.round(Math.max(
    STARTUP_HANDOFF_MIN_MS,
    Math.min(STARTUP_HANDOFF_MAX_MS, 720 + distance * 0.72),
  ));
}

/** Move the pinned splash character to the real destination, then reveal it. */
export async function completeStartupHandoff(splash, character, target, {
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  wait = delay,
} = {}) {
  if (!splash) return;

  let previousVisibility = '';
  if (character && target) {
    const fromRect = character.getBoundingClientRect();
    const toRect = target.getBoundingClientRect();
    const travelMs = reducedMotion ? 0 : startupHandoffDuration(fromRect, toRect);
    previousVisibility = target.style.visibility;
    target.style.visibility = 'hidden';
    character.style.setProperty('--startup-character-travel-ms', `${ travelMs }ms`);
    character.classList.add('is-travelling');
    // Commit the pinned starting geometry before animating.
    character.getBoundingClientRect();
    // A translate+scale from the pinned rect to the target rect reaches the
    // same endpoint as animating left/top/width/height directly, but only
    // ever touches transform — compositor-only, no layout on every frame.
    character.style.transform = [
      `translate(${ toRect.left - fromRect.left }px, ${ toRect.top - fromRect.top }px)`,
      `scale(${ toRect.width / fromRect.width }, ${ toRect.height / fromRect.height })`,
    ].join(' ');
    if (travelMs) await wait(travelMs);
  }

  splash.classList.add('is-revealing');
  if (target) target.style.visibility = previousVisibility;
  if (!reducedMotion) await wait(STARTUP_SPLASH_REVEAL_MS);
  splash.remove();
}
