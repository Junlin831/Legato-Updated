/**
 * Shared UI icon markup. Icons inherit their colour from the control that
 * contains them, so every surface can style the same icon through CSS.
 */
const ICONS = Object.freeze({
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="m14.5 4.5 5 5-9.5 9.5H5v-5z"/><path d="m12.5 6.5 5 5"/>',
  rename: '<path d="M4 20h4l10.5-10.5-4-4L4 16v4zM13.5 6.5l4 4"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  export: '<path d="M12 15V3M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v7M14 11v7"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5.5v13l10-6.5z"/>',
  pause: '<path fill="currentColor" stroke="none" d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  github: '<path fill="currentColor" stroke="none" d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.89-2.78.62-3.37-1.2-3.37-1.2-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .08 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.05A9.35 9.35 0 0 1 12 6.37c.85 0 1.7.12 2.5.35 1.91-1.32 2.75-1.05 2.75-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.89 0 1.36-.01 2.46-.01 2.79 0 .27.18.59.69.49A10.24 10.24 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2.5 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  density: '<path d="M5 6h14M5 12h14M5 18h14"/>',
  // Whole rest: a filled block hanging beneath a staff line.
  rest: '<path d="M4 9h16"/><rect x="9" y="9" width="6" height="4.5" rx="0.5" fill="currentColor" stroke="none"/>',
  fastForward: '<path fill="currentColor" stroke="none" d="M3 6.5v11l8-5.5z"/><path fill="currentColor" stroke="none" d="M12 6.5v11l8-5.5z"/>',
  volumeOn: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/>',
  volumeOff: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m17 9 5 6M22 9l-5 6"/>',
});

export function icon(name, className = '') {
  const markup = ICONS[name];
  if (!markup) throw new Error(`Unknown UI icon: ${ name }`);
  const classes = `ui-icon${ className ? ` ${ className }` : '' }`;
  return `<svg class="${ classes }" data-icon="${ name }" viewBox="0 0 24 24" aria-hidden="true">${ markup }</svg>`;
}
