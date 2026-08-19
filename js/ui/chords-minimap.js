/**
 * A small "field of view" grid glued to the top-left side of the floating
 * Chords card (see chords-floating-panel.js) — every bar of the progression
 * as a numbered cell, standing in for the full notation so the shape of the
 * progression is visible without opening the sheet.
 *
 * It has no scroll of its own: the whole grid is always shown, wrapping into
 * rows. The column count is NOT a fixed constant — it mirrors however many
 * bars the real sheet fits on one line (`measuresPerSystem`, reported by
 * sheet-music-panel.js's `onNotationLayoutChange`), so line 1 of the minimap
 * always matches line 1 of the actual score instead of wrapping on its own
 * unrelated schedule. What moves is a highlight — editor-panel.js tracks
 * which chord rows are visible in the (actually scrollable) chord list and
 * reports the matching bar range here via `setVisibleRange`, so the
 * highlighted cells shift as the user scrolls the real list, the way a
 * scrollbar thumb tracks its content.
 */
const TEMPLATE = `<div class="chords-minimap" aria-hidden="true"></div>`;

export function mountChordsMinimap({ container }) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const root = container.querySelector('.chords-minimap');

  let barEls = [];

  function render(measureCount, columns = 4) {
    const safeColumns = Math.max(1, columns);
    root.style.setProperty('--minimap-columns', String(safeColumns));
    root.replaceChildren();
    barEls = Array.from({ length: measureCount }, (_, index) => {
      const bar = document.createElement('div');
      bar.className = 'chords-minimap-bar';
      if ((index + 1) % safeColumns === 0) bar.classList.add('is-row-end');
      bar.textContent = String(index + 1);
      root.append(bar);
      return bar;
    });
  }

  /** @param {{start: number, end: number} | null} range 1-indexed, inclusive. */
  function setVisibleRange(range) {
    barEls.forEach((bar, index) => {
      const barNumber = index + 1;
      bar.classList.toggle('is-visible', !!range && barNumber >= range.start && barNumber <= range.end);
    });
  }

  return {
    render,
    setVisibleRange,
    unmount() {
      root.remove();
    },
  };
}
