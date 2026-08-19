// state.js for LEGATO.
import { compileProgression } from './engine/compile.js';
//
// THE CONTRACT. Three branches build against this shape; lock it before anyone diverges.
// Prose, reasoning, and worked examples live in docs/DATA-MODEL.md — this file is the
// authoritative TYPES + factories. If the two ever disagree, these types win.
//
// One line: UI mutates `progression` -> compile() -> one segment list -> render + audio + bars.

// ─────────────────────────────────────────────────────────────────────────────
// TYPES (JSDoc so Codex + editors get autocomplete without a build step)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'Major'|'Minor'|'Dom7'|'Maj7'|'Min7'|'Dim'|'Dim7'|'m7b5'|'Sus2'|'Sus4'|'Aug'} Quality
 */

/**
 * @typedef {'passingDim'|'secondaryDom'|'tritoneSub'|'ii_v_i'|'susPassing'|'leadingTone'|'scaleRun'|'arpBridge'} TechniqueId
 */

/**
 * @typedef {Object} TimeSig
 * @property {number} num  Numerator (e.g. 5 in 5/4).
 * @property {number} den  Denominator (e.g. 4 in 5/4).
 */

/**
 * Purely visual per-project preferences. Not read by compile()/audio/render;
 * only editor-view applies them (CSS custom property + <html> attribute).
 * @typedef {Object} Theme
 * @property {string} accent     Fixed to DEFAULT_ACCENT. Drives the CSS --accent variable.
 * @property {'scifi'} chordFont  Fixed to DEFAULT_CHORD_FONT. Which family renders chord symbols and project titles.
 */

/**
 * @typedef {Object} Settings
 * @property {number}  tempo     BPM. PLAYER-ONLY — compile() ignores it.
 * @property {TimeSig} timeSig   Structural. measureLength (quarter-beats) = num * 4 / den.
 * @property {'simple'|'compound'} meterType  Immutable project-creation choice, derived from timeSig.
 * @property {number}  key       Key signature on the circle of fifths, -7..+7. Sharps +, flats −.
 *                               Notation-only: drives enharmonic spelling and printed accidentals.
 *                               Never mutates chord.notes. Transposition is a separate feature.
 * @property {'auto'|'treble'|'bass'} clef  One clef, no grand staff. 'auto' resolved at render time.
 * @property {'loose'|'compact'|'dense'} cardDensity  How tightly chord cards pack in the editor list.
 * @property {Theme}   theme     Visual preferences (accent color, chord-symbol font).
 */

/**
 * Display-only name hint. compile()/audio/render NEVER read this. Set by the quality-assisted
 * input path so a row names itself instantly without the detector. Drop it if the user edits
 * `notes` so they no longer match.
 * @typedef {Object} ChordHint
 * @property {number}  rootMidi
 * @property {Quality} quality
 */

/**
 * The notes ARE the chord. Never re-voiced — what's stored is what plays. Voicing, octave,
 * doubling, and inversion are all encoded implicitly in `notes`.
 * @typedef {Object} Chord
 * @property {string}     id     Stable, within-project-unique. SortableJS + edit/delete key.
 * @property {number[]}   notes  Exact MIDI notes (full keyboard 21..108). Empty iff `rest`.
 * @property {number}     bars   Duration in bars (min 0.5, step 0.5).
 * @property {boolean}   [rest]  True for a silence item: no notes, drawn as rests,
 *                               skipped by playback and ineligible for techniques.
 * @property {ChordHint} [hint]  Optional display-only name hint.
 */

/**
 * @typedef {Object} Progression
 * @property {Settings}                 settings
 * @property {Chord[]}                  chords
 * @property {Array<TechniqueId|null>}  seams   length === chords.length - 1. Stores KEYS, not notes.
 */

/**
 * @typedef {Object} Project
 * @property {string}      id
 * @property {string}      name
 * @property {string}      createdAt   ISO
 * @property {string}      updatedAt   ISO
 * @property {Progression} progression
 */

