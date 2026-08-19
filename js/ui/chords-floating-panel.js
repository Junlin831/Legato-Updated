/**
 * The "Chords" workspace as a small floating, draggable card — a
 * picture-in-picture window rather than a panel docked to an edge. Opened
 * and closed by a round button on the sheet's toolbar (see
 * sheet-music-panel.js), it never resizes the notation stage: it's
 * `position: fixed`, entirely outside the document flow, fixed-size, and
 * the user can park it anywhere over empty space by dragging its header.
 *
 * Two independent states:
 *   - open/closed — driven by the round toggle button (toggle()/isOpen()).
 *   - collapsed/expanded — the card's own chevron, hides the body while
 *     keeping the header (and its position) in place.
 *
 * The outer `.chords-floating-wrapper` is what's actually positioned/
 * dragged; the card is just its first child. That leaves room for a second
 * child — the bar-number minimap (see chords-minimap.js) — glued to the
 * card's edge and carried along by every drag without any position-syncing
 * code, and free of the card's own `overflow: hidden` since it never has
 * to sit inside it.
 *
 * `bodyContainer` is handed to mountEditorPanel as its `bodyContainer`, so
 * the actual Chords section markup/logic is untouched — only the chrome
 * around it changed.
 */
import { icon } from './icons.js';

const CARD_WIDTH = 340;
const CARD_HEIGHT = 460;
const EDGE_MARGIN = 16;

const TEMPLATE = `
<div class="chords-floating-wrapper">
  <div class="chords-floating-card" role="dialog" aria-label="Chords">
    <header class="chords-floating-header">
      <span class="chords-floating-title">Chords</span>
      <button type="button" class="chords-floating-collapse" aria-label="Collapse chords panel" aria-expanded="true">
        ${ icon('chevronDown') }
      </button>
    </header>
    <div class="chords-floating-body"></div>
  </div>
  <div class="chords-minimap-mount"></div>
</div>
`;

export function mountChordsFloatingPanel({ container }) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const wrapper = container.querySelector('.chords-floating-wrapper');
  const card = wrapper.querySelector('.chords-floating-card');
  const header = card.querySelector('.chords-floating-header');
  const collapseBtn = card.querySelector('.chords-floating-collapse');
  const bodyContainer = card.querySelector('.chords-floating-body');
  const minimapMount = wrapper.querySelector('.chords-minimap-mount');

  card.style.width = `${ CARD_WIDTH }px`;
  card.style.height = `${ CARD_HEIGHT }px`;

  let open = false;
  let collapsed = false;
  let positioned = false;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Default parking spot: upper-right, clear of the round toggle button. */
  function defaultPosition() {
    return {
      left: Math.max(EDGE_MARGIN, window.innerWidth - CARD_WIDTH - 28),
      top: 84,
    };
  }

  function clampToViewport(left, top) {
    return {
      left: clamp(left, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerWidth - CARD_WIDTH - EDGE_MARGIN)),
      top: clamp(top, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerHeight - EDGE_MARGIN - 40)),
    };
  }

  function setPosition(left, top) {
    const clamped = clampToViewport(left, top);
    wrapper.style.left = `${ clamped.left }px`;
    wrapper.style.top = `${ clamped.top }px`;
  }

  function ensurePositioned() {
    if (positioned) return;
    const { left, top } = defaultPosition();
    setPosition(left, top);
    positioned = true;
  }

  // Re-clamp on viewport resize so the card never gets stranded off-screen
  // (e.g. shrinking the window after a drag near the old edge).
  window.addEventListener('resize', () => {
    if (!positioned) return;
    const rect = wrapper.getBoundingClientRect();
    setPosition(rect.left, rect.top);
  });

  // ── Drag ──────────────────────────────────────────────────────────
  const DRAG_THRESHOLD_PX = 4;
  let dragPointerId = null;
  let dragMoved = false;
  let startX = 0;
  let startY = 0;
  let grabOffsetX = 0;
  let grabOffsetY = 0;

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.chords-floating-collapse')) return;
    dragPointerId = event.pointerId;
    dragMoved = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = card.getBoundingClientRect();
    grabOffsetX = event.clientX - rect.left;
    grabOffsetY = event.clientY - rect.top;
    header.setPointerCapture(dragPointerId);
  });
  header.addEventListener('pointermove', (event) => {
    if (event.pointerId !== dragPointerId) return;
    if (!dragMoved) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragMoved = true;
      wrapper.classList.add('is-dragging');
    }
    setPosition(event.clientX - grabOffsetX, event.clientY - grabOffsetY);
  });
  function endDrag(event) {
    if (event.pointerId !== dragPointerId) return;
    if (header.hasPointerCapture(dragPointerId)) header.releasePointerCapture(dragPointerId);
    dragPointerId = null;
    wrapper.classList.remove('is-dragging');
  }
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  // ── Collapse (body hidden, header + position stay put) ──────────────
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    card.classList.toggle('is-collapsed', collapsed);
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand chords panel' : 'Collapse chords panel');
  });

  // ── Open/close (the round toggle button on the sheet) ────────────────
  function setOpen(next) {
    open = next;
    if (open) ensurePositioned();
    wrapper.classList.toggle('is-open', open);
  }

  return {
    bodyContainer,
    minimapMount,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    unmount() {
      wrapper.remove();
    },
  };
}
