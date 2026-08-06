/**
 * Chord vocabulary + note-name helpers.
 *
 * QUALITIES is the single source of truth for what triads/tetrads the app
 * understands. Every quality-driven path (piano modal chip row, `notesFrom`
 * used by demo data, `inferChordIdentity` used by the engine and the piano
 * modal, and the eight transition techniques) reads from this table.
 */
import { pitchClassOf, octaveOf, spellPitchClass, vexKey } from '../util/midi.js';

export const QUALITIES = Object.freeze({
  Major: [0, 4, 7],
  Minor: [0, 3, 7],
  Dom7: [0, 4, 7, 10],
  Maj7: [0, 4, 7, 11],
  Min7: [0, 3, 7, 10],
  Dim: [0, 3, 6],
  Dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  Sus2: [0, 2, 7],
  Sus4: [0, 5, 7],
  Aug: [0, 4, 8],
});

// Every quality's chord tones are stacked-thirds (letter offsets 0/2/4/6) with
// the sus qualities as the only exceptions. Keeping the table alongside
// QUALITIES so any new quality entry must decide both semitones and letters.
const CHORD_LETTER_OFFSETS = Object.freeze({
  Major: [0, 2, 4], Minor: [0, 2, 4], Dim: [0, 2, 4], Aug: [0, 2, 4],
  Dom7: [0, 2, 4, 6], Maj7: [0, 2, 4, 6], Min7: [0, 2, 4, 6],
  Dim7: [0, 2, 4, 6], m7b5: [0, 2, 4, 6],
  Sus2: [0, 1, 4], Sus4: [0, 3, 4],
});

const NATURAL_LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
const NATURAL_PCS = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTAL_FOR_DELTA = { '-2': 'bb', '-1': 'b', '0': '', '1': '#', '2': '##' };

/**
 * Build a default MIDI voicing for `<rootMidi> <quality>` by stacking the
 * quality's intervals on top of the root. Used by the piano modal's quality
 * chips as the reset voicing and by demo data authoring.
 * Throws if `quality` isn't in QUALITIES.
 */
export function notesFrom(rootMidi, quality) {
  const intervals = QUALITIES[quality];
  if (!intervals) throw new Error(`Unknown quality: ${ quality }`);
  return intervals.map((interval) => rootMidi + interval);
}

const QUALITY_ORDER = ['Dom7', 'Min7', 'Maj7', 'Dim7', 'm7b5', 'Major', 'Minor', 'Dim', 'Sus4', 'Sus2', 'Aug'];

/**
 * Derive a chord identity exclusively from the notes stored in progression
 * state. This is the single detector used by both the engine (for technique
 * eligibility + targeting) and the piano modal (for live chord recognition
 * while the user toggles keys).
 *
 * Hints are display-only and MUST NEVER affect engine behavior. An
 * unrecognised chord still receives a deterministic bass root so callers can
 * emit a helpful eligibility reason instead of crashing.
 *
 * @param {{notes: number[]}} chord
 * @param {{preferBassRoot?: boolean}} [options]
 *        preferBassRoot: try the bass pitch class first when scanning root
 *        candidates. Matters only for symmetric qualities (Dim7, Aug) where
 *        any rotation would match — the bass is usually the musical root.
 *        The engine leaves this false so its behaviour is deterministic
 *        regardless of voicing.
 * @returns {{rootPc: number, quality: keyof QUALITIES | null, recognised: boolean}}
 */
export function inferChordIdentity(chord, options = {}) {
  const { preferBassRoot = false } = options;
  if (!chord.notes.length) return { rootPc: 0, quality: null, recognised: false };
  const pitchClasses = [...new Set(chord.notes.map(pitchClassOf))].sort((a, b) => a - b);
  const bassPc = pitchClassOf(Math.min(...chord.notes));
  const allPcs = Array.from({ length: 12 }, (_, i) => i);
  const rootOrder = preferBassRoot
    ? [bassPc, ...allPcs.filter((pc) => pc !== bassPc)]
    : allPcs;

  for (const quality of QUALITY_ORDER) {
    for (const rootPc of rootOrder) {
      const expected = [...new Set(QUALITIES[quality].map((interval) => (rootPc + interval) % 12))]
        .sort((a, b) => a - b);
      if (pitchClasses.length === expected.length && pitchClasses.every((pc, index) => pc === expected[index])) {
        return { rootPc, quality, recognised: true };
      }
    }
  }

  return { rootPc: bassPc, quality: null, recognised: false };
}

