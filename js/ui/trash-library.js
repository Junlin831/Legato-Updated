/**
 * The Trash — an abandoned library. Deleted projects sit as small grey,
 * dust-dulled stars along a stack of shelves; the user can drag one around
 * (horizontally free, vertically pulled back down to the shelf by a small
 * gravity-drop bounce on release — no full physics engine, just a clamped
 * drag plus one settle keyframe), and recover it via hover → Recover →
 * Confirm, mirroring the delete-confirmation shape on the constellation map.
 *
 * Stars are plain DOM (no canvas): there's no need for constellation-map's
 * hybrid canvas+hit-target split here since shelf items are discrete and
 * never overlap, so a simple radial-gradient div plus a real <button> for
 * each one is enough.
 */
import { escapeHtml } from '../util/html.js';
import { icon } from './icons.js';
import { playSfx } from '../audio/sfx.js';
import { randomFor } from '../util/seeded-random.js';

const MIN_SHELVES = 4;
const ITEMS_PER_SHELF_SOFT_CAP = 6;
const STAR_MARGIN_PX = 30;
const LIFT_UP_MAX_PX = 46;
const LIFT_DOWN_MAX_PX = 6;
const DRAG_THRESHOLD_PX = 5;
const RECOVER_BLINK_MS = 620;

const TEMPLATE = `
<div class="trash-shell">
  <header class="trash-topbar">
    <button class="trash-brand" type="button" aria-label="Back to your constellation">
      <img class="brand-mark" src="/assets/brand/legato-icon.png" alt="" draggable="false">
      <span class="brand">LEGATO</span>
    </button>
    <div class="trash-heading">
      <h1>The Trash</h1>
      <p>Deleted stars gather dust here until you either recover them or let them go for good.</p>
    </div>
    <div class="trash-utility">
      <button id="trash-empty" class="trash-empty-btn" type="button">${ icon('trash') }<span>Empty Trash</span></button>
      <button id="trash-back" class="icon-button is-bordered" type="button" aria-label="Back to your constellation">${ icon('chevronLeft') }</button>
    </div>
  </header>
  <div id="trash-notice" class="constellation-notice" hidden></div>
  <div id="trash-stage" class="trash-stage"></div>
</div>
`;

const STAR_TEMPLATE = (id, name) => `
<div class="trash-star" data-id="${ id }">
  <button type="button" class="trash-star-hit" aria-label="Deleted project: ${ escapeHtml(name) }"></button>
  <div class="trash-star-visual" aria-hidden="true"></div>
  <div class="trash-star-panel">
    <div class="trash-star-name">${ escapeHtml(name) }</div>
    <div class="trash-star-actions" data-step="idle">
      <button type="button" class="trash-star-recover" data-action="recover">Recover</button>
    </div>
  </div>
</div>
`;

