/** Minimal HTML-escape for interpolating trusted-but-not-guaranteed strings
 *  (chord names, note spellings) into innerHTML. */
export function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
