/**
 * VexFlow rendering of the compiled progression.
 *
 * Reads the same `Segment[]` the audio scheduler consumes, so the sheet music
 * cannot silently drift from what plays. Each measure is drawn in its own
 * `<g>` group with `data-measure=<n>` — main.js toggles a `.is-playing` class
 * on that group during playback to light the current bar.
 *
 * User notes are drawn in a cool lavender (the harmony); technique-generated
 * notes in warm gold (the melody-adjacent, connective material — see the
 * palette comment above `staffColor`). Ties are drawn between adjacent
 * segments that share a `sourceId` (see rhythm.js), even across a barline.
 * When that barline is a system break, VexFlow's partial-tie form is used
 * for each side; a normal two-note tie would otherwise draw diagonally
 * across the page.
 */
import { vexKeyForNote, chordSpellingIdentity, formatChordSymbol } from '../engine/chords.js';
import { accidentalFor } from '../engine/key-signature.js';
import { decompose } from '../engine/rhythm.js';

/** SVG font families per theme chord font — same faces base.css declares. */
const CHORD_SYMBOL_FAMILIES = { jazztext: 'MuseJazz Text', classical: 'Edwin', scifi: 'Orbitron' };

const KEY_SIGNATURES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const DURATIONS = new Map([[4, 'w'], [3, 'hd'], [2, 'h'], [1, 'q'], [0.5, '8'], [0.25, '16']]);
// The first system needs real space above the top staff line so the topmost
// system doesn't feel cramped against the panel edge.
export const NOTATION_TOP_HEADROOM = 50;

/** 'auto' picks bass or treble from the median MIDI note across all segments. */
function resolvedClef(segments, setting) {
  if (setting !== 'auto') return setting;
  const notes = segments.flatMap((segment) => segment.notes).sort((a, b) => a - b);
  return (notes[Math.floor(notes.length / 2)] ?? 60) < 60 ? 'bass' : 'treble';
}

function styleModifiers(stave, color) {
  stave.getModifiers().forEach((modifier) => modifier.setStyle({ fillStyle: color, strokeStyle: color }));
}

/**
 * Lead-sheet chord symbol (Cmaj⁷, Cm⁷, CO⁷, CØ⁷, Csus⁴, C+) as a VexFlow
 * modifier, built from the same `formatChordSymbol` parts the editor renders
 * in HTML so both surfaces always agree on the symbol convention.
 * `fontFamily` matches the project theme's chord font (see base.css
 * `--font-chord`), so the engraved symbols track the editor's look.
 */
function buildChordSymbolModifier(VF, parts, fontFamily) {
  const symbol = new VF.ChordSymbol().setFont({ family: fontFamily, size: 15, weight: 700 });
  const superscript = { symbolModifier: VF.ChordSymbol.symbolModifiers.SUPERSCRIPT };
  symbol.addGlyphOrText(`${ parts.root }${ parts.baseline }`);
  if (parts.marker === 'O') symbol.addGlyph('diminished', superscript);
  else if (parts.marker === 'Ø') symbol.addGlyph('halfDiminished', superscript);
  else if (parts.marker === '+') symbol.addGlyphOrText('+', superscript);
  if (parts.suffix) symbol.addGlyphOrText(parts.suffix, superscript);
  if (parts.superscript) symbol.addGlyphOrText(parts.superscript, superscript);
  return symbol;
}

/**
 * Pair VexFlow's final engraved X positions with the same measure-relative
 * beat onsets used by the audio scheduler. These anchors let visual effects
 * follow musical time instead of treating clefs and time signatures as part
 * of the playable horizontal duration.
 */
export function timelineAnchorsForNotes(segments, notes, measureLength) {
  const duration = Math.max(1, Number(measureLength) || 1);
  return notes
    .map((note, index) => ({
      x: Number(note.getAbsoluteX?.()),
      progress: Math.max(0, Math.min(1, (Number(segments[index]?.startBeat) || 0) / duration)),
    }))
    .filter((anchor) => Number.isFinite(anchor.x))
    .sort((first, second) => first.x - second.x);
}

/**
 * Return one VexFlow tie direction for each tied notehead.
 *
 * VexFlow's stem constants also describe tie curvature: UP produces a curve
 * below the noteheads and DOWN produces one above. In a tied chord, the
 * bottom note curves down, the top note curves up, and inner notes choose the
 * nearest outside direction. This keeps each arc beside its own notehead and
 * prevents chord ties from crossing one another.
 */
