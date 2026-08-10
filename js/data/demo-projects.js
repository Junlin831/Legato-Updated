/**
 * Bundled demo projects.
 *
 * Every demo is a full `Project` object (name + timestamps + progression) so
 * the landing page can list them alongside user projects and `cloneDemo()`
 * can turn one into a fresh editable copy. Devs edit demos here in the repo;
 * they never live in localStorage until a user clicks Open.
 *
 * Each chord is authored with an explicit hint (`{rootMidi, quality}`) so its
 * row names itself instantly, and its notes come from `notesFrom()` — the same
 * builder the piano modal uses for its default voicings. This keeps demo data
 * on the exact same data contract as user chords: no parallel "recipe" form.
 */
import { makeChord, makeProgression } from '../state.js';
import { notesFrom } from '../engine/chords.js';

/**
 * Stable, human-readable ids so bookmarks/URLs to a demo stay valid across
 * releases even as the demo list grows. Not localStorage ids — those get
 * minted fresh when a user opens (clones) the demo.
 */
const DEMO_EPOCH = '2026-07-18T00:00:00.000Z';

/** 4-5-3-6-2-5-1, the ubiquitous pop-song turnaround, in C major. */
function make4536251PopProgression() {
  const chords = [
    makeChord(notesFrom(53, 'Major'), 1, { rootMidi: 53, quality: 'Major' }), // IV: F
    makeChord(notesFrom(55, 'Major'), 1, { rootMidi: 55, quality: 'Major' }), // V: G
    makeChord(notesFrom(52, 'Minor'), 1, { rootMidi: 52, quality: 'Minor' }), // iii: Em
    makeChord(notesFrom(57, 'Minor'), 1, { rootMidi: 57, quality: 'Minor' }), // vi: Am
    makeChord(notesFrom(50, 'Minor'), 1, { rootMidi: 50, quality: 'Minor' }), // ii: Dm
    makeChord(notesFrom(55, 'Major'), 1, { rootMidi: 55, quality: 'Major' }), // V: G
    makeChord(notesFrom(60, 'Major'), 1, { rootMidi: 60, quality: 'Major' }), // I: C
  ];
  return makeProgression({
    settings: {
      tempo: 165,
      timeSig: { num: 4, den: 4 },
      key: 0,
      clef: 'auto',
      theme: { accent: '#B87FD9' },
    },
    chords,
    seams: [
      'passingDim',
      'susPassing',
      'secondaryDom',
      'scaleRun',
      'susPassing',
      'ii_v_i',
    ],
  });
}

/**
 * The demo registry the landing page reads. Currently a single fixed demo —
 * the constellation map's permanent central node. Add another by pushing a
 * second entry; a stable `id` keeps it addressable, `blurb` shows on the card.
 */
export const DEMO_PROJECTS = [
  {
    id: 'demo-pop-4536251',
    name: '4-5-3-6-2-5-1 pop turnaround',
    blurb: 'Every technique except the tritone sub, over a familiar C-major loop.',
    createdAt: DEMO_EPOCH,
    updatedAt: DEMO_EPOCH,
    deletedAt: null,
    progression: make4536251PopProgression(),
  },
];

/** Kept for the existing test suite; not used by the new views. */
export function makeDefaultProgression() {
  return make4536251PopProgression();
}
