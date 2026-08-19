/**
 * Applies a per-project Theme to the document root so the --accent CSS
 * variable switches instantly across every panel.
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