/**
 * compile()'s output unit: one atomic, fully-resolved, notatable-and-playable event.
 * @typedef {Object} Segment
 * @property {number[]}    notes         Resolved pitches (post voice-leading for techniques).
 * @property {number}      durationBeats One standard note-value (from [4,3,2,1,0.5,0.25]).
 * @property {boolean}     isTechnique   Colour: generated (technique) vs. user-entered.
 * @property {string}      sourceId      TIES: adjacent segments sharing this get a StaveTie.
 * @property {number|null} seamIndex     Which seam produced it; null for user chords.
 * @property {number}      measureIndex  Which stave this draws on.
 * @property {number}      startBeat     MEASURE-RELATIVE. Absolute = measureIndex*measureLength + startBeat.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

/** Ordered set of technique keys. The registry bodies live in engine/techniques.js. */
export const TECHNIQUE_IDS = /** @type {const} */ ([
    'passingDim', 'secondaryDom', 'tritoneSub', 'ii_v_i',
    'susPassing', 'leadingTone', 'scaleRun', 'arpBridge',
]);

/** Greedy decomposition values, largest-first. 0.25 (sixteenth) MUST stay in this list. */
export const STANDARD_DURATIONS = [4, 3, 2, 1, 0.5, 0.25];

/** Closest-voicing search window (narrower than the 21..108 input range, on purpose). */
export const VOICING_MIN_MIDI = 40;
export const VOICING_MAX_MIDI = 88;
export const VOICING_MAX_SPAN = 16; // semitones; discard wider candidates

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED HELPERS (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Quarter-beats per measure for a given time signature. e.g. 5/4 -> 5, 12/8 -> 6. */
export function measureLength(timeSig) {
    return timeSig.num * 4 / timeSig.den;
}

/** Total quarter-beats a chord nominally occupies before any technique borrows from its tail. */
export function chordTotalBeats(chord, timeSig) {
    return chord.bars * measureLength(timeSig);
}

/**
 * Beats a technique may borrow from the departing chord's tail.
 * Always leave >=1 beat sounding; never borrow >4.
 */
export function availableBeats(departingTotalBeats) {
    return Math.max(0, Math.min(departingTotalBeats - 1, 4));
}

/** Whether a transition technique fits into the departing chord's available tail. */
export function isTechniqueUsable(technique, departingChord, timeSig) {
    return technique.beatCost <= availableBeats(chordTotalBeats(departingChord, timeSig));
}

// ─────────────────────────────────────────────────────────────────────────────
// USER-FACING BEATS — the UI shows "beats", state stores `bars`.
// One "beat" == what a pianist counts: quarter note in simple meter, dotted
// quarter in compound. Converters live here so no UI code has to reason about
// the meter/beat relationship. compile() only ever sees `bars`.
// ─────────────────────────────────────────────────────────────────────────────

/** 6/8, 9/8, 12/8. Compound meters group eighth notes into dotted-quarter beats. */
export function isCompoundMeter(timeSig) {
    return timeSig.den === 8 && timeSig.num % 3 === 0 && timeSig.num >= 6;
}

/** UI duration choices expressed in the meter's counted beats. Compound
 * meters count dotted-quarter beats, so half and dotted counted beats are
 * deliberately excluded there. */
export const SIMPLE_BEAT_CHOICES = [0.5, 1, 1.5, 2, 3, 4, 6, 8];
export const COMPOUND_BEAT_CHOICES = [1, 2, 3, 4, 6, 8];

export function beatChoicesForMeter(timeSig) {
    return isCompoundMeter(timeSig) ? COMPOUND_BEAT_CHOICES : SIMPLE_BEAT_CHOICES;
}

/** Length of one user-facing beat in quarter-beats. Dotted-quarter (1.5) if compound, else 4/den. */
export function beatValue(timeSig) {
    return isCompoundMeter(timeSig) ? 1.5 : 4 / timeSig.den;
}

/** User-facing beats per bar. e.g. 4 in 4/4, 3 in 3/4, 2 in 6/8. */
export function beatsPerBar(timeSig) {
    return measureLength(timeSig) / beatValue(timeSig);
}

export function beatsToBars(beats, timeSig) { return beats / beatsPerBar(timeSig); }
export function barsToBeats(bars, timeSig) { return bars * beatsPerBar(timeSig); }

let _idCounter = 0;
/** Simple stable id. Swap for crypto.randomUUID() if you prefer. */
export function newId(prefix = 'c') {
    return `${ prefix }${ (++_idCounter).toString(36) }${ Date.now().toString(36) }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORIES — always build state through these so the shape stays consistent
// ─────────────────────────────────────────────────────────────────────────────

/** Global tempo bounds. Every UI that lets the user edit tempo — project
 *  settings modal, sheet-music-panel overrides — must clamp to this range so
 *  no path can create a progression the validator would reject. */
export const TEMPO_MIN = 1;
export const TEMPO_MAX = 500;
export const TEMPO_DEFAULT = 100;

export const DEFAULT_ACCENT = '#E8A94B';
export const DEFAULT_CHORD_FONT = 'scifi';

/** How tightly chord cards pack in the progression list. Edited in project
 *  settings; the editor panel just renders whatever's in Settings. */
export const CARD_DENSITIES = /** @type {const} */ (['loose', 'compact', 'dense']);
const CARD_DENSITY_SET = new Set(CARD_DENSITIES);
export const DEFAULT_CARD_DENSITY = 'loose';

/** @returns {Theme} */
export function makeTheme() {
    return { accent: DEFAULT_ACCENT, chordFont: DEFAULT_CHORD_FONT };
}

/** @returns {Settings} */
export function makeSettings(overrides = {}) {
    const timeSig = overrides.timeSig
        ? { ...overrides.timeSig }
        : { num: 4, den: 4 };
    const meterType = isCompoundMeter(timeSig) ? 'compound' : 'simple';
    return {
        tempo: TEMPO_DEFAULT,
        timeSig,
        meterType,
        key: 0,
        clef: 'auto',
        cardDensity: DEFAULT_CARD_DENSITY,
        ...overrides,
        timeSig,
        meterType,
        cardDensity: CARD_DENSITY_SET.has(overrides.cardDensity) ? overrides.cardDensity : DEFAULT_CARD_DENSITY,
        theme: makeTheme(),
    };
}

/**
 * @param {number[]} notes
 * @param {number}   bars
 * @param {ChordHint} [hint]
 * @returns {Chord}
 */
export function makeChord(notes, bars = 1, hint) {
    return { id: newId('c'), notes: [...notes], bars, ...(hint ? { hint } : {}) };
}

/**
 * A silence item that lives in the chord list. Occupies time like a chord,
 * plays nothing, renders as rests, and can never carry a transition technique.
 * @param {number} bars
 * @returns {Chord}
 */
export function makeRest(bars = 1) {
    return { id: newId('r'), notes: [], bars, rest: true };
}

/** True when a chord-list item is a rest (silence). */
export function isRest(chord) {
    return Boolean(chord?.rest) || (Array.isArray(chord?.notes) && chord.notes.length === 0);
}

/**
 * Creates a progression with exactly one seam per adjacent chord pair.
 * Callers may provide only the leading seams they care about; omitted seams
 * are direct transitions and excess entries are ignored.
 *
 * @returns {Progression}
 */
export function makeProgression(overrides = {}) {
    // makeSettings normalizes any partial input (fills theme + timeSig defaults),
    // so callers passing a bare {tempo, timeSig, key, clef} still land on a
    // well-formed Settings shape without every call site having to remember.
    const settings = makeSettings(overrides.settings ?? {});
    const progression = {
        settings,
        chords: [],
        seams: [],
        ...overrides,
        settings,
        chords: overrides.chords ?? [],
        seams: overrides.seams ?? [],
    };
    return {
        ...progression,
        seams: Array.from(
            { length: Math.max(0, progression.chords.length - 1) },
            (_, index) => progression.seams[index] ?? null,
        ),
    };
}

/** @returns {Project} */
export function makeProject(name = 'Untitled', progression = makeProgression()) {
    const now = new Date().toISOString();
    return { id: newId('p'), name, createdAt: now, updatedAt: now, progression };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM MAINTENANCE — preserve seams where adjacency is unchanged, null the rest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a reorder/delete, rebuild the seams array so a seam survives only if its exact
 * ordered (chordA.id -> chordB.id) adjacency existed before and had a technique.
 *
 * @param {Chord[]} prevChords
 * @param {Array<TechniqueId|null>} prevSeams
 * @param {Chord[]} nextChords
 * @returns {Array<TechniqueId|null>}
 */
export function reconcileSeams(prevChords, prevSeams, nextChords) {
    /** @type {Map<string, TechniqueId>} */
    const byAdjacency = new Map();
    for (let i = 0; i < prevSeams.length; i++) {
        const t = prevSeams[i];
        if (t) byAdjacency.set(`${ prevChords[i].id }->${ prevChords[i + 1].id }`, t);
    }
    const next = [];
    for (let i = 0; i < nextChords.length - 1; i++) {
        const key = `${ nextChords[i].id }->${ nextChords[i + 1].id }`;
        next.push(byAdjacency.get(key) ?? null);
    }
    return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION — used on import. Malformed input must fail gracefully, not throw upstream.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate + normalize an imported progression. Unknown technique keys become null (+warning)
 * rather than crashing. Returns the cleaned progression plus any warnings for the UI.
 *
 * @param {any} raw
 * @returns {{ ok: boolean, progression?: Progression, warnings: string[], error?: string }}
 */
export function validateProgression(raw) {
    const warnings = [];
    try {
        if (!raw || typeof raw !== 'object') return { ok: false, warnings, error: 'Not an object.' };

        const s = raw.settings ?? {};
        const settings = makeSettings({
            tempo: Number.isFinite(s.tempo) && s.tempo >= TEMPO_MIN && s.tempo <= TEMPO_MAX ? s.tempo : TEMPO_DEFAULT,
            timeSig: (s.timeSig && Number.isInteger(s.timeSig.num) && s.timeSig.num > 0
                && Number.isInteger(s.timeSig.den) && [2, 4, 8, 16].includes(s.timeSig.den))
                ? { num: s.timeSig.num, den: s.timeSig.den } : { num: 4, den: 4 },
            key: Number.isInteger(s.key) && s.key >= -7 && s.key <= 7 ? s.key : 0,
            clef: ['auto', 'treble', 'bass'].includes(s.clef) ? s.clef : 'auto',
            // Missing/invalid theme silently defaults — pre-revamp saved
            // projects should open on the new look without warnings.
            theme: s.theme,
        });

        if (!Array.isArray(raw.chords)) return { ok: false, warnings, error: 'chords is not an array.' };
        const chords = raw.chords.map((c, i) => {
            const isRestItem = Boolean(c?.rest);
            if (isRestItem) {
                if (!Number.isFinite(c.bars) || c.bars <= 0 || c.bars > 32) {
                    throw new Error(`Rest ${ i } has invalid bar duration.`);
                }
                return { id: typeof c.id === 'string' ? c.id : newId('r'), notes: [], bars: c.bars, rest: true };
            }
            if (!c || !Array.isArray(c.notes) || c.notes.length === 0
                || !c.notes.every((note) => Number.isInteger(note) && note >= 21 && note <= 108)) {
                throw new Error(`Chord ${ i } has invalid notes.`);
            }
            if (!Number.isFinite(c.bars) || c.bars <= 0 || c.bars > 32) {
                throw new Error(`Chord ${ i } has invalid bar duration.`);
            }
            return {
                id: typeof c.id === 'string' ? c.id : newId('c'),
                notes: [...c.notes],
                bars: c.bars,
                ...(c.hint && Number.isInteger(c.hint.rootMidi) ? { hint: c.hint } : {}),
            };
        });

        const rawSeams = Array.isArray(raw.seams) ? raw.seams : [];
        const seams = [];
        for (let i = 0; i < chords.length - 1; i++) {
            const t = rawSeams[i];
            if (t == null) { seams.push(null); continue; }
            if (TECHNIQUE_IDS.includes(t)) { seams.push(t); }
            else { seams.push(null); warnings.push(`Unknown technique "${ t }" at seam ${ i } — dropped.`); }
        }

        return { ok: true, progression: { settings, chords, seams }, warnings };
    } catch (err) {
        return { ok: false, warnings, error: err instanceof Error ? err.message : String(err) };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// compile() — THE pure translation: intent -> concrete segments.
// Signature + contract locked here; body is Eric's (engine/*). See DATA-MODEL.md §2.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure. Turns a progression into an ordered Segment[] that render, audio, and the bar-effect
 * all read from the SAME list (so what you see == what you hear).
 *
 * Responsibilities:
 *   1. Voice-lead auto-generated technique material (NEVER the user's chords) toward whatever
 *      sounds immediately before it (engine/voicing.js).
 *   2. Decompose each duration into STANDARD_DURATIONS pieces, cap technique run-length via
 *      maxNotes = floor(B / 0.25) (engine/rhythm.js).
 *   3. Lay pieces into measures of measureLength(timeSig) beats; tag ties via shared sourceId.
 *
 * @param {Progression} progression
 * @returns {Segment[]}
 */
export function compile(progression) {
    return compileProgression(progression);
}
