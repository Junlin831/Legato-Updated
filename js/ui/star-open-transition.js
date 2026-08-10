/**
 * The transition that plays when a star on the constellation map is opened.
 * Same plain fade-to-black-and-back as view-fade.js, except the black hold
 * isn't empty — it shows a stationary LEGATO mark plus a miniature version
 * of the startup splash's sheet-music-assembling animation (same particle
 * engine, no character travel this time — this is a re-entry into the app,
 * not the very first load):
 *
 *   1. fade to black
 *   2. once fully black, `onMidTransition` runs (this is where the caller
 *      actually navigates), then the logo + mini score-assembly plays
 *   3. fade back out, revealing the destination view underneath
 *
 * Lives outside the router-managed root (mounted once from main.js into a
 * fixed sibling of #app-root) so navigation mid-transition can't tear it
 * down — same reasoning as view-fade.js.
 */
import { createSheetMusicParticles } from '../sheet-music/particles.js';

const FADE_MS = 380;
const LOAD_MS = 1500;

const TEMPLATE = `
<div class="star-dive" aria-hidden="true">
  <div class="star-dive-loading" hidden>
    <img class="star-dive-brand" src="/assets/brand/legato-icon.png" alt="" draggable="false">
    <div class="star-dive-score-stage">
      <svg class="star-dive-score" viewBox="0 0 920 76">
        <g class="star-dive-staff" fill="none" stroke-width="1.5" opacity="0.55">
          <path d="M18 20H902M18 29H902M18 38H902M18 47H902M18 56H902" />
          <path d="M18 15V61M902 15V61" />
        </g>
        <g class="star-dive-chord" fill="currentColor" stroke="currentColor" stroke-width="1.2">
          <ellipse cx="47" cy="29" rx="6" ry="4" />
          <ellipse cx="47" cy="38" rx="6" ry="4" />
          <ellipse cx="47" cy="47" rx="6" ry="4" />
          <path d="M53 29V12" />
        </g>
        <g class="star-dive-passing-notes" fill="currentColor" stroke="currentColor" stroke-width="1.2" opacity="0.9">
          <ellipse cx="215" cy="45" rx="5" ry="3.5" /><path d="M220 45V29" />
          <ellipse cx="370" cy="38" rx="5" ry="3.5" /><path d="M375 38V22" />
          <ellipse cx="525" cy="31" rx="5" ry="3.5" /><path d="M530 31V15" />
          <ellipse cx="680" cy="38" rx="5" ry="3.5" /><path d="M685 38V22" />
        </g>
        <g class="star-dive-chord" fill="currentColor" stroke="currentColor" stroke-width="1.2" opacity="0.82">
          <ellipse cx="873" cy="29" rx="6" ry="4" />
          <ellipse cx="873" cy="38" rx="6" ry="4" />
          <ellipse cx="873" cy="47" rx="6" ry="4" />
          <path d="M879 29V12" />
        </g>
      </svg>
      <canvas class="star-dive-particles" aria-hidden="true"></canvas>
    </div>
  </div>
</div>
`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits two rAFs so a freshly-shown element gets a chance to paint before timing starts. */
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function mountStarOpenTransition(container) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const root = container.querySelector('.star-dive');
  const loading = root.querySelector('.star-dive-loading');
  const stage = root.querySelector('.star-dive-score-stage');
  const svg = stage.querySelector('.star-dive-score');
  const canvas = stage.querySelector('.star-dive-particles');

  /** @param {{ onMidTransition: () => (void|Promise<void>) }} args */
  async function play({ onMidTransition }) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    root.classList.add('is-active');
    if (!reducedMotion) await delay(FADE_MS);

    await onMidTransition?.();
    await nextPaint();

    loading.hidden = false;
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const particles = createSheetMusicParticles(canvas);
    particles.setSheetMusic(svg, [{
      index: 0,
      x: width * 18 / 920,
      width: width * 884 / 920,
      staffTop: height * 20 / 76,
      lineGap: height * 9 / 76,
    }]);

    if (reducedMotion) {
      particles.setProgress(1, 0);
    } else {
      particles.beginPlayback();
      particles.setProgress(0, 0);
      const startedAt = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / LOAD_MS);
        particles.setProgress(progress, 0);
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      await delay(LOAD_MS);
    }

    particles.destroy();
    loading.hidden = true;
    root.classList.remove('is-active');
    if (!reducedMotion) await delay(FADE_MS);
  }

  return { play };
}
