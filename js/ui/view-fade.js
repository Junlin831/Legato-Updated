/**
 * Fade-to-black transition between router views (e.g. constellation map ->
 * editor). Operates on the fixed #view-fade element declared in index.html
 * as a sibling of #app-root — it must live outside the router-managed root,
 * since router.root.replaceChildren() on every navigation would otherwise
 * destroy it mid-transition.
 */
const FADE_MS = 380;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits two rAFs so the freshly-mounted view gets a chance to paint before the fade-in starts. */
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/**
 * Fades to black, runs `onMidFade` while the screen is hidden (this is where
 * navigation happens), then fades back in once the new view has painted.
 */
export async function withViewFade(onMidFade) {
  const fadeEl = document.getElementById('view-fade');
  if (!fadeEl) { await onMidFade(); return; }
  fadeEl.classList.add('is-active');
  await delay(FADE_MS);
  await onMidFade();
  await nextPaint();
  fadeEl.classList.remove('is-active');
}
