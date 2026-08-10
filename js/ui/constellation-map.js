/**
 * Constellation map — the home screen. Replaces the card-grid landing panel
 * with a radial star map: one fixed central demo star, one star per user
 * project scattered organically around it, and one permanent "new project"
 * star. See docs reference: legato-home-revamp-prompt.md.
 *
 * Rendering is a hybrid: a <canvas> layer draws the glow/spikes/connector
 * lines every animation frame (cheap procedural 2D draws, no DOM cost per
 * star), while a parallel layer of real <button> elements at the same
 * computed coordinates handles hit-testing, hover, focus, and keyboard
 * access — canvas alone can't give us any of that natively.
 *
 * Star positions are derived from each project's id via a seeded PRNG, so
 * the same project always lands in the same spot — the map doesn't
 * reshuffle itself every time a project is renamed or the list refreshes.
 */
import { escapeHtml } from '../util/html.js';
import { icon } from './icons.js';

// ── Seeded layout ─────────────────────────────────────────────────────────

function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, deterministic PRNG keyed by a numeric seed. */
function mulberry32(seed) {
  let a = seed;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LAYOUT_MIN_RADIUS = 0.24;
const LAYOUT_MAX_RADIUS = 0.94;
const LAYOUT_MIN_SEPARATION = 0.17;

/**
 * Normalized (-1..1, center 0,0) positions for every surrounding star.
 * Rejection-sampled against already-placed stars for basic collision
 * avoidance — not true physics, just enough that stars don't overlap.
 */
function computeLayout(ids) {
  const placed = [{ x: 0, y: 0 }];
  const positions = new Map();
  ids.forEach((id) => {
    const rand = mulberry32(hashStringToSeed(id));
    let best = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 28; attempt += 1) {
      const angle = rand() * Math.PI * 2;
      const radius = LAYOUT_MIN_RADIUS + rand() * (LAYOUT_MAX_RADIUS - LAYOUT_MIN_RADIUS);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius * 0.86;
      const minDist = Math.min(...placed.map((p) => Math.hypot(p.x - x, p.y - y)));
      if (minDist >= LAYOUT_MIN_SEPARATION) { best = { x, y }; break; }
      if (minDist > bestScore) { bestScore = minDist; best = { x, y }; }
    }
    positions.set(id, best);
    placed.push(best);
  });
  return positions;
}

const FLARE_COUNT_LIVE = 6;
const FLARE_COUNT_DORMANT = 3;

/**
 * Per-star flare parameters, generated once (not per frame) from a seed so
 * each star's flicker is stable across re-renders and desynced from every
 * other star's. Each flare's length and angle both wander slowly over time
 * via a couple of layered sine waves (drawStar evaluates these against the
 * animation clock) — cheap, and organic enough without needing true
 * simplex/Perlin noise for a handful of pixels of wobble.
 */
function makeFlares(id, kind) {
  const isNew = kind === 'new';
  const count = isNew ? FLARE_COUNT_DORMANT : FLARE_COUNT_LIVE;
  const rand = mulberry32(hashStringToSeed(`${ id }-flare`));
  return Array.from({ length: count }, (_, index) => ({
    angleBase: (index / count) * Math.PI * 2 + (rand() - 0.5) * 0.7,
    angleWanderSpeed: 0.05 + rand() * 0.08,
    angleWanderAmount: 0.12 + rand() * 0.1,
    lenSpeed: 0.09 + rand() * 0.1,
    phase: rand() * Math.PI * 2,
    lenJitterSpeed: 0.21 + rand() * 0.13,
    lenJitterPhase: rand() * Math.PI * 2,
  }));
}

// ── Template ────────────────────────────────────────────────────────────

const TEMPLATE = `
<div class="constellation-shell">
  <header class="constellation-topbar">
    <button class="constellation-brand" type="button" aria-label="LEGATO home">
      <img class="brand-mark" src="/assets/brand/legato-icon.png" alt="" draggable="false">
      <span class="brand">LEGATO</span>
    </button>
    <div class="constellation-utility">
      <a class="icon-button is-bordered" href="https://github.com/Feegoat06/OpenAI_Build_Week_Project" target="_blank" rel="noopener noreferrer" aria-label="Open the LEGATO GitHub repository">${ icon('github') }</a>
    </div>
  </header>

  <div id="constellation-notice" class="constellation-notice" hidden></div>

  <div class="constellation-stage">
    <canvas id="constellation-canvas" class="constellation-canvas"></canvas>
    <div id="constellation-stars" class="constellation-stars"></div>
    <div id="constellation-focus-panel" class="constellation-focus-panel" hidden></div>
  </div>

  <p class="constellation-hint">Click a star to open it. The dim one is waiting for its first project.</p>
</div>
`;