function tieDirections(firstNote, lastNote, count, VF) {
  if (count === 1) {
    const firstStem = firstNote.getStemDirection();
    const lastStem = lastNote.getStemDirection();
    // When the two ends disagree, conventional single-voice engraving
    // defaults to an upward curve.
    return [firstStem === lastStem ? firstStem : VF.StaveNote.STEM_DOWN];
  }

  const middleLine = 3; // VexFlow's middle staff line.
  return Array.from({ length: count }, (_, noteIndex) => {
    if (noteIndex === 0) return VF.StaveNote.STEM_UP; // bottom note: curve down
    if (noteIndex === count - 1) return VF.StaveNote.STEM_DOWN; // top note: curve up

    // Inner ties go toward the closer outer side. This preserves their
    // vertical ordering and avoids routing an inner arc across the chord.
    const line = firstNote.getKeyProps()[noteIndex]?.line ?? middleLine;
    if (line < middleLine) return VF.StaveNote.STEM_UP;
    if (line > middleLine) return VF.StaveNote.STEM_DOWN;
    return firstNote.getStemDirection();
  });
}

/**
 * Draw the sheet music into `container`, replacing anything already there.
 *
 * @param {HTMLElement} container
 * @param {Segment[]}   segments   Output of compile().
 * @param {Settings}    settings   For key signature, time signature, and clef.
 * @param {Chord[]}     [chords]   Origin chords for spelling — used to spell
 *                                 each user segment's notes per its chord
 *                                 identity (so G♯ major reads as G♯/B♯/D♯ and
 *                                 not G♯/C/D♯). Technique-generated segments
 *                                 fall through to key-based spelling.
 * @returns {{measureCount: number, layout: object[]}} Summary plus staff geometry for the Canvas overlay.
 */