/**
 * Human-readable pitch name for a MIDI number.
 * `key` picks the accidental spelling (< 0 → flats, ≥ 0 → sharps) — this is
 * spelling only, never audio. `withOctave` false returns just the letter.
 */
export function noteName(midi, key = 0, withOctave = true) {
  const name = spellPitchClass(midi, key);
  return withOctave ? `${ name }${ octaveOf(midi) }` : name;
}

/**
 * Row label for a chord in the chord list ("C Major", "F♯ Dom7", …).
 * Uses the display-only `hint` if set (the fast path — every hint-annotated
 * chord names itself without running detection); falls back to a note list.
 * When a hint is available, the note list is spelled with the chord's letters
 * so a G♯ major reads "G♯4 · B♯4 · D♯5" instead of "G♯4 · C5 · D♯5".
 *
 * Plain-text label — for any consumer that can't render superscripts. UI
 * surfaces that render chord glyphs (editor rows, quick-add chips) should
 * call `formatChordSymbol` instead so extensions display in idiomatic
 * superscript.
 */
export function chordDisplayName(chord, key = 0) {
  if (chord.rest || !chord.notes.length) return 'Rest';
  if (chord.hint) return `${ noteName(chord.hint.rootMidi, key, false) } ${ chord.hint.quality }`;
  return chord.notes.map((note) => noteName(note, key)).join('–');
}

/**
 * Idiomatic lead-sheet chord symbol split into a rendering-ready shape.
 * Callers decide how to draw the parts — the editor renders baseline text
 * followed by either a <sup> for a normal extension or a separately styled
 * quality marker (Cmaj⁷, Cm⁷, CO7, CØ7, Csus⁴, C+).
 *
 * Convention (per the design revamp):
 *   - Root letter + accidental      → baseline
 *   - Minor 'm'                     → baseline (right after root)
 *   - 'sus' modifier                → baseline
 *   - Numeric extensions (7/9/…)    → superscript, except after O or Ø
 *   - 'maj' modifier on maj7        → superscript with the number
 *   - Symbols O, Ø, +               → superscript quality marker
 *                                     (O for diminished, Ø for half-diminished,
 *                                     + for augmented)
 *   - Dim7/m7b5's 7                 → superscript suffix after its marker
 *
 * When the chord has no display hint AND its notes don't resolve to a
 * recognized quality, `root` is empty and `plain` carries the note-list
 * fallback so the caller can render that instead.
 *
 * @param {import('../state.js').Chord} chord
 * @param {number} [key]  Circle-of-fifths integer for accidental spelling.
 * @returns {{ root: string, baseline: string, marker: string, suffix: string, superscript: string, plain: string }}
 */
export function formatChordSymbol(chord, key = 0) {
  if (chord.rest || !chord.notes.length) {
    return { root: '', baseline: '', marker: '', suffix: '', superscript: '', plain: 'Rest' };
  }
  const identity = chord.hint
    ? { rootPc: pitchClassOf(chord.hint.rootMidi), quality: chord.hint.quality, root: noteName(chord.hint.rootMidi, key, false) }
    : detectForDisplay(chord, key);

  if (!identity) {
    return { root: '', baseline: '', marker: '', suffix: '', superscript: '', plain: chordDisplayName(chord, key) };
  }
  const spec = QUALITY_SYMBOL[identity.quality] ?? {
    baseline: ` ${ identity.quality }`, marker: '', suffix: '', superscript: '',
  };
  return {
    root: identity.root,
    baseline: spec.baseline,
    marker: spec.marker,
    suffix: spec.suffix,
    superscript: spec.superscript,
    plain: chordDisplayName(chord, key),
  };
}

/** Baseline/quality-marker/superscript split for every quality in QUALITIES.
 *
 * The quality marker and its seventh are independently superscripted, so
 * their spacing can match compact lead-sheet notation (CO7 and CØ7). */
const QUALITY_SYMBOL = Object.freeze({
  Major: { baseline: '',    marker: '',  suffix: '',  superscript: '' },
  Minor: { baseline: 'm',   marker: '',  suffix: '',  superscript: '' },
  Dom7:  { baseline: '',    marker: '',  suffix: '',  superscript: '7' },
  Maj7:  { baseline: '',    marker: '',  suffix: '',  superscript: 'maj7' },
  Min7:  { baseline: 'm',   marker: '',  suffix: '',  superscript: '7' },
  Dim:   { baseline: '',    marker: 'O', suffix: '',  superscript: '' },
  Dim7:  { baseline: '',    marker: 'O', suffix: '7', superscript: '' },
  m7b5:  { baseline: '',    marker: 'Ø', suffix: '7', superscript: '' },
  Sus2:  { baseline: 'sus', marker: '',  suffix: '',  superscript: '2' },
  Sus4:  { baseline: 'sus', marker: '',  suffix: '',  superscript: '4' },
  Aug:   { baseline: '',    marker: '+', suffix: '',  superscript: '' },
});

