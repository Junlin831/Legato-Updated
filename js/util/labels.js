/**
 * Human-readable label helpers for the Settings shape.
 *
 * Shared so every panel that surfaces tempo / time signature / key produces
 * the same wording; the project settings modal owns its own richer copy
 * ("C major / A minor · no accidentals") because it has room for a longer
 * form, but everything else should route through these tokens.
 */

/**
 * Major-key name for a circle-of-fifths integer (-7..+7). Enharmonic keys
 * (±7, ±6) render with the sharp or flat sign matching the sign of `key`.
 *
 * @param {number} key
 * @returns {string} e.g. 'C major', 'G major', 'D♭ major'.
 */
export function majorKeyName(key) {
    return `${ MAJOR_KEY_NAMES[key] ?? 'C' } major`;
}

const MAJOR_KEY_NAMES = {
    [-7]: 'C♭', [-6]: 'G♭', [-5]: 'D♭', [-4]: 'A♭',
    [-3]: 'E♭', [-2]: 'B♭', [-1]: 'F', [0]: 'C',
    [1]: 'G',  [2]: 'D',  [3]: 'A',  [4]: 'E',
    [5]: 'B',  [6]: 'F♯', [7]: 'C♯',
};

/**
 * @param {import('../state.js').TimeSig} timeSig
 * @returns {string} e.g. '4/4', '6/8'.
 */
export function timeSigLabel(timeSig) {
    return `${ timeSig.num }/${ timeSig.den }`;
}
