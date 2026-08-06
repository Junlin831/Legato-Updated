/**
 * Applies a per-project Theme to the document root so CSS variables and the
 * chord-font attribute switch instantly across every panel.
 *
 * The two knobs (see js/state.js `Theme`) are:
 *   - accent hex     → CSS `--accent`  (drives all accent-tinted UI; other
 *                      panels derive translucent variants via color-mix)
 *   - chordFont      → attribute `data-chord-font` on <html> ('jazztext' |
 *                      'classical' | 'scifi'); base.css swaps --font-chord
 *                      and the matching weight/style off this attribute.
 *
 * editor-view calls applyTheme on mount and whenever project settings change,
 * and clearTheme on unmount so the landing page falls back to the base.css
 * defaults (Amber + Sci-Fi).
 */

/** @param {import('./state.js').Theme} theme */
export function applyTheme(theme) {
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent);
    root.dataset.chordFont = theme.chordFont;
}

export function clearTheme() {
    const root = document.documentElement;
    root.style.removeProperty('--accent');
    delete root.dataset.chordFont;
}