const NEW_STAR_ID = '__new__';

export function mountConstellationMap({ container, callbacks }) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const shell = container.querySelector('.constellation-shell');
  const stage = shell.querySelector('.constellation-stage');
  const canvas = shell.querySelector('#constellation-canvas');
  const starsLayer = shell.querySelector('#constellation-stars');
  const focusPanel = shell.querySelector('#constellation-focus-panel');
  const noticeEl = shell.querySelector('#constellation-notice');
  const ctx = canvas.getContext('2d');

  let stageW = 0;
  let stageH = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  /** @type {{ id: string, kind: 'central'|'project'|'new', name: string, pos: {x:number,y:number}, project: any }[]} */
  let stars = [];
  let focusedId = null;
  let hoveredId = null;
  let destroyed = false;
  let frameId = 0;

  function syncCanvasSize() {
    const rect = stage.getBoundingClientRect();
    stageW = Math.max(1, rect.width);
    stageH = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(stageW * dpr);
    canvas.height = Math.round(stageH * dpr);
    canvas.style.width = `${ stageW }px`;
    canvas.style.height = `${ stageH }px`;
  }

  function toPixel(pos) {
    const cx = stageW / 2;
    const cy = stageH / 2;
    const scale = Math.min(stageW, stageH) / 2 * 0.9;
    return { x: cx + pos.x * scale, y: cy + pos.y * scale };
  }

  // ── Star list + DOM hit-targets ──────────────────────────────────────
  function buildStars({ recent, demo }) {
    const ids = [...recent.map((p) => p.id), NEW_STAR_ID];
    const layout = computeLayout(ids);
    const list = [];
    if (demo) {
      list.push({ id: demo.id, kind: 'central', name: demo.name, pos: { x: 0, y: 0 }, project: demo, flares: makeFlares(demo.id, 'central') });
    }
    for (const project of recent) {
      list.push({ id: project.id, kind: 'project', name: project.name, pos: layout.get(project.id), project, flares: makeFlares(project.id, 'project') });
    }
    list.push({ id: NEW_STAR_ID, kind: 'new', name: 'New project', pos: layout.get(NEW_STAR_ID), project: null, flares: makeFlares(NEW_STAR_ID, 'new') });
    return list;
  }

  function renderStarButtons() {
    starsLayer.replaceChildren();
    for (const star of stars) {
      const px = toPixel(star.pos);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `constellation-star constellation-star--${ star.kind }`;
      btn.dataset.id = star.id;
      btn.style.left = `${ px.x }px`;
      btn.style.top = `${ px.y }px`;
      btn.setAttribute('aria-label', star.kind === 'new' ? 'Create a new project' : `Open ${ star.name }`);
      btn.onclick = () => { cancelScheduledClose(); selectStar(star.id); };
      // Hovering opens the same focus panel a click does, and leaving both
      // the star and the panel closes it again — a live preview, not a
      // click-to-lock. Closing goes through a short cancellable delay (see
      // scheduleClose) rather than firing immediately: without it, moving
      // the pointer from the star down to the panel's own Edit/Back buttons
      // crosses a dead gap with nothing under the cursor, which would close
      // the panel before the click ever lands. The delay also absorbs the
      // rapid enter/leave pairs that fire right at the star/panel boundary,
      // which is what "glitchy flicker at the edges" actually was.
      btn.addEventListener('pointerenter', () => { hoveredId = star.id; cancelScheduledClose(); selectStar(star.id); });
      btn.addEventListener('pointerleave', () => { hoveredId = hoveredId === star.id ? null : hoveredId; scheduleClose(); });
      btn.addEventListener('focus', () => { hoveredId = star.id; cancelScheduledClose(); selectStar(star.id); });
      btn.addEventListener('blur', () => { hoveredId = hoveredId === star.id ? null : hoveredId; scheduleClose(); });
      starsLayer.append(btn);
    }
  }

  // ── Focus (dim-others) interaction ───────────────────────────────────
  let closeTimer = 0;

  /** Debounced close — see the long comment on the star's pointerleave above. */
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(clearFocus, 220);
  }

  function cancelScheduledClose() {
    clearTimeout(closeTimer);
    closeTimer = 0;
  }

  function selectStar(id) {
    focusedId = id;
    shell.classList.add('has-focus');
    starsLayer.querySelectorAll('.constellation-star').forEach((el) => {
      el.classList.toggle('is-focused', el.dataset.id === id);
    });
    renderFocusPanel();
  }

  function clearFocus() {
    cancelScheduledClose();
    focusedId = null;
    shell.classList.remove('has-focus');
    starsLayer.querySelectorAll('.constellation-star').forEach((el) => el.classList.remove('is-focused'));
    focusPanel.hidden = true;
    focusPanel.replaceChildren();
  }

  function renderFocusPanel() {
    const star = stars.find((s) => s.id === focusedId);
    if (!star) { clearFocus(); return; }
    const px = toPixel(star.pos);
    focusPanel.hidden = false;
    // Replay the fade-in every time the panel jumps to a different star —
    // it's the same DOM node throughout (only repositioned/re-filled), so a
    // plain CSS `animation` on it only ever plays once. Toggling the class
    // off, forcing a reflow, then back on restarts it from frame zero.
    focusPanel.classList.remove('is-animating-in');
    void focusPanel.offsetWidth;
    focusPanel.classList.add('is-animating-in');
    focusPanel.style.left = `${ px.x }px`;
    focusPanel.style.top = `${ px.y }px`;

    if (star.kind === 'new') {
      focusPanel.innerHTML = `
        <form class="constellation-create-form">
          <input type="text" class="constellation-create-input" placeholder="Name this project" maxlength="80" autocomplete="off" aria-label="New project name" />
          <div class="constellation-panel-actions">
            <button type="submit" class="constellation-panel-primary">Create</button>
            <button type="button" class="constellation-panel-secondary" data-action="back">Back</button>
          </div>
        </form>
      `;
      const form = focusPanel.querySelector('.constellation-create-form');
      const input = focusPanel.querySelector('.constellation-create-input');
      requestAnimationFrame(() => input.focus());
      form.onsubmit = (event) => {
        event.preventDefault();
        const name = input.value.trim() || 'Untitled project';
        callbacks.onCreateProject(name);
      };
      focusPanel.querySelector('[data-action="back"]').onclick = clearFocus;
      return;
    }

    const isDemo = star.kind === 'central';
    focusPanel.innerHTML = `
      <div class="constellation-focus-name">${ escapeHtml(star.name) }</div>
      <div class="constellation-panel-actions">
        <button type="button" class="constellation-panel-primary" data-action="edit">${ isDemo ? 'Open' : 'Edit' }</button>
        <button type="button" class="constellation-panel-secondary" data-action="back">Back</button>
      </div>
    `;
    focusPanel.querySelector('[data-action="edit"]').onclick = () => {
      if (isDemo) callbacks.onOpenDemo(star.id);
      else callbacks.onOpenProject(star.id);
    };
    focusPanel.querySelector('[data-action="back"]').onclick = clearFocus;
  }

  // Click anywhere outside a star or the focus panel itself closes focus —
  // deliberately shell-wide (not just the stage) so clicking the topbar or
  // hint text also backs out, matching "click anywhere to leave". This fires
  // immediately (no debounce) since a click is always an explicit action.
  shell.addEventListener('click', (event) => {
    if (event.target.closest('.constellation-star') || event.target.closest('.constellation-focus-panel')) return;
    clearFocus();
  });

  // The panel itself is part of the same hoverable group as its star (see
  // the comment on the star's pointerenter above) — entering it cancels any
  // pending close, leaving it schedules one, same as the star.
  focusPanel.addEventListener('pointerenter', cancelScheduledClose);
  focusPanel.addEventListener('pointerleave', scheduleClose);

  // ── Canvas draw (static for now — spikes/noise land in a later pass) ──
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stageW, stageH);

    const t = performance.now() * 0.001;
    const center = toPixel({ x: 0, y: 0 });
    for (const star of stars) {
      if (star.kind === 'central') continue;
      const px = toPixel(star.pos);
      drawConnector(center, px, star.id);
    }
    for (const star of stars) {
      const px = toPixel(star.pos);
      drawStar(star, px, t);
    }
  }

  function drawConnector(from, to, seedKey) {
    const rand = mulberry32(hashStringToSeed(`${ seedKey }-curve`));
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    const wander = (rand() - 0.5) * len * 0.22;
    const cx = mx + perpX * wander;
    const cy = my + perpY * wander;
    const dimmed = focusedId != null && focusedId !== seedKey;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(cx, cy, to.x, to.y);
    ctx.strokeStyle = `rgba(158, 168, 235, ${ dimmed ? 0.05 : 0.14 })`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawStar(star, px, t) {
    const dimmed = focusedId != null && focusedId !== star.id;
    const hovered = hoveredId === star.id || focusedId === star.id;
    const isNew = star.kind === 'new';
    const baseColor = isNew ? [122, 128, 168] : [232, 169, 75];
    const glowColor = isNew ? [90, 96, 140] : [232, 169, 75];
    const coreRadius = star.kind === 'central' ? 7 : (isNew ? 4 : 5.5);
    const alpha = dimmed ? 0.22 : 1;
    const boost = hovered ? 1.35 : 1;

    const glowRadius = coreRadius * (isNew ? 3.4 : 5.5) * boost;
    const gradient = ctx.createRadialGradient(px.x, px.y, 0, px.x, px.y, glowRadius);
    gradient.addColorStop(0, `rgba(${ glowColor.join(',') }, ${ 0.55 * alpha })`);
    gradient.addColorStop(1, `rgba(${ glowColor.join(',') }, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px.x, px.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    drawFlares(star, px, t, baseColor, alpha, boost, isNew);

    ctx.beginPath();
    ctx.arc(px.x, px.y, coreRadius * boost, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${ baseColor.join(',') }, ${ alpha })`;
    ctx.fill();
  }

  /**
   * Wavy, irregular flares radiating from a star's core — length and angle
   * both drift slowly via per-flare sine waves (see makeFlares), so no two
   * flares (or stars) ever move in sync. A dormant (new-project) star's
   * flares barely move at all, per the "minimal or fully dormant" idle
   * treatment for an empty project.
   */
  function drawFlares(star, px, t, baseColor, alpha, boost, isNew) {
    const baseLen = (star.kind === 'central' ? 13 : 9) * (isNew ? 0.55 : 1);
    const motion = isNew ? 0.15 : 1;
    for (const flare of star.flares) {
      const lenWave = 0.5 + 0.5 * Math.sin(t * flare.lenSpeed + flare.phase);
      const lenJitter = 0.12 * Math.sin(t * flare.lenJitterSpeed + flare.lenJitterPhase);
      const len = baseLen * boost * (0.45 + (lenWave + lenJitter) * motion * 0.85);
      const angle = flare.angleBase + Math.sin(t * flare.angleWanderSpeed + flare.phase) * flare.angleWanderAmount * motion;
      const flareAlpha = alpha * (isNew ? 0.22 : 0.4) * (0.5 + lenWave * 0.5);
      const width = (star.kind === 'central' ? 2.6 : 1.8) * boost;

      const perpX = -Math.sin(angle) * width;
      const perpY = Math.cos(angle) * width;
      const tipX = px.x + Math.cos(angle) * len;
      const tipY = px.y + Math.sin(angle) * len;

      ctx.beginPath();
      ctx.moveTo(px.x + perpX, px.y + perpY);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(px.x - perpX, px.y - perpY);
      ctx.closePath();
      const grad = ctx.createLinearGradient(px.x, px.y, tipX, tipY);
      grad.addColorStop(0, `rgba(${ baseColor.join(',') }, ${ flareAlpha })`);
      grad.addColorStop(1, `rgba(${ baseColor.join(',') }, 0)`);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  // ── Public render ─────────────────────────────────────────────────────
  function render(data) {
    const previousFocus = focusedId;
    stars = buildStars(data);
    renderStarButtons();
    if (previousFocus && stars.some((s) => s.id === previousFocus)) {
      selectStar(previousFocus);
    } else {
      clearFocus();
    }
    draw();
  }

  function loop() {
    if (destroyed) return;
    frameId = requestAnimationFrame(loop);
    draw();
  }

  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize();
    renderStarButtons();
    if (focusedId) renderFocusPanel();
    draw();
  });
  resizeObserver.observe(stage);
  syncCanvasSize();
  loop();

  return {
    render,
    showNotice({ message, level = 'info' }) {
      noticeEl.textContent = message;
      noticeEl.dataset.level = level;
      noticeEl.hidden = false;
    },
    hideNotice() {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      cancelScheduledClose();
    },
  };
}