export function mountTrashLibrary({ container, callbacks }) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const shell = container.querySelector('.trash-shell');
  const stage = shell.querySelector('#trash-stage');
  const noticeEl = shell.querySelector('#trash-notice');
  const emptyBtn = shell.querySelector('#trash-empty');
  const backBtn = shell.querySelector('#trash-back');
  const brandBtn = shell.querySelector('.trash-brand');

  brandBtn.addEventListener('click', () => callbacks.onBack());
  backBtn.addEventListener('click', () => callbacks.onBack());
  emptyBtn.addEventListener('click', () => callbacks.onEmptyTrash());

  let items = [];
  let destroyed = false;

  function render(trashed) {
    items = trashed;
    emptyBtn.disabled = !items.length;
    stage.replaceChildren();

    const shelfCount = Math.max(MIN_SHELVES, Math.ceil(items.length / ITEMS_PER_SHELF_SOFT_CAP));
    const shelves = Array.from({ length: shelfCount }, () => {
      const shelf = document.createElement('div');
      shelf.className = 'trash-shelf';
      shelf.innerHTML = '<div class="trash-shelf-back"></div><div class="trash-shelf-plank"></div>';
      stage.append(shelf);
      return shelf;
    });

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'trash-empty-state';
      empty.innerHTML = `
        <p class="trash-empty-headline">The shelves are bare.</p>
        <p class="trash-empty-copy">Nothing has been forgotten here — yet.</p>
      `;
      // Anchored to one shelf (its own upper area, above the plank) rather
      // than centered across the whole stage — spanning the full stage put
      // the text squarely on top of a plank line whenever the shelf count
      // and gap happened to land the vertical center there.
      shelves[Math.floor(shelves.length / 2)].append(empty);
      return;
    }

    items.forEach((project, index) => {
      const shelf = shelves[index % shelves.length];
      mountStar(shelf, project);
    });
  }

  function mountStar(shelf, project) {
    shelf.insertAdjacentHTML('beforeend', STAR_TEMPLATE(project.id, project.name));
    const star = shelf.lastElementChild;
    const hit = star.querySelector('.trash-star-hit');
    const panel = star.querySelector('.trash-star-panel');
    const actions = star.querySelector('.trash-star-actions');

    const rand = randomFor(project.id);
    // Deterministic per id, so reopening the trash doesn't reshuffle where a
    // still-unrecovered star sits — same spirit as the constellation map's
    // seeded layout.
    const restOffset = (rand() - 0.5) * 8;
    star.style.setProperty('--rest-offset', `${ restOffset }px`);
    // Reading clientWidth forces the pending layout synchronously, so this is
    // already accurate even though the shelf was only just inserted — no
    // need to wait for a resize/paint callback.
    const shelfWidth = shelf.clientWidth || 300;
    const span = Math.max(1, shelfWidth - STAR_MARGIN_PX * 2);
    let x = STAR_MARGIN_PX + rand() * span;
    star.style.left = `${ x }px`;

    // ── Hover / tap reveals the Recover panel ──────────────────────────
    let active = false;
    function setActive(next) {
      active = next;
      star.classList.toggle('is-active', active);
      if (!active) resetToIdle();
    }
    hit.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      setActive(true);
    });
    star.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      if (!confirming) setActive(false);
    });
    hit.addEventListener('click', () => {
      if (dragMoved) { dragMoved = false; return; }
      setActive(!active);
    });

    let confirming = false;
    function resetToIdle() {
      confirming = false;
      actions.dataset.step = 'idle';
      actions.innerHTML = `<button type="button" class="trash-star-recover" data-action="recover">Recover</button>`;
      actions.querySelector('[data-action="recover"]').onclick = (event) => {
        event.stopPropagation();
        confirming = true;
        actions.dataset.step = 'confirm';
        actions.innerHTML = `
          <span class="trash-confirm-copy">Recover "${ escapeHtml(project.name) }"?</span>
          <div class="trash-confirm-actions">
            <button type="button" class="constellation-panel-primary" data-action="confirm">Recover</button>
            <button type="button" class="constellation-panel-secondary" data-action="cancel">Cancel</button>
          </div>
        `;
        actions.querySelector('[data-action="confirm"]').onclick = (e) => { e.stopPropagation(); recover(); };
        actions.querySelector('[data-action="cancel"]').onclick = (e) => { e.stopPropagation(); resetToIdle(); setActive(false); };
      };
    }
    resetToIdle();

    function recover() {
      playSfx('select');
      star.classList.add('is-recovering');
      window.setTimeout(() => {
        if (destroyed) return;
        star.classList.add('is-leaving');
        window.setTimeout(() => {
          if (!destroyed) star.remove();
          callbacks.onRecover(project.id);
        }, 260);
      }, RECOVER_BLINK_MS);
    }

    // ── Drag: free horizontally within the shelf, lifted vertically while
    // held, gravity-dropped back onto the shelf surface on release ────────
    let dragPointerId = null;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;

    hit.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || confirming) return;
      dragPointerId = event.pointerId;
      dragMoved = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = x ?? 0;
      hit.setPointerCapture(dragPointerId);
    });
    hit.addEventListener('pointermove', (event) => {
      if (event.pointerId !== dragPointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragMoved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragMoved = true;
        star.classList.add('is-dragging');
        star.classList.remove('is-dropping');
        setActive(false);
      }
      const width = shelf.clientWidth || 300;
      x = Math.min(Math.max(startLeft + dx, STAR_MARGIN_PX), Math.max(STAR_MARGIN_PX, width - STAR_MARGIN_PX));
      star.style.left = `${ x }px`;
      const lift = Math.min(LIFT_DOWN_MAX_PX, Math.max(-LIFT_UP_MAX_PX, dy));
      star.style.setProperty('--lift', `${ lift }px`);
    });
    function endDrag(event) {
      if (event.pointerId !== dragPointerId) return;
      if (hit.hasPointerCapture(dragPointerId)) hit.releasePointerCapture(dragPointerId);
      dragPointerId = null;
      if (!dragMoved) return;
      star.classList.remove('is-dragging');
      star.style.setProperty('--drop-from', star.style.getPropertyValue('--lift') || '0px');
      star.style.removeProperty('--lift');
      star.classList.add('is-dropping');
      star.addEventListener('animationend', () => star.classList.remove('is-dropping'), { once: true });
    }
    hit.addEventListener('pointerup', endDrag);
    hit.addEventListener('pointercancel', endDrag);
  }

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
    },
  };
}