export function renderNotation(container, segments, settings, chords = []) {
  const VF = window.Vex?.Flow ?? window.VexFlow;
  // Rendering may have widened this element for a dense score on a prior
  // pass. Reset before measuring the available viewport for this pass.
  container.style.width = '';
  container.replaceChildren();
  if (!VF) {
    container.innerHTML = '<div class="notice">Notation is still loading. Refresh if this message remains.</div>';
    return { measureCount: 0, layout: [] };
  }
  if (!segments.length) {
    container.innerHTML = '<div class="notice">Add a chord to begin the sheet music.</div>';
    return { measureCount: 0, layout: [] };
  }

  const measureCount = Math.max(...segments.map((segment) => segment.measureIndex)) + 1;
  // The panel supplies the exact unscaled width for the current button zoom.
  // A modest floor keeps extremely narrow mobile panes usable without forcing
  // a desktop-sized SVG that leaves a visual gap at higher zoom levels.
  const width = Math.max(320, container.clientWidth || 820);
  const clef = resolvedClef(segments, settings.clef);
  // Cosmic palette: staff/barlines read as cool glowing filaments. User chord
  // tones sit in a saturated indigo-lavender; technique-generated (connective
  // /transition) material gets a saturated cyan so it still stands apart from
  // user notes at a glance, without reintroducing a warm tone into the
  // notation itself — gold stays reserved for the --accent-driven "current
  // position" glow elsewhere in this pane. Both stay well short of white:
  // the particle layer (particles.js) additively blooms every sampled pixel,
  // and near-white source colors saturate that bloom into one flat merged
  // glow instead of visible individual particles.
  const staffColor = '#8b90d6';
  const lineColor = '#5a5fa8';
  const userColor = '#8f93e8';
  const techniqueColor = '#3ecbdc';
  const notesBySource = [];
  const layout = [];
  const measureLength = settings.timeSig.num * 4 / settings.timeSig.den;
  const identityBySourceId = new Map();
  chords.forEach((chord) => identityBySourceId.set(chord.id, chordSpellingIdentity(chord)));

  // Build and measure every voice before assigning staves. Formatter's
  // minimum width includes accidentals, dots, flags, and chord noteheads, so
  // a dense bar receives real engraving room instead of being squeezed into
  // the same width as a whole-note bar.
  const chordById = new Map(chords.map((chord) => [chord.id, chord]));
  const symbolAttachedFor = new Set();
  const symbolFamily = CHORD_SYMBOL_FAMILIES[settings.theme?.chordFont] ?? CHORD_SYMBOL_FAMILIES.scifi;
  // A measure whose content is entirely silent is engraved as one centred
  // whole-bar rest, and a trailing partial measure is padded with rests so
  // the final bar reads complete instead of trailing off into blank staff.
  // Display-only: playback still reads the raw segment list.
  const displaySegments = (measureSegments, measure) => {
    if (measureSegments.every((segment) => !segment.notes.length)) {
      return [{
        notes: [], durationBeats: measureLength, isTechnique: false,
        sourceId: measureSegments[0]?.sourceId ?? `rest-pad-${ measure }`,
        seamIndex: null, measureIndex: measure, startBeat: 0,
      }];
    }
    const occupied = measureSegments.reduce((sum, segment) => sum + segment.durationBeats, 0);
    const padded = [...measureSegments];
    let startBeat = occupied;
    for (const durationBeats of decompose(measureLength - occupied)) {
      padded.push({
        notes: [], durationBeats, isTechnique: false,
        sourceId: `rest-pad-${ measure }`, seamIndex: null, measureIndex: measure, startBeat,
      });
      startBeat += durationBeats;
    }
    return padded;
  };
  // Mid-staff anchor for short rests; whole rests conventionally hang from
  // the fourth staff line, so they get their own anchor per clef.
  const restKey = clef === 'bass' ? 'd/3' : 'b/4';
  const wholeRestKey = clef === 'bass' ? 'f/3' : 'd/5';
  const measures = Array.from({ length: measureCount }, (_, measure) => {
    const measureSegments = displaySegments(
      segments.filter((segment) => segment.measureIndex === measure),
      measure,
    );
    const entries = measureSegments.map((segment) => {
      let staveNote;
      if (!segment.notes.length) {
        // Rest segment. A rest that fills its whole measure is engraved as a
        // centred whole rest regardless of meter — standard convention.
        const fillsMeasure = segment.startBeat === 0 && segment.durationBeats >= measureLength;
        const durationCode = fillsMeasure ? 'w' : DURATIONS.get(segment.durationBeats) ?? 'q';
        staveNote = new VF.StaveNote({
          clef,
          keys: [durationCode === 'w' ? wholeRestKey : restKey],
          duration: `${ durationCode }r`,
          align_center: fillsMeasure,
        });
        if (!fillsMeasure && segment.durationBeats === 3) VF.Dot.buildAndAttach([staveNote], { all: true });
      } else {
        const identity = segment.isTechnique ? null : identityBySourceId.get(segment.sourceId) ?? null;
        const spelled = segment.notes.map((midi) => vexKeyForNote(midi, identity, settings.key));
        staveNote = new VF.StaveNote({
          clef,
          keys: spelled,
          duration: DURATIONS.get(segment.durationBeats) ?? 'q',
          // Let VexFlow apply the single-voice engraving rule: below the
          // middle line stems rise; above it they fall; chords use their outer
          // noteheads to decide.
          auto_stem: true,
        });
        // VexFlow 4 uses the dotted duration (`hd`) for tick accounting, but
        // requires an explicit Dot modifier to engrave the dot itself. Without
        // it, a three-beat segment looks like an ordinary two-beat half note.
        if (segment.durationBeats === 3) VF.Dot.buildAndAttach([staveNote], { all: true });
        spelled.forEach((vex, index) => {
          const accidental = accidentalFor(vex, settings.key);
          if (accidental) staveNote.addModifier(new VF.Accidental(accidental), index);
        });
      }
      const color = segment.isTechnique ? techniqueColor : userColor;
      staveNote.setStyle({ fillStyle: color, strokeStyle: color });
      staveNote.setLedgerLineStyle?.({ fillStyle: color, strokeStyle: color });
      // Lead-sheet symbol above the first notehead of each NAMED user chord.
      // Custom note-piles (no recognised quality) and technique material stay
      // unlabelled; ties/continuation segments don't repeat the symbol.
      if (segment.notes.length && !segment.isTechnique && !symbolAttachedFor.has(segment.sourceId)) {
        symbolAttachedFor.add(segment.sourceId);
        const chord = chordById.get(segment.sourceId);
        const parts = chord ? formatChordSymbol(chord, settings.key) : null;
        if (parts?.root) staveNote.addModifier(buildChordSymbolModifier(VF, parts, symbolFamily), 0);
      }
      notesBySource.push({ segment, note: staveNote });
      return { segment, note: staveNote };
    });

    return { measure, entries };
  });

  const makeFragment = (measure, entries, startsMeasure, endsMeasure) => {
    const staveNotes = entries.map((entry) => entry.note);
    // Beam runs of flagged notes (eighths/sixteenths) per the meter's default
    // beat grouping. Must happen before formatting so stems and flags are
    // resolved for width calculation; rests break groups automatically.
    const beams = VF.Beam.generateBeams(staveNotes, {
      groups: VF.Beam.getDefaultBeamGroups(`${ settings.timeSig.num }/${ settings.timeSig.den }`),
    });
    beams.forEach((beam) => {
      const color = beam.getNotes()[0]?.getStyle()?.fillStyle ?? userColor;
      beam.setStyle({ fillStyle: color, strokeStyle: color });
    });
    const voice = new VF.Voice({ num_beats: settings.timeSig.num, beat_value: settings.timeSig.den }).setMode(VF.Voice.Mode.SOFT);
    voice.addTickables(staveNotes);
    const formatter = new VF.Formatter().joinVoices([voice]);
    return {
      measure,
      entries,
      staveNotes,
      beams,
      voice,
      formatter,
      startsMeasure,
      endsMeasure,
      minimumWidth: formatter.preCalculateMinTotalWidth([voice]),
    };
  };

  // Whole-measure layout. A measure is always engraved complete on a single
  // system (never split across a line break), and every system holds the same
  // number of measures so the grid stays stable when zooming in or out. The
  // measures-per-system count is derived from the widest measure so no row can
  // overflow regardless of which measures land on it.
  const systemWidth = width - 20;
  const FIRST_SYSTEM_PREFIX = 126; // clef + time signature + key signature
  const LATER_SYSTEM_PREFIX = 40;  // left/right breathing room around notes
  const MIN_STAVE_WIDTH = 230;
  // Justification never widens a bar past this, so a one-chord score reads as
  // a normally proportioned bar at the left instead of stretching across the
  // whole panel. Dense bars whose minimum width exceeds it still get their
  // minimum.
  const MAX_STAVE_WIDTH = 380;
  const FIRST_PREFIX_EXTRA = FIRST_SYSTEM_PREFIX - LATER_SYSTEM_PREFIX;

  const wholeMeasures = measures.map((entry) => makeFragment(entry.measure, entry.entries, true, true));
  const measureBaseWidth = (fragment) => Math.max(
    MIN_STAVE_WIDTH,
    Math.ceil(fragment.minimumWidth + LATER_SYSTEM_PREFIX),
  );
  const baseWidths = wholeMeasures.map(measureBaseWidth);

  // Width a system needs to hold the `count` measures starting at `start`
  // (the first also carries the leading clef/key/time prefix).
  const rowWidth = (start, count) => {
    let total = FIRST_PREFIX_EXTRA;
    for (let i = start; i < Math.min(start + count, baseWidths.length); i += 1) total += baseWidths[i];
    return total;
  };
  // Every system carries the same measure count. Pick the largest count whose
  // every actual row still fits, so an isolated dense measure only limits the
  // rows that contain it rather than forcing the whole score to a worst-case
  // single-measure grid.
  const rowsFit = (count) => {
    for (let start = 0; start < baseWidths.length; start += count) {
      if (rowWidth(start, count) > systemWidth) return false;
    }
    return true;
  };
  let measuresPerSystem = 1;
  for (let count = baseWidths.length; count >= 1; count -= 1) {
    if (rowsFit(count)) { measuresPerSystem = count; break; }
  }

  const systems = [];
  for (let start = 0; start < wholeMeasures.length; start += measuresPerSystem) {
    const row = wholeMeasures
      .slice(start, start + measuresPerSystem)
      .map((fragment, column) => ({
        fragment,
        minimumWidth: Math.min(
          systemWidth,
          baseWidths[start + column] + (column === 0 ? FIRST_PREFIX_EXTRA : 0),
        ),
      }));
    systems.push(row);
  }

  // Justify every full system edge-to-edge so measures share the width evenly.
  // A short final system keeps its natural measure widths instead of stretching
  // a couple of bars across the whole row.
  const placements = [];
  systems.forEach((row, rowIndex) => {
    const isFullRow = row.length === measuresPerSystem;
    const minimumTotal = row.reduce((total, item) => total + item.minimumWidth, 0);
    const extraPerMeasure = isFullRow ? (systemWidth - minimumTotal) / row.length : 0;
    let x = 10;
    row.forEach((item, column) => {
      const isLast = column === row.length - 1;
      const uncappedWidth = (isFullRow && isLast)
        ? 10 + systemWidth - x
        : item.minimumWidth + extraPerMeasure;
      const maxWidth = MAX_STAVE_WIDTH + (column === 0 ? FIRST_PREFIX_EXTRA : 0);
      const staveWidth = Math.min(uncappedWidth, Math.max(item.minimumWidth, maxWidth));
      placements.push({
        ...item.fragment,
        column,
        row: rowIndex,
        x,
        staveWidth,
      });
      x += staveWidth;
    });
  });

  const rows = systems.length;
  const rowHeight = 150;
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(width, rows * rowHeight + 20 + NOTATION_TOP_HEADROOM);
  const context = renderer.getContext();

  for (const measureData of placements) {
    const { measure, entries, staveNotes, beams, voice, formatter, column, row, x, staveWidth, startsMeasure, endsMeasure } = measureData;
    const y = 16 + NOTATION_TOP_HEADROOM + row * rowHeight;
    const measureLayout = {
      index: measure,
      x,
      width: staveWidth,
      staffTop: y + 40,
      lineGap: 10,
      timelineAnchors: [],
    };
    layout.push(measureLayout);
    context.openGroup('measure-group', `measure-${ measure }`, { 'data-measure': String(measure) });
    const stave = new VF.Stave(x, y, staveWidth);
    if (!startsMeasure) stave.setBegBarType(VF.Barline.type.NONE);
    if (!endsMeasure) stave.setEndBarType(VF.Barline.type.NONE);
    // The score's last bar closes with a final (thin-thick) barline.
    if (endsMeasure && measure === measureCount - 1) stave.setEndBarType(VF.Barline.type.END);
    if (column === 0) {
      stave.addClef(clef);
      // Time signatures introduce the score; they are not repeated merely
      // because a visual system wrapped while zooming.
      if (row === 0) stave.addTimeSignature(`${ settings.timeSig.num }/${ settings.timeSig.den }`);
      stave.addKeySignature(KEY_SIGNATURES[settings.key + 7]);
    }
    styleModifiers(stave, staffColor);
    context.setStrokeStyle(lineColor); context.setFillStyle(lineColor);
    stave.setStyle({ fillStyle: lineColor, strokeStyle: lineColor }).setContext(context).draw();
    if (staveNotes.length) {
      formatter.format([voice], staveWidth - (column === 0 ? 120 : 32));
      voice.draw(context, stave);
      beams.forEach((beam) => beam.setContext(context).draw());
      const fragmentSegments = entries.map((entry) => entry.segment);
      measureLayout.timelineAnchors = timelineAnchorsForNotes(
        fragmentSegments,
        staveNotes,
        measureLength,
      );
    }
    context.closeGroup();
  }

  const rowByNote = new Map();
  placements.forEach(({ row, entries }) => entries.forEach(({ note }) => rowByNote.set(note, row)));

  for (let index = 0; index < notesBySource.length - 1; index += 1) {
    const current = notesBySource[index];
    const next = notesBySource[index + 1];
    if (current.segment.sourceId !== next.segment.sourceId) continue;
    // A rest split across a barline shares a sourceId but is never tied.
    if (!current.segment.notes.length || !next.segment.notes.length) continue;
    const count = Math.min(current.note.keys.length, next.note.keys.length);
    const directions = tieDirections(current.note, next.note, count, VF);

    const currentRow = rowByNote.get(current.note);
    const nextRow = rowByNote.get(next.note);
    if (currentRow !== nextRow) {
      // A tie cannot be drawn directly between systems: its endpoints have
      // different vertical positions. Engraving convention uses an outgoing
      // fragment at the end of the prior line and an incoming fragment at the
      // beginning of the next line instead.
      directions.forEach((direction, noteIndex) => {
        const indices = [noteIndex];
        new VF.StaveTie({ first_note: current.note, first_indices: indices, last_indices: indices })
          .setDirection(direction).setStyle({ fillStyle: staffColor, strokeStyle: staffColor }).setContext(context).draw();
        new VF.StaveTie({ last_note: next.note, first_indices: indices, last_indices: indices })
          .setDirection(direction).setStyle({ fillStyle: staffColor, strokeStyle: staffColor }).setContext(context).draw();
      });
      continue;
    }

    directions.forEach((direction, noteIndex) => {
      const indices = [noteIndex];
      new VF.StaveTie({ first_note: current.note, last_note: next.note, first_indices: indices, last_indices: indices })
        .setDirection(direction).setStyle({ fillStyle: staffColor, strokeStyle: staffColor }).setContext(context).draw();
    });
  }
  return { measureCount, layout };
}