function detectForDisplay(chord, key) {
  const detected = inferChordIdentity(chord, { preferBassRoot: true });
  if (!detected.recognised) return null;
  // Spell the root using the same key-signature rules the rest of the UI uses,
  // then hand off the pitch class + quality for symbol lookup.
  const rootMidi = 60 + detected.rootPc;
  return { rootPc: detected.rootPc, quality: detected.quality, root: noteName(rootMidi, key, false) };
}

/**
 * Human-readable pitch name for a MIDI note, spelled per the chord's identity
 * (so C5 in a G♯ major chord reads "B♯4"). Falls back to plain `noteName` when
 * the note isn't a chord tone or no identity is provided.
 */
export function chordToneName(midi, identity, key = 0) {
  const spelled = chordAwareVexKey(midi, identity, key);
  if (!spelled) return noteName(midi, key);
  const [letterAcc, octave] = spelled.split('/');
  const letter = letterAcc[0].toUpperCase();
  const accidental = letterAcc.slice(1)
    .replace('##', '𝄪').replace('bb', '𝄫').replace('#', '♯').replace('b', '♭');
  return `${ letter }${ accidental }${ octave }`;
}

/**
 * VexFlow key string for a MIDI note, spelled per the chord's identity.
 * Returns null when the note's pitch class isn't in the chord (e.g. a passing
 * tone), letting the caller fall back to key-signature spelling.
 *
 * Chord tones inherit their letter from the root's letter plus the interval's
 * conventional letter offset (0, 2, 4, 6 for stacked thirds; 1 or 3 for sus).
 * Their accidental is whatever gets the natural letter to the correct pitch —
 * so B♯, F𝄪, C♭, and E𝄫 all show up when the theory calls for them.
 */
export function chordAwareVexKey(midi, identity, key = 0) {
  if (!identity || !identity.quality) return null;
  const intervals = QUALITIES[identity.quality];
  const letterOffsets = CHORD_LETTER_OFFSETS[identity.quality];
  if (!intervals || !letterOffsets) return null;
  const noteInterval = ((midi - identity.rootPc) % 12 + 12) % 12;
  const intervalIndex = intervals.indexOf(noteInterval);
  if (intervalIndex === -1) return null;

  const rootLetterName = spellPitchClass(identity.rootPc, key)[0].toLowerCase();
  const rootLetterIndex = NATURAL_LETTERS.indexOf(rootLetterName);
  const targetLetterIndex = (rootLetterIndex + letterOffsets[intervalIndex]) % 7;
  const letter = NATURAL_LETTERS[targetLetterIndex];
  const naturalPc = NATURAL_PCS[targetLetterIndex];
  const targetPc = ((identity.rootPc + noteInterval) % 12 + 12) % 12;

  let delta = targetPc - naturalPc;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  const accidental = ACCIDENTAL_FOR_DELTA[String(delta)];
  if (accidental == null) return null;
  const octave = Math.floor((midi - delta) / 12) - 1;
  return `${ letter }${ accidental }/${ octave }`;
}

/**
 * Chord-aware VexFlow key string, falling back to plain key-based `vexKey`
 * when the note isn't a chord tone or no identity is provided. Single entry
 * point for callers who want "spell it right; do something sensible when you
 * can't."
 */
export function vexKeyForNote(midi, identity, key = 0) {
  return chordAwareVexKey(midi, identity, key) ?? vexKey(midi, key);
}

/**
 * Resolve a chord's identity for spelling: use the display-only `hint` when
 * the user set one, otherwise fall back to `inferChordIdentity` biased toward
 * the bass. Returns null when the notes don't form a recognised chord —
 * callers should then fall back to key-based spelling.
 */
export function chordSpellingIdentity(chord) {
  if (!chord.notes.length) return null;
  if (chord.hint) return { rootPc: pitchClassOf(chord.hint.rootMidi), quality: chord.hint.quality };
  const detected = inferChordIdentity(chord, { preferBassRoot: true });
  return detected.recognised ? { rootPc: detected.rootPc, quality: detected.quality } : null;
}
