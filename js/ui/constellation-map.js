/**
 * Constellation map — the home screen. Replaces the card-grid landing panel
 * with a radial star map: one fixed central demo star, one star per user
 * project scattered organically around it. See docs reference:
 * legato-home-revamp-prompt.md (superseded in places by direct feedback —
 * notably there's no separate "new project" star anymore; see the empty-
 * space click handler below).
 *
 * Rendering is a hybrid: a <canvas> layer draws the glow/spikes/connector
 * lines/particle effects every animation frame (cheap procedural 2D draws,
 * no DOM cost per star), while a parallel layer of real <button> elements at
 * the same computed coordinates handles click and keyboard access — canvas
 * alone can't give us either natively. Mouse *hover*, notably, is NOT driven
 * by those per-star DOM elements — see the stage-level pointermove handler
 * for why.
 *
 * Star positions are derived from each project's id via a seeded PRNG, so
 * the same project always lands in the same spot — the map doesn't
 * reshuffle itself every time a project is renamed or the list refreshes.
 * Dragging a star (or clicking empty space to place a new one) overrides
 * that and persists to the project's own `mapPosition` field via
 * callbacks.onMoveStar, so a manually-arranged layout survives leaving and
 * returning to the map, not just the current session. The one exception is
 * the central demo star, which has no backing project to persist to — its
 * drag stays session-local, same as before.
 */
import { escapeHtml } from '../util/html.js';
import { icon } from './icons.js';
import { playSfx, createAmbientLoop } from '../audio/sfx.js';

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

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

const LAYOUT_MIN_RADIUS = 0.24;
const LAYOUT_MAX_RADIUS = 0.94;

/**
 * Normalized (-1..1, center 0,0) position for every surrounding star.
 *
 * Deliberately a pure function of a single id and nothing else — no
 * collision-avoidance against sibling stars. An earlier version rejection-
 * sampled each candidate against every other *currently live* star, which
 * seemed reasonable but meant a star's position depended on which other
 * stars happened to exist and what order they were processed in — creating
 * or deleting an unrelated star, or even just the store returning projects
 * in a different order (autosave bumps a project's updatedAt on every open,
 * even with no edits, changing sort order), could nudge a completely
 * unrelated star to a different fallback slot. Sorting the input helped but
 * didn't close every case (e.g. a newly-created id can sort *before* an
 * older one, since the id's counter portion resets every page load). Making
 * placement depend on nothing but the star's own id closes all of those at
 * once: the same id always lands in the same spot, forever, regardless of
 * what else is on the map. The trade-off is no explicit anti-overlap check,
 * but the wide radius/angle spread makes a visible collision rare, and
 * dragging (which pins a star's position) is always available as a manual
 * fix for the odd case where two stars do land close together.
 */
function computeLayout(ids, pinned) {
  const positions = new Map();
  for (const id of ids) {
    if (pinned.has(id)) {
      positions.set(id, pinned.get(id));
      continue;
    }
    const rand = mulberry32(hashStringToSeed(id));
    const angle = rand() * Math.PI * 2;
    const radius = LAYOUT_MIN_RADIUS + rand() * (LAYOUT_MAX_RADIUS - LAYOUT_MIN_RADIUS);
    positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.86 });
  }
  return positions;
}

const FLARE_COUNT = 6;

/**
 * Per-star flare parameters, generated once (not per frame) from a seed so
 * each star's flicker is stable across re-renders and desynced from every
 * other star's. Each flare's length and angle both wander slowly over time
 * via a couple of layered sine waves (drawStar evaluates these against the
 * animation clock) — cheap, and organic enough without needing true
 * simplex/Perlin noise for a handful of pixels of wobble.
 */
