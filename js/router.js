/**
 * Tiny hash router.
 *
 * A view is `{ mount(root, params) -> Promise<{ unmount() }>, ... }`. Routes
 * are matched top-to-bottom; the first match wins. If none match, the
 * `notFound` view is mounted.
 *
 * Every launch lands on whatever route the URL's hash names (the landing
 * route if there isn't one) — there's no cross-session "resume my last
 * project" redirect, so opening the site always surfaces the constellation
 * map first.
 */

export function createRouter({ root, routes, notFound }) {
  let current = null;

  async function handle() {
    const hash = normalizeHash(location.hash);
    const match = findMatch(routes, hash);
    if (current?.unmount) {
      try { await current.unmount(); } catch (error) { console.error('View unmount failed:', error); }
    }
    root.replaceChildren();
    try {
      current = match
        ? await match.route.view.mount(root, match.params)
        : await notFound.mount(root, {});
    } catch (error) {
      console.error('View mount failed:', error);
      current = null;
      root.textContent = 'Something went wrong loading this view. Reload to try again.';
    }
  }

  async function start() {
    await handle();
  }

  window.addEventListener('hashchange', () => { handle(); });
  return { start };
}

/** Programmatic navigation. Views should use this rather than touching location. */
export function navigate(hash) {
  const normalized = hash.startsWith('#') ? hash : `#${ hash }`;
  if (location.hash === normalized) return;
  location.hash = normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHash(hash) {
  if (!hash || hash === '#') return '#/';
  return hash;
}

function findMatch(routes, hash) {
  for (const route of routes) {
    const params = route.match(hash);
    if (params) return { route, params };
  }
  return null;
}

const EDITOR_HASH = /^#\/edit\/(.+)$/;

export function parseEditorHash(hash) {
  const match = EDITOR_HASH.exec(hash);
  return match ? { id: match[1] } : null;
}

export function editorHash(id) {
  return `#/edit/${ id }`;
}

export const LANDING_HASH = '#/';
export const TRASH_HASH = '#/trash';