function makeFlares(id) {
  const rand = mulberry32(hashStringToSeed(`${ id }-flare`));
  return Array.from({ length: FLARE_COUNT }, (_, index) => ({
    angleBase: (index / FLARE_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.7,
    angleWanderSpeed: 0.05 + rand() * 0.08,
    angleWanderAmount: 0.12 + rand() * 0.1,
    lenSpeed: 0.09 + rand() * 0.1,
    phase: rand() * Math.PI * 2,
    lenJitterSpeed: 0.21 + rand() * 0.13,
    lenJitterPhase: rand() * Math.PI * 2,
  }));
}

const GOLD = [232, 169, 75];
const ASH_GREY = [120, 122, 132];

// ── Template ────────────────────────────────────────────────────────────

const TEMPLATE = `
<div class="constellation-shell">
  <header class="constellation-topbar">
    <button class="constellation-brand" type="button" aria-label="LEGATO home">
      <img class="brand-mark" src="/assets/brand/legato-icon.png" alt="" draggable="false">
      <span class="brand">LEGATO</span>
    </button>
    <div class="constellation-utility">
      <button id="constellation-mute" class="icon-button is-bordered" type="button" aria-label="Mute background music" aria-pressed="false">${ icon('volumeOn') }</button>
      <a class="icon-button is-bordered" href="https://github.com/Feegoat06/OpenAI_Build_Week_Project" target="_blank" rel="noopener noreferrer" aria-label="Open the LEGATO GitHub repository">${ icon('github') }</a>
    </div>
  </header>

  <div id="constellation-notice" class="constellation-notice" hidden></div>

  <div class="constellation-stage">
    <canvas id="constellation-canvas" class="constellation-canvas"></canvas>
    <div id="constellation-stars" class="constellation-stars"></div>
    <div id="constellation-focus-panel" class="constellation-focus-panel" hidden></div>
  </div>
</div>
`;

const HOVER_RADIUS_PX = 34;

// Keeps a dragged star from being pushed off the stage entirely (pointer
// capture lets the drag keep tracking past the window edge, where a
// released star becomes unreachable and effectively lost) AND keeps its
// glow's own radial-gradient falloff — which fades smoothly to fully
// transparent at glowRadius (see drawStar) — from being hard-truncated by
// the <canvas> element's own pixel bounds. A canvas simply cannot draw past
// its own edge, so if the star's center gets closer to the boundary than
// glowRadius, the fade gets cut off mid-gradient instead of reaching zero,
// which reads as a harsh straight-edged clip. Sized to the largest glow any
// star reaches (central star, boosted: coreRadius 7 * 5.5 * boost 1.35 ≈
// 52px), with a small buffer — the star itself still sits right at the
// edge, only its faint outer glow gets the room it needs to fade out
// naturally instead of looking cut off.
const STAGE_EDGE_MARGIN_PX = 56;

// Star-birth timeline — three sequential phases, matching the length of the
// "star born" sound effect rather than the old instant radiating spark:
// 1. scattered orange particles converge inward toward the click point
// 2. they collide in a bright flash, then a solid core grows out of it
// 3. once the core has fully formed, a ring of energy ripples outward and
//    dissipates
const BIRTH_CONVERGE_S = 1;
const BIRTH_CORE_FORM_S = 1;
const BIRTH_RIPPLE_S = 0.8;
const BIRTH_CORE_START_S = BIRTH_CONVERGE_S;
const BIRTH_RIPPLE_START_S = BIRTH_CONVERGE_S + BIRTH_CORE_FORM_S;
const BIRTH_TOTAL_S = BIRTH_RIPPLE_START_S + BIRTH_RIPPLE_S;
const BIRTH_PARTICLE_COUNT = 30;
const BIRTH_FLASH_S = 0.35;
const BIRTH_CORE_RADIUS = 5.5;
const ORANGE = [255, 150, 66];

// Delete animation timeline — three sequential phases, not overlapped:
// 1. the star cools from gold to solid grey
// 2. cracks split open across the now-grey body
// 3. the cracked shell crumbles into drifting ash and fades out
const DEATH_GREY_S = 0.7;
const DEATH_CRACK_S = 0.6;
const DEATH_ASH_S = 1.3;
const DEATH_CRACK_START_S = DEATH_GREY_S;
const DEATH_ASH_START_S = DEATH_GREY_S + DEATH_CRACK_S;
const DEATH_TOTAL_S = DEATH_ASH_START_S + DEATH_ASH_S;
const CRACK_COUNT = 6;
const ASH_PARTICLE_COUNT = 18;

export function mountConstellationMap({ container, callbacks }) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const shell = container.querySelector('.constellation-shell');
  const stage = shell.querySelector('.constellation-stage');
  const canvas = shell.querySelector('#constellation-canvas');
  const starsLayer = shell.querySelector('#constellation-stars');
  const focusPanel = shell.querySelector('#constellation-focus-panel');
  const noticeEl = shell.querySelector('#constellation-notice');
  const muteBtn = shell.querySelector('#constellation-mute');
  const ctx = canvas.getContext('2d');

  // Ambient loop plays for as long as this map is mounted; paused on
  // destroy() so it doesn't keep going once the user opens a project. Starts
  // "unmuted" — actual playback is still gated behind the browser's own
  // first-user-gesture autoplay policy (see createAmbientLoop).
  const ambient = createAmbientLoop('/assets/audio/constellation-ambient.mp3', { volume: 0.3 });
  ambient.play();
  muteBtn.addEventListener('click', () => {
    const next = !ambient.muted;
    ambient.setMuted(next);
    muteBtn.setAttribute('aria-pressed', String(next));
    muteBtn.setAttribute('aria-label', next ? 'Unmute background music' : 'Mute background music');
    muteBtn.innerHTML = icon(next ? 'volumeOff' : 'volumeOn');
  });

  let stageW = 0;
  let stageH = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  /** @type {{ id: string, kind: 'central'|'project', name: string, pos: {x:number,y:number}, project: any, flares: any[], connectTo: string|null }[]} */
  let stars = [];
  let focusedId = null;
  let hoveredId = null;
  let confirmingDeleteId = null;
  let destroyed = false;
  let frameId = 0;
  let lastFrameTime = performance.now();

  // Set once a star has been clicked open (see openStar below) — the map is
  // about to be torn down by navigation, so further hover/drag/click
  // interaction is suppressed for the rest of this mount's short remaining
  // lifetime.
  let isOpening = false;

  // Session-local only — a star created by clicking empty space stays where
  // it was clicked instead of jumping to its seeded position, but this isn't
  // written back to the project data, so a reload lets it settle into its
  // normal deterministic spot. That's an intentional trade-off: the alternative
  // is extending the persisted project shape just to remember a map position.
  const pinnedPositions = new Map();
  let pendingBurstId = null;

  // Eased alpha/boost per star, keyed by id and persisted across renders
  // (the `stars` array itself is rebuilt from scratch on every render, so
  // storing animation state ON a star object would reset it every time).
  const animState = new Map();

  // One-shot creation births and in-progress delete animations. Both are
  // drawn independent of the normal interactive `stars` list.
  let births = [];
  const dyingStars = new Map();
  // A star mid-birth-animation stays in `stars`/the DOM (so it's positioned
  // and ready) but is skipped by drawStar/connector drawing and by
  // hover/click — nothing about it should be visible or interactive until
  // its core has actually formed.
  const birthingIds = new Set();

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

  function toNormalized(px) {
    const cx = stageW / 2;
    const cy = stageH / 2;
    const scale = Math.min(stageW, stageH) / 2 * 0.9 || 1;
    return { x: (px.x - cx) / scale, y: (px.y - cy) / scale };
  }

  /** Keeps a pixel point (and the margin around it) inside the stage bounds. */
  function clampToStage(px) {
    return {
      x: Math.min(Math.max(px.x, STAGE_EDGE_MARGIN_PX), Math.max(STAGE_EDGE_MARGIN_PX, stageW - STAGE_EDGE_MARGIN_PX)),
      y: Math.min(Math.max(px.y, STAGE_EDGE_MARGIN_PX), Math.max(STAGE_EDGE_MARGIN_PX, stageH - STAGE_EDGE_MARGIN_PX)),
    };
  }

  // Round-tripped through pixel space so it's always relative to the *current*
  // stage size — a position pinned at a larger window (or from before this
  // margin existed) still gets pulled back in bounds if the stage has since
  // shrunk, instead of only being enforced live during a drag.
  function clampPinnedPosition(pos) {
    return toNormalized(clampToStage(toPixel(pos)));
  }

  // ── Star list + DOM hit-targets ──────────────────────────────────────
  function buildStars({ recent, demo }) {
    // A star mid-delete-animation stays out of the normal interactive list —
    // it's drawn separately by the dyingStars loop in draw() instead.
    const live = recent.filter((p) => !dyingStars.has(p.id));
    // A drag persists its result to the project itself (see endDrag below),
    // so a position saved on an *earlier* visit needs to seed pinnedPositions
    // here too — not just a same-session drag. Only fills in ids that aren't
    // already pinned, so an in-progress drag this session always wins.
    for (const project of live) {
      if (!pinnedPositions.has(project.id) && project.mapPosition) {
        pinnedPositions.set(project.id, project.mapPosition);
      }
    }
    const ids = live.map((p) => p.id);
    const layout = computeLayout(ids, pinnedPositions);
    const list = [];
    if (demo) {
      // Dragging the central star pins it too, same mechanism as any other
      // star — it just defaults to dead centre until moved.
      const pos = pinnedPositions.has(demo.id) ? clampPinnedPosition(pinnedPositions.get(demo.id)) : { x: 0, y: 0 };
      list.push({ id: demo.id, kind: 'central', name: demo.name, pos, project: demo, flares: makeFlares(demo.id), connectTo: null });
    }
    for (const project of live) {
      // Only pinned (dragged/placed) positions need the edge clamp — the
      // seeded fallback is already comfortably inside the stage by
      // construction (see LAYOUT_MAX_RADIUS above computeLayout).
      const pos = pinnedPositions.has(project.id) ? clampPinnedPosition(layout.get(project.id)) : layout.get(project.id);
      list.push({ id: project.id, kind: 'project', name: project.name, pos, project, flares: makeFlares(project.id), connectTo: null });
    }
    assignNearestConnections(list);
    return list;
  }

  /**
   * Nearest-neighbour connector for every non-central star — an organic
   * network rather than a fixed hub-and-spoke, so a star connects to
   * whichever star is physically closest to it, which is often but not
   * always the central node. Re-run after a drag ends so the graph re-settles
   * around the star's new position instead of keeping a stale connection.
   */
  function assignNearestConnections(list) {
    for (const star of list) {
      if (star.kind === 'central') continue;
      let nearest = null;
      let nearestDist = Infinity;
      for (const other of list) {
        if (other.id === star.id) continue;
        const d = Math.hypot(star.pos.x - other.pos.x, star.pos.y - other.pos.y);
        if (d < nearestDist) { nearestDist = d; nearest = other; }
      }
      star.connectTo = nearest ? nearest.id : null;
    }
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
      btn.setAttribute('aria-label', `Open ${ star.name }`);
      attachDragAndOpen(btn, star);
      // Keyboard-only — mouse hover is driven by the stage-level pointermove
      // handler below instead of per-element enter/leave. Tabbing between
      // discrete elements doesn't have the "which overlapping element is the
      // real target" ambiguity continuous mouse movement does, so it's fine
      // for keyboard focus to stay element-based.
      btn.addEventListener('focus', () => { cancelScheduledClose(); selectStar(star.id); });
      btn.addEventListener('blur', scheduleClose);
      starsLayer.append(btn);
    }
  }

  const DRAG_THRESHOLD_PX = 6;
  // Set to a star's id while it's actively being dragged (module-wide, not
  // per-button) so the stage-level hover pointermove below can bail out
  // instead of fighting the drag for control of hoveredId/focusedId.
  let draggingId = null;

  /**
   * A star's own button now both opens it (a plain click/tap, or Enter/Space
   * once focused — that's the native `click` event, so keyboard access falls
   * out for free) and drags it (press, move past a small threshold, release).
   * The two are told apart by movement distance: pointerdown always starts a
   * potential drag, but a `click` only actually opens the project if the
   * pointer never travelled far enough to count as a drag. Pointer capture
   * keeps every move/up event routed to this button even once the cursor
   * leaves its small hit-circle mid-drag.
   */
  function attachDragAndOpen(btn, star) {
    let dragPointerId = null;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;
    // Offset between where the pointer grabbed the star and the star's own
    // center, captured at pointerdown and held for the whole drag — without
    // it the star's center snaps to the pointer on the first move, which
    // reads as picking up a *different* object rather than the one actually
    // grabbed (see apple-design's direct-manipulation guidance).
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    let suppressNextClick = false;

    btn.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || isOpening || birthingIds.has(star.id)) return;
      dragPointerId = event.pointerId;
      dragMoved = false;
      startX = event.clientX;
      startY = event.clientY;
      const rect = stage.getBoundingClientRect();
      const starPx = toPixel(star.pos);
      grabOffsetX = (event.clientX - rect.left) - starPx.x;
      grabOffsetY = (event.clientY - rect.top) - starPx.y;
      btn.setPointerCapture(dragPointerId);
      cancelScheduledClose();
    });

    btn.addEventListener('pointermove', (event) => {
      if (event.pointerId !== dragPointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragMoved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragMoved = true;
        draggingId = star.id;
        btn.classList.add('is-dragging');
      }
      const rect = stage.getBoundingClientRect();
      const raw = { x: (event.clientX - rect.left) - grabOffsetX, y: (event.clientY - rect.top) - grabOffsetY };
      const { x: px, y: py } = clampToStage(raw);
      star.pos = toNormalized({ x: px, y: py });
      btn.style.left = `${ px }px`;
      btn.style.top = `${ py }px`;
      if (focusedId === star.id) renderFocusPanel();
    });

    function endDrag(event) {
      if (event.pointerId !== dragPointerId) return;
      if (btn.hasPointerCapture(dragPointerId)) btn.releasePointerCapture(dragPointerId);
      dragPointerId = null;
      if (dragMoved) {
        btn.classList.remove('is-dragging');
        draggingId = null;
        pinnedPositions.set(star.id, star.pos);
        // Project stars persist to the project itself so the arrangement
        // survives leaving and coming back (see buildStars above) — a real
        // project isn't session-local scratch space the way a click-to-create
        // star's pin is. The central demo star has no backing project to
        // write to, so it keeps the old session-only behavior.
        if (star.kind === 'project') callbacks.onMoveStar(star.id, star.pos);
        assignNearestConnections(stars);
        // The pointerup that ends a drag still synthesizes a `click` right
        // after — without this it would immediately reopen the project the
        // user just meant to reposition.
        suppressNextClick = true;
      }
    }
    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', (event) => {
      if (event.pointerId !== dragPointerId) return;
      dragPointerId = null;
      dragMoved = false;
      btn.classList.remove('is-dragging');
      draggingId = null;
    });

    btn.addEventListener('click', () => {
      if (suppressNextClick) { suppressNextClick = false; return; }
      openStar(star);
    });
  }

  // ── Hover: nearest-star-to-pointer, not per-element DOM events ────────
  // Individual 48px hit-circles physically overlap once two stars are only
  // moderately close together (collision avoidance guarantees separation in
  // normalized position, not in the rendered hit-circle edges), so mouse
  // movement near that overlap used to cause competing elements to fire
  // enter/leave against each other — the "glitch near the solid part of a
  // star" bug. Computing the single nearest star to the pointer on every
  // move sidesteps DOM z-order entirely: "nearest" is a continuous function
  // of cursor position that flips cleanly at the midpoint between two stars,
  // never chaotically.
  //
  // Shared with the shell-level click handler below (see its comment) so
  // "this reads as hovering a star" and "this reads as clicking a star" are
  // answered by the exact same math — a click can never land in a dead zone
  // that looks hoverable but silently falls through to empty-space handling.
  function nearestStarTo(mx, my) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const star of stars) {
      if (birthingIds.has(star.id)) continue;
      const px = toPixel(star.pos);
      const d = Math.hypot(px.x - mx, px.y - my);
      if (d < nearestDist) { nearestDist = d; nearest = star; }
    }
    return { star: nearest, dist: nearestDist };
  }

  starsLayer.addEventListener('pointermove', (event) => {
    // Touch has no hover concept — a tap's own pointermove between
    // pointerdown and the click firing would otherwise flash the hover panel
    // open (and play the hover sound) right before openStar() navigates
    // away. Mirrors the CSS `@media (hover: hover)` gate for JS-driven hover.
    if (event.pointerType === 'touch') return;
    // A star being dragged is driving focusedId/its own position directly —
    // don't let nearest-star hover detection fight it for control.
    if (draggingId != null || isOpening) return;
    const rect = stage.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const { star: nearest, dist: nearestDist } = nearestStarTo(mx, my);
    if (nearest && nearestDist <= HOVER_RADIUS_PX) {
      cancelScheduledClose();
      if (hoveredId !== nearest.id) {
        hoveredId = nearest.id;
        selectStar(nearest.id);
        playSfx('hover', { volume: 0.5 });
      }
    } else if (hoveredId != null) {
      hoveredId = null;
      scheduleClose();
    }
  });
  starsLayer.addEventListener('pointerleave', () => {
    if (hoveredId != null) { hoveredId = null; scheduleClose(); }
  });

  // ── Focus (dim-others) interaction ───────────────────────────────────
  let closeTimer = 0;

  /**
   * Debounced close, shared between the star hover-out and the panel
   * hover-out. Without this, moving the pointer from a star down to its own
   * panel would close the panel the instant it crosses the gap between them
   * (nothing is "hovered" for that one frame), and rapid enter/leave pairs
   * right at any boundary would flicker the panel open/closed. Whichever of
   * {a star is near the pointer, the panel is hovered} is true at any given
   * moment keeps cancelling this timer; it only ever fires once neither is.
   */
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
    confirmingDeleteId = null;
    shell.classList.add('has-focus');
    starsLayer.querySelectorAll('.constellation-star').forEach((el) => {
      el.classList.toggle('is-focused', el.dataset.id === id);
    });
    renderFocusPanel();
  }

  function clearFocus() {
    cancelScheduledClose();
    focusedId = null;
    confirmingDeleteId = null;
    shell.classList.remove('has-focus');
    starsLayer.querySelectorAll('.constellation-star').forEach((el) => el.classList.remove('is-focused'));
    focusPanel.hidden = true;
    focusPanel.replaceChildren();
  }

  /**
   * Clicking a star (a real click/tap, not a drag — see attachDragAndOpen)
   * opens it directly rather than routing through the focus panel. `isOpening`
   * just guards against a second click/drag firing mid-transition — the map
   * is about to be torn down by navigation anyway.
   */
  function openStar(star) {
    if (isOpening || birthingIds.has(star.id)) return;
    isOpening = true;
    playSfx('select');
    cancelScheduledClose();
    focusedId = star.id;
    hoveredId = null;
    confirmingDeleteId = null;
    focusPanel.hidden = true;
    focusPanel.replaceChildren();
    shell.classList.add('has-focus');

    if (star.kind === 'central') callbacks.onOpenDemo(star.id);
    else callbacks.onOpenProject(star.id);
  }

  function renderFocusPanel() {
    const star = stars.find((s) => s.id === focusedId);
    if (!star) { clearFocus(); return; }
    const px = toPixel(star.pos);
    focusPanel.hidden = false;
    // Replay the fade-in every time the panel jumps to a different star (or
    // switches into/out of the delete-confirm view) — it's the same DOM node
    // throughout, so a plain CSS `animation` on it only ever plays once.
    // Toggling the class off, forcing a reflow, then back on restarts it.
    focusPanel.classList.remove('is-animating-in');
    void focusPanel.offsetWidth;
    focusPanel.classList.add('is-animating-in');
    focusPanel.style.left = `${ px.x }px`;
    focusPanel.style.top = `${ px.y }px`;

    const isDemo = star.kind === 'central';

    if (confirmingDeleteId === star.id) {
      focusPanel.innerHTML = `
        <div class="constellation-focus-name">Delete "${ escapeHtml(star.name) }"?</div>
        <p class="constellation-confirm-copy">It moves to the trash — you can still recover it there.</p>
        <div class="constellation-panel-actions">
          <button type="button" class="constellation-panel-danger" data-action="confirm-delete">Delete</button>
          <button type="button" class="constellation-panel-secondary" data-action="cancel-delete">Cancel</button>
        </div>
      `;
      focusPanel.querySelector('[data-action="confirm-delete"]').onclick = () => performDelete(star);
      focusPanel.querySelector('[data-action="cancel-delete"]').onclick = () => {
        confirmingDeleteId = null;
        renderFocusPanel();
      };
      return;
    }

    // Opening now happens by clicking the star itself (see attachDragAndOpen)
    // rather than a button in this panel — the demo star has nothing else to
    // do here, so its panel is just a name label; a real project still needs
    // somewhere to put Delete.
    focusPanel.innerHTML = isDemo
      ? `<div class="constellation-focus-name">${ escapeHtml(star.name) }</div>`
      : `
        <div class="constellation-focus-name">${ escapeHtml(star.name) }</div>
        <div class="constellation-panel-actions">
          <button type="button" class="constellation-panel-danger" data-action="delete">Delete</button>
        </div>
      `;
    if (!isDemo) {
      focusPanel.querySelector('[data-action="delete"]').onclick = () => {
        confirmingDeleteId = star.id;
        cancelScheduledClose();
        renderFocusPanel();
      };
    }
  }

  function performDelete(star) {
    confirmingDeleteId = null;
    playSfx('starDeleted');
    const rand = mulberry32(hashStringToSeed(`${ star.id }-ash-${ Date.now() }`));
    // Crack angles double as the shard boundaries below, so the pieces the
    // star eventually breaks into line up exactly with where the cracks
    // split it — sorted so each shard's [start, end) sector is well-defined.
    const crackAngles = Array.from(
      { length: CRACK_COUNT },
      (_, index) => (index / CRACK_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.6,
    ).sort((a, b) => a - b);
    // Jagged fissures radiating out from the core toward its edge, each a
    // short zig-zag polyline rather than a straight spoke so they read as
    // cracks — clamped to DYING_CORE_RADIUS so they never poke outside the
    // body they're supposedly splitting.
    const cracks = crackAngles.map((angle) => {
      const jointCount = 2 + Math.floor(rand() * 2);
      return {
        angle,
        reach: 0.7 + rand() * 0.3,
        wobble: (rand() - 0.5) * 0.9,
        joints: Array.from({ length: jointCount }, () => (rand() - 0.5) * 2.4),
      };
    });
    // Once the cracks finish growing, the body itself splits along them into
    // these wedge-shaped shards, which then drift apart, spin, shrink and
    // fade — the piece of the animation that makes the star look like it
    // actually broke instead of just fading out in one piece.
    const shards = crackAngles.map((startAngle, index) => {
      const rawEnd = crackAngles[(index + 1) % crackAngles.length];
      const endAngle = rawEnd > startAngle ? rawEnd : rawEnd + Math.PI * 2;
      const mid = (startAngle + endAngle) / 2;
      return {
        startAngle,
        endAngle,
        driftAngle: mid + (rand() - 0.5) * 0.4,
        driftSpeed: 5 + rand() * 10,
        spin: (rand() - 0.5) * 2.6,
      };
    });
    dyingStars.set(star.id, {
      pos: toPixel(star.pos),
      startTime: performance.now() * 0.001,
      cracks,
      shards,
      ashParticles: Array.from({ length: ASH_PARTICLE_COUNT }, () => ({
        angle: rand() * Math.PI * 2,
        speed: 6 + rand() * 14,
        driftY: 8 + rand() * 18,
      })),
    });
    clearFocus();
    // buildStars() excludes anything in dyingStars, so this star drops out
    // of the interactive list on the next render even though the store
    // doesn't actually know about the deletion yet — draw()'s dyingStars
    // loop is what eventually calls onTrashProject once the animation ends.
    stars = stars.filter((s) => s.id !== star.id);
    renderStarButtons();
  }

  // The panel itself is part of the same hoverable group as its star (see
  // the comment on scheduleClose above) — entering it cancels any pending
  // close, leaving it schedules one, same as a star.
  focusPanel.addEventListener('pointerenter', cancelScheduledClose);
  focusPanel.addEventListener('pointerleave', scheduleClose);

  // Click anywhere outside a star or the focus panel closes focus —
  // deliberately shell-wide (not just the stage) so clicking the topbar or
  // hint text also backs out. A click on genuinely empty *stage* space (not
  // the topbar/hint) instead creates a new project there. Both fire
  // immediately, no debounce — a click is always an explicit action.
  shell.addEventListener('click', (event) => {
    // Use composedPath() rather than event.target.closest(...) — a click on
    // an action button inside the focus panel (Delete, Cancel) runs its own
    // handler first, which calls renderFocusPanel() and replaces the panel's
    // innerHTML *before* this listener sees the event during the bubble
    // phase. That detaches the original target from the DOM, so
    // target.closest() would find no ancestors and (wrongly) treat the click
    // as "outside," closing the panel we just re-rendered. composedPath() is
    // captured at dispatch time and stays valid regardless of later DOM
    // mutation.
    if (isOpening) return;
    const path = event.composedPath();
    if (path.some((el) => el.classList?.contains('constellation-star') || el.classList?.contains('constellation-focus-panel'))) return;
    const stageRect = stage.getBoundingClientRect();
    const withinStage = event.clientX >= stageRect.left && event.clientX <= stageRect.right
      && event.clientY >= stageRect.top && event.clientY <= stageRect.bottom;
    // A star's clickable button is only 24px-radius, but its glow/hover
    // highlight reads as "on the star" out to HOVER_RADIUS_PX — a click that
    // lands in that gap used to fall straight through to "empty space" and
    // silently spawn a brand new project right next to the one the user
    // actually meant to open. Reusing the same nearest-star hit test the
    // hover feedback already uses means a click can never land somewhere
    // that *looked* like a star but wasn't treated as one.
    if (withinStage) {
      const mx = event.clientX - stageRect.left;
      const my = event.clientY - stageRect.top;
      const { star: nearest, dist: nearestDist } = nearestStarTo(mx, my);
      if (nearest && nearestDist <= HOVER_RADIUS_PX) {
        openStar(nearest);
        return;
      }
    }
    const wasFocused = focusedId;
    clearFocus();
    if (wasFocused) return; // this click's job was to back out; don't also create
    if (withinStage) {
      handleEmptySpaceClick(event.clientX - stageRect.left, event.clientY - stageRect.top);
    }
  });

  // callbacks.onCreateProject refreshes the whole map (re-fetching from the
  // store) *before* this async function ever gets control back — so setting
  // pinnedPositions/pendingBurstId after awaiting it is always one render
  // too late, and the star would land at its seeded position instead of
  // where it was clicked, with no burst. Passing the position straight into
  // the callback lets the caller register the pin before that first render
  // happens instead.
  function handleEmptySpaceClick(px, py) {
    const pos = toNormalized({ x: px, y: py });
    callbacks.onCreateProject('Untitled project', pos);
  }

  /** Called by the caller synchronously once the new project's real id exists, before it refreshes. */
  function announceNewStar(id, pos) {
    pinnedPositions.set(id, pos);
    pendingBurstId = id;
  }

  // ── Canvas draw ────────────────────────────────────────────────────────
  function draw() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    const t = now * 0.001;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stageW, stageH);

    const byId = new Map(stars.map((s) => [s.id, s]));
    // Two stars can be each other's nearest neighbour — without dedup that
    // draws the same edge twice (once from each side), each with its own
    // random "wander" curve, which reads as a doubled/twinned line. Keying
    // the seed off the sorted pair (rather than whichever star happened to
    // own the connectTo pointer) also makes the curve's shape independent of
    // iteration order.
    const drawnEdges = new Set();
    for (const star of stars) {
      if (!star.connectTo) continue;
      const target = byId.get(star.connectTo);
      if (!target) continue;
      // Neither endpoint should be visible while it's still mid-birth — its
      // core hasn't formed yet, so a line reaching it (or leaving it) would
      // show a connection to a star that visually doesn't exist yet.
      if (birthingIds.has(star.id) || birthingIds.has(target.id)) continue;
      const edgeKey = [star.id, target.id].sort().join('~');
      if (drawnEdges.has(edgeKey)) continue;
      drawnEdges.add(edgeKey);
      const dimmed = focusedId != null && focusedId !== star.id && focusedId !== target.id;
      drawConnector(toPixel(target.pos), toPixel(star.pos), edgeKey, dimmed);
    }
    for (const star of stars) {
      if (birthingIds.has(star.id)) continue;
      drawStar(star, toPixel(star.pos), t, dt);
    }

    for (const birth of births) {
      const age = t - birth.startTime;
      if (age > BIRTH_TOTAL_S) {
        birthingIds.delete(birth.starId);
        continue;
      }
      drawStarBirth(birth, age);
    }
    births = births.filter((b) => birthingIds.has(b.starId));

    for (const [id, dying] of dyingStars) {
      const age = t - dying.startTime;
      if (age > DEATH_TOTAL_S) {
        dyingStars.delete(id);
        callbacks.onTrashProject(id);
        continue;
      }
      drawDyingStar(dying, age);
    }
  }

  function drawConnector(from, to, seedKey, dimmed) {
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
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(cx, cy, to.x, to.y);
    ctx.strokeStyle = `rgba(158, 168, 235, ${ dimmed ? 0.05 : 0.14 })`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawStar(star, px, t, dt) {
    // Eased toward its target rather than snapped, and persisted per-id
    // across renders (the `stars` array is rebuilt from scratch each time)
    // so dimming and the hover brighten/enlarge both read as a smooth
    // transition instead of an instant jump.
    const targetAlpha = (focusedId != null && focusedId !== star.id) ? 0.22 : 1;
    const targetBoost = (hoveredId === star.id || focusedId === star.id) ? 1.35 : 1;
    const state = animState.get(star.id) ?? { alpha: targetAlpha, boost: targetBoost };
    const ease = 1 - 0.0025 ** dt;
    state.alpha += (targetAlpha - state.alpha) * ease;
    state.boost += (targetBoost - state.boost) * ease;
    animState.set(star.id, state);
    const { alpha, boost } = state;

    const coreRadius = star.kind === 'central' ? 7 : 5.5;
    const glowRadius = coreRadius * 5.5 * boost;
    const gradient = ctx.createRadialGradient(px.x, px.y, 0, px.x, px.y, glowRadius);
    gradient.addColorStop(0, `rgba(${ GOLD.join(',') }, ${ 0.55 * alpha })`);
    gradient.addColorStop(1, `rgba(${ GOLD.join(',') }, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px.x, px.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    drawFlares(star, px, t, alpha, boost);

    ctx.beginPath();
    ctx.arc(px.x, px.y, coreRadius * boost, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${ GOLD.join(',') }, ${ alpha })`;
    ctx.fill();
  }

  /**
   * Wavy, irregular flares radiating from a star's core — length and angle
   * both drift slowly via per-flare sine waves (see makeFlares), so no two
   * flares (or stars) ever move in sync.
   */
  function drawFlares(star, px, t, alpha, boost) {
    const baseLen = star.kind === 'central' ? 13 : 9;
    for (const flare of star.flares) {
      const lenWave = 0.5 + 0.5 * Math.sin(t * flare.lenSpeed + flare.phase);
      const lenJitter = 0.12 * Math.sin(t * flare.lenJitterSpeed + flare.lenJitterPhase);
      const len = baseLen * boost * (0.45 + (lenWave + lenJitter) * 0.85);
      const angle = flare.angleBase + Math.sin(t * flare.angleWanderSpeed + flare.phase) * flare.angleWanderAmount;
      const flareAlpha = alpha * 0.4 * (0.5 + lenWave * 0.5);
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
      grad.addColorStop(0, `rgba(${ GOLD.join(',') }, ${ flareAlpha })`);
      grad.addColorStop(1, `rgba(${ GOLD.join(',') }, 0)`);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  function spawnStarBirth(star) {
    const px = toPixel(star.pos);
    const rand = mulberry32(hashStringToSeed(`${ star.id }-birth-${ Date.now() }`));
    const particles = Array.from({ length: BIRTH_PARTICLE_COUNT }, () => ({
      angle: rand() * Math.PI * 2,
      // Where each particle starts, and a per-particle stagger so they don't
      // all arrive dead-center in lockstep — a scattered field falling
      // inward together, not a perfect ring collapsing.
      startDist: 55 + rand() * 95,
      staggerT: rand() * 0.4,
      size: 1.1 + rand() * 1.7,
    }));
    birthingIds.add(star.id);
    births.push({ starId: star.id, x: px.x, y: px.y, startTime: performance.now() * 0.001, particles });
  }

  /**
   * Three sequential phases (see BIRTH_* constants above):
   * 1. scattered particles converge inward, accelerating and brightening as
   *    they fall toward the center
   * 2. a bright flash at the moment of collision, then a solid core grows
   *    out of it
   * 3. once fully formed, a ring of energy ripples outward and dissipates
   */
  function drawStarBirth(birth, age) {
    if (age < BIRTH_CORE_START_S) {
      drawBirthConverge(birth, age);
      return;
    }
    drawBirthCore(birth, age);
    if (age >= BIRTH_RIPPLE_START_S) drawBirthRipple(birth, age);
  }

  function drawBirthConverge(birth, age) {
    const progress = clamp01(age / BIRTH_CONVERGE_S);
    for (const p of birth.particles) {
      // Each particle's own timeline is squeezed into the tail end of the
      // shared window by its stagger, so early frames show a wide scattered
      // field and every particle still lands by BIRTH_CONVERGE_S.
      const local = clamp01((progress - p.staggerT) / (1 - p.staggerT));
      const eased = local * local; // ease-in — accelerating as it falls inward
      const dist = p.startDist * (1 - eased);
      const x = birth.x + Math.cos(p.angle) * dist;
      const y = birth.y + Math.sin(p.angle) * dist;
      const alpha = 0.25 + 0.75 * local;
      const size = p.size * (0.5 + 0.7 * local);

      // A short trailing streak behind the particle (away from center),
      // longer while it's moving fastest, to read as motion rather than a
      // dot that simply teleports smaller each frame.
      const trailLen = p.startDist * eased * 0.22;
      if (trailLen > 1) {
        const tailX = x + Math.cos(p.angle) * trailLen;
        const tailY = y + Math.sin(p.angle) * trailLen;
        const grad = ctx.createLinearGradient(x, y, tailX, tailY);
        grad.addColorStop(0, `rgba(${ ORANGE.join(',') }, ${ 0.7 * alpha })`);
        grad.addColorStop(1, `rgba(${ ORANGE.join(',') }, 0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = size * 0.8;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ ORANGE.join(',') }, ${ alpha })`;
      ctx.fill();
    }
  }

  /** The collision flash (the "something special" moment) plus the core solidifying out of it. */
  function drawBirthCore(birth, age) {
    const coreAge = age - BIRTH_CORE_START_S;
    const growth = clamp01(coreAge / BIRTH_CORE_FORM_S);
    const eased = 1 - (1 - growth) ** 2; // ease-out — settles into place rather than overshooting

    const flashT = clamp01(coreAge / BIRTH_FLASH_S);
    const flashAlpha = flashT < 1 ? (1 - flashT) ** 2 : 0;
    if (flashAlpha > 0) {
      const flashRadius = 14 + flashT * 46;
      const grad = ctx.createRadialGradient(birth.x, birth.y, 0, birth.x, birth.y, flashRadius);
      grad.addColorStop(0, `rgba(255, 250, 235, ${ 0.95 * flashAlpha })`);
      grad.addColorStop(0.5, `rgba(${ ORANGE.join(',') }, ${ 0.5 * flashAlpha })`);
      grad.addColorStop(1, `rgba(${ ORANGE.join(',') }, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(birth.x, birth.y, flashRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    const coreRadius = BIRTH_CORE_RADIUS * eased;
    const glowRadius = coreRadius * 5.5;
    const glowGrad = ctx.createRadialGradient(birth.x, birth.y, 0, birth.x, birth.y, glowRadius);
    glowGrad.addColorStop(0, `rgba(${ GOLD.join(',') }, ${ 0.55 * eased })`);
    glowGrad.addColorStop(1, `rgba(${ GOLD.join(',') }, 0)`);
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(birth.x, birth.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(birth.x, birth.y, coreRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${ GOLD.join(',') }, ${ eased })`;
    ctx.fill();
  }

  /** A ring of energy expanding outward from the newly-formed core, fading as it dissipates. */
  function drawBirthRipple(birth, age) {
    const rippleAge = age - BIRTH_RIPPLE_START_S;
    const progress = clamp01(rippleAge / BIRTH_RIPPLE_S);
    const eased = 1 - (1 - progress) ** 2;
    const radius = BIRTH_CORE_RADIUS + eased * 85;
    const alpha = (1 - progress) * 0.6;
    if (alpha <= 0.01) return;
    ctx.beginPath();
    ctx.arc(birth.x, birth.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${ GOLD.join(',') }, ${ alpha })`;
    ctx.lineWidth = Math.max(0.6, 2.4 * (1 - progress));
    ctx.stroke();
  }

  const DYING_CORE_RADIUS = 6;

  /**
   * Three sequential phases, run in strict order rather than overlapped:
   * 1. gold cools to solid grey — one intact circle, no cracks yet
   * 2. cracks split open across the grey body's surface and hold — still one
   *    intact circle underneath, just visibly fractured
   * 3. the body actually breaks apart along those cracks into drifting,
   *    spinning, shrinking shards (plus fine ash dust), and the whole thing
   *    fades — rather than the circle just fading in place while unrelated
   *    dust appears around it
   */
  function drawDyingStar(dying, age) {
    const greyT = clamp01(age / DEATH_GREY_S);
    const r = GOLD[0] + (ASH_GREY[0] - GOLD[0]) * greyT;
    const g = GOLD[1] + (ASH_GREY[1] - GOLD[1]) * greyT;
    const b = GOLD[2] + (ASH_GREY[2] - GOLD[2]) * greyT;

    const ashAge = age - DEATH_ASH_START_S;

    if (ashAge <= 0) {
      // Still one solid body — draw the glow + filled circle as normal, then
      // etch the cracks on top once the grey phase has finished.
      const glowRadius = DYING_CORE_RADIUS * 5;
      const grad = ctx.createRadialGradient(dying.pos.x, dying.pos.y, 0, dying.pos.x, dying.pos.y, glowRadius);
      grad.addColorStop(0, `rgba(${ r },${ g },${ b },0.5)`);
      grad.addColorStop(1, `rgba(${ r },${ g },${ b },0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(dying.pos.x, dying.pos.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(dying.pos.x, dying.pos.y, DYING_CORE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ r },${ g },${ b },1)`;
      ctx.fill();

      const crackAge = age - DEATH_CRACK_START_S;
      if (crackAge > 0) {
        const crackGrowth = clamp01(crackAge / DEATH_CRACK_S);
        drawCracks(dying, crackGrowth);
      }
      return;
    }

    // The body has broken: draw each shard drifting outward from where it
    // split off, independent of the fine ash dust below, rather than one
    // shrinking circle.
    const ashProgress = clamp01(ashAge / DEATH_ASH_S);
    drawShards(dying, ashProgress);

    const ashAlpha = 1 - ashProgress;
    for (const p of dying.ashParticles) {
      const dist = p.speed * ashProgress * 6;
      const x = dying.pos.x + Math.cos(p.angle) * dist;
      const y = dying.pos.y + Math.sin(p.angle) * dist * 0.5 + p.driftY * ashProgress ** 2 * 3;
      const size = Math.max(0.3, 1.6 * (1 - ashProgress * 0.5));
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ ASH_GREY.join(',') }, ${ 0.7 * ashAlpha })`;
      ctx.fill();
    }
  }

  /**
   * Jagged fissures zig-zagging outward from the core, growing in from
   * nothing then holding — clamped to DYING_CORE_RADIUS (times each crack's
   * own `reach` fraction) so they read as surface cracks and never poke past
   * the body's actual edge.
   */
  function drawCracks(dying, growth) {
    const eased = 1 - (1 - growth) ** 2;
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = `rgba(20, 18, 28, ${ 0.75 * eased })`;
    for (const crack of dying.cracks) {
      const maxLen = DYING_CORE_RADIUS * crack.reach;
      const len = maxLen * eased;
      const jointStep = len / (crack.joints.length + 1);
      ctx.beginPath();
      ctx.moveTo(dying.pos.x, dying.pos.y);
      crack.joints.forEach((wobble, i) => {
        const d = Math.min(jointStep * (i + 1), maxLen);
        const a = crack.angle + crack.wobble * Math.sin(i + 1) * 0.4 + wobble * 0.35;
        ctx.lineTo(dying.pos.x + Math.cos(a) * d, dying.pos.y + Math.sin(a) * d);
      });
      ctx.lineTo(dying.pos.x + Math.cos(crack.angle) * len, dying.pos.y + Math.sin(crack.angle) * len);
      ctx.stroke();
    }
  }

  /** The wedge-shaped pieces the cracks split the body into, each drifting off on its own. */
  function drawShards(dying, ashProgress) {
    const alpha = 1 - ashProgress;
    if (alpha <= 0.01) return;
    const dist = 4 * ashProgress ** 1.4;
    const scale = 1 - ashProgress * 0.55;
    for (const shard of dying.shards) {
      const driftDist = shard.driftSpeed * dist;
      const ox = dying.pos.x + Math.cos(shard.driftAngle) * driftDist;
      const oy = dying.pos.y + Math.sin(shard.driftAngle) * driftDist;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(shard.spin * ashProgress);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, DYING_CORE_RADIUS * scale, shard.startAngle, shard.endAngle);
      ctx.closePath();
      ctx.fillStyle = `rgba(${ ASH_GREY.join(',') }, ${ alpha })`;
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Public render ─────────────────────────────────────────────────────
  function render(data) {
    const previousFocus = focusedId;
    stars = buildStars(data);

    const idsNow = new Set(stars.map((s) => s.id));
    for (const id of animState.keys()) if (!idsNow.has(id)) animState.delete(id);

    renderStarButtons();

    if (pendingBurstId) {
      const newStar = stars.find((s) => s.id === pendingBurstId);
      if (newStar) {
        spawnStarBirth(newStar);
        playSfx('starBorn');
      }
      pendingBurstId = null;
    }

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
    announceNewStar,
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
      ambient.pause();
    },
  };
}
