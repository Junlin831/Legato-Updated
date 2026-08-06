# LEGATO — Codex Build Plan for the First Working Sample

## 1. Mission

Build the first runnable vertical slice of **LEGATO**, an AI-assisted educational composition tool for intermediate-to-advanced pianists. Beginners may use it, but the product assumes users already understand chords, chord quality, and reading notation in common clefs.

LEGATO should help pianists, in this priority order:

1. Compose better chord progressions.
2. Understand chord transitions.
3. Improve voice leading.
4. Learn applicable music theory through listening and experimentation.

The product is a teaching tool first and a creativity tool second. It should not merely generate progressions: it should help learners understand their own musical decisions.

## 2. Instructions to Codex

Work autonomously until the first sample is runnable and tested. Begin by inspecting the repository and existing files before editing anything. Preserve working code and adapt this plan to the actual repository rather than recreating files unnecessarily.

Before implementation:

1. Read `docs/data-model.md` in full.
2. Read the existing `js/state.js`, if present.
3. Read the existing coach prompt and project plan.
4. Report any conflict between the data-model document, `state.js`, and this plan before changing the conflicting behavior.

Authority order:

1. `js/state.js` is authoritative for runtime shapes and factories.
2. `docs/data-model.md` is authoritative for field meaning and engine behavior.
3. This plan defines product scope, milestones, and acceptance criteria.

Do not silently invent fields, alter the eight defined techniques, re-voice user chords, or change timing semantics. If a required choice is not covered by these sources, choose the smallest reversible implementation, document the assumption, and keep it outside the stored data contract when possible.

## 3. Product Positioning

Use this sentence as the product north star:

> LEGATO is an interactive AI music tutor that helps pianists compose stronger chord progressions by letting them hear, see, and understand chord transitions and voice leading.

Primary Build Week category: **Education**.

Primary learning loop:

1. The pianist creates or selects two or more explicitly voiced chords.
2. LEGATO displays exactly those pitches in notation and plays exactly those pitches.
3. The pianist selects a transition technique for a seam.
4. LEGATO generates the connecting material, displays it, and plays it.
5. The pianist asks the AI coach what happened, why it works, and what to try next.
6. The pianist changes the voicing or transition and compares the result by ear.

## 4. Non-Negotiable Data Contract

Follow `docs/data-model.md`. The following is only a checklist, not a replacement for that document.

### Progression state

```js
progression = {
  settings: {
    tempo: 100,
    timeSig: { num: 4, den: 4 },
    key: 0,
    clef: 'auto'
  },
  chords: [
    {
      id,
      notes: [60, 64, 67],
      bars: 1,
      hint: { rootMidi: 60, quality: 'Major' }
    }
  ],
  seams: []
};
```

Required invariants:

- `notes` is the ground truth for a user chord.
- A user chord is never automatically re-voiced.
- `hint` is display-only and must never affect compile, notation, audio, or voice leading.
- `seams.length === Math.max(0, chords.length - 1)`.
- A seam stores a technique key or `null`, never generated notes.
- Unknown technique keys degrade to `null` with a warning and never crash.
- `compile(progression)` is pure.
- Notation and audio consume the same compiled segment list.
- `startBeat` is measure-relative.
- Tempo is player-only and does not require recompilation.

### Compiled segment

```js
segment = {
  notes,
  durationBeats,
  isTechnique,
  sourceId,
  seamIndex,
  measureIndex,
  startBeat
};
```

### Rhythm rules

- `measureLength = timeSig.num * 4 / timeSig.den` quarter-note beats.
- A technique borrows time from the tail of the departing chord.
- `availableBeats = Math.max(0, Math.min(departingChordTotalBeats - 1, 4))`.
- Duration decomposition uses `[4, 2, 1, 0.5, 0.25]`.
- Splits from the same sustained source retain the same `sourceId` so they can be tied.
- A single-note run must obey `maxNotes = Math.floor(B / 0.25)` and must not exceed its beat budget.

### Required technique registry

Implement these exact keys and meanings before adding anything else:

| Key            | Display name                | Beat cost | Required behavior                                                                                                            |
| -------------- | --------------------------- | --------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `passingDim`   | Diatonic passing diminished |         1 | Dim7 rooted one semitone below the target root.                                                                              |
| `secondaryDom` | Secondary dominant          |         1 | Dom7 rooted a perfect fifth above the target root.                                                                           |
| `tritoneSub`   | Tritone substitution        |         1 | Dom7 rooted one semitone above the target root.                                                                              |
| `ii_v_i`       | 2-5-1 insert                |         2 | Min7 on target +2 semitones, then Dom7 on target +7; split time evenly.                                                      |
| `susPassing`   | Sus chord passing           |         1 | Sus4 on the target root.                                                                                                     |
| `leadingTone`  | Leading tone bass note      |       0.5 | One note a semitone below the target root.                                                                                   |
| `scaleRun`     | Scale run                   |         2 | Chromatic single-note walk from the current top note to the closest target note, with the documented adjacent-note fallback. |
| `arpBridge`    | Arpeggiated bridge          |         2 | Ascending notes of the same harmony as `secondaryDom`.                                                                       |

Technique-generated block chords must use the closest-voicing search described in the data model. Generated connective material stays roughly within MIDI 40–88; user input may use MIDI 21–108.

## 5. Scope of the First Working Sample

The first sample must prove the complete core loop with minimal polish. It is not the final hackathon build.

### Must implement

- A single-page interface that runs through a local static server.
- A quality-assisted piano modal for adding a chord as an explicit MIDI-note array.
- At minimum, the qualities needed by the bundled demo and the eight techniques: Major, Minor, Dom7, Min7, Dim7, and Sus4.
- A chord list showing a usable display name, exact notes, and bar duration.
- Editing or deleting a chord without breaking seam alignment.
- A default example progression available immediately after launch.
- VexFlow notation for compiled segments.
- Tone.js piano playback scheduled from the same compiled segments.
- Tempo, time signature, key signature, clef, play, and stop/reset controls.
- A seam selector that filters out techniques whose beat cost exceeds the available budget.
- All eight required technique registry entries and compilation behavior.
- Visible differentiation of user material and generated technique material.
- A basic current-measure highlight during playback; a simple glow is sufficient.
- Drag-to-reorder chord cards with animated repositioning (see [`docs/drag-reorder.md`](drag-reorder.md)).
- An “Explain this transition” action for a selected seam.
- A server-side `/api/coach.js` endpoint that keeps the OpenAI API key off the client.
- Loading, empty, error, and retry states for the coach.
- A short README with local setup, environment variables, run instructions, architecture, and test instructions.

### Defer until the vertical slice is stable

- Mood-to-progression generation.
- Free-note chord detection.
- Multiple projects and JSON import/export.
- Ambient particle effects and elaborate animation.
- Compound-meter notation polish.
- Additional transition techniques beyond the required registry.
- Accounts, cloud sync, collaboration, and manual note placement on the staff.

Do not spend time on deferred work until every must-have acceptance test below passes.

## 6. Recommended File Boundaries

Reuse existing files when they already serve these roles.

```text
/index.html
/css/styles.css
/js/main.js
/js/state.js
/js/engine/chords.js
/js/engine/techniques.js
/js/engine/voicing.js
/js/engine/rhythm.js
/js/ui/piano-modal.js
/js/ui/chord-list.js
/js/ui/seam-picker.js
/js/ui/controls.js
/js/notation/render.js
/js/audio/playback.js
/js/fx/playback-bars.js
/js/coach/coach.js
/js/coach/prompts.js
/api/coach.js
/tests/state.test.js
/tests/compile.test.js
/README.md
```

The UI must mutate progression state and call one top-level `rerender()`. The UI must not schedule audio or directly construct notation events.

## 7. Implementation Order

### Phase 0 — Repository audit and contract lock

1. Inspect the repository tree and current implementation.
2. Compare `state.js` against `docs/data-model.md`.
3. Add or finish factories, validation, `reconcileSeams`, and the `compile()` signature.
4. Add a small default progression fixture.
5. Run existing tests before changing behavior and record the baseline.

Exit condition: state can be created, validated, edited, and serialized without involving the DOM.

### Phase 1 — Plain-chord vertical slice

1. Implement quality-assisted chord creation.
2. Store exact selected MIDI notes plus an optional display hint.
3. Compile plain chords into correctly decomposed and measure-positioned segments.
4. Render those segments with VexFlow.
5. Play those exact segments with Tone.js.
6. Add play, stop/reset, tempo, key, time-signature, and clef controls.

Exit condition: a user can add a chord, see the exact pitches notated, and hear the same pitches for the correct duration.

### Phase 2 — Transition engine

1. Implement the technique registry exactly as specified.
2. Implement beat-budget filtering in the seam selector.
3. Implement closest-voicing search for technique chords only.
4. Insert technique events into the departing chord's tail.
5. Implement run-length capping for `scaleRun` and `arpBridge` where applicable.
6. Render generated segments in an accent color and play them from the same list.

Exit condition: every technique can be selected in a valid context, respects timing, targets the arriving chord, and does not modify user-entered voicings.

### Phase 3 — Educational coach

1. Build the coach request from compiled truth, not UI labels alone.
2. Provide the two flanking chords, their exact MIDI voicings, selected technique metadata, and generated connecting notes.
3. Call GPT-5.6 only from `/api/coach.js`.
4. Render the structured response beside the selected seam.
5. Add loading, timeout, malformed-response, and retry handling.

Exit condition: selecting a seam produces a grounded explanation of what the user hears, why it works, and what to try.

### Phase 4 — Demo hardening

1. Add current-measure playback highlighting.
2. Test the deployed URL, not only localhost.
3. Verify keyboard input, responsive layout, audio initialization, API errors, and repeated playback.
4. Finish README and provide one deterministic sample progression.

Exit condition: a judge can open the app, understand the interaction without instruction, complete the learning loop, and reproduce it from the README.

## 8. Coach Contract

Keep the existing theory guardrails, with these refinements:

- Target an intermediate-to-advanced pianist; do not describe the learner as a beginner.
- Explain jargon briefly when it is first used, but do not oversimplify established concepts.
- Ground factual claims in exact supplied notes and technique metadata.
- Ground measure references in the supplied one-based score location; never infer or invent a measure number.
- Distinguish observed facts from interpretive musical effect.
- Never infer a global tonal center from `settings.key`; it applies its named sharps/flats to material, but is not proof of a tonal center.
- Never claim a shared tone, resolved tendency tone, parsimonious movement, or bass motion unless the supplied MIDI notes support it.
- When the data is insufficient, state the limitation plainly.

Use a separate response contract for each Tutor mode:

```jsonc
// Explain
{ "type": "explanation",
  "whatYouHear": "string",
  "whyItWorks": "string",
  "tryThis": "string",
  "reflect": "string" }

// Suggestions
{ "type": "suggestion", "suggestion": "string", "reason": "string" }

// Ask transport envelope; the model itself returns natural plain text
{ "type": "answer", "answer": "string" }
```

Required educational roles:

- `whatYouHear`: describe the perceived effect in one or two sentences.
- `whyItWorks`: explain supported harmonic, melodic, rhythmic, or voice-leading details.
- `tryThis`: give one listening or playing experiment in Explain mode.
- `reflect`: ask one short learner question that encourages comparison or prediction.
- `suggestion`: give one concrete change the learner can manually try.
- `reason`: briefly explain the suggestion using supplied evidence.
- `answer`: preserve the model's natural conversational answer without fixed educational headings.

Validate the selected mode and its response on the server. Use strict structured output for Explain and Suggestions, and plain model text wrapped by the server for Ask. If validation fails, return a safe error instead of rendering partially trusted fields.

### Suggested server-side prompt

```text
You are LEGATO, a warm, concise AI music tutor for an intermediate-to-advanced pianist.

Use accurate, practical music-theory language. Explain only what is supported by the supplied chord, voicing, generated-note, rhythm, and transition data. Never invent notes, extensions, tonal centers, keys, functional labels, or voice-leading details. The score's key-signature setting controls spelling and is not proof of a tonal center. If a technique is absent, ambiguous, or unsupported by the data, state that plainly.

Match the requested Tutor mode:
- Explain: strict JSON containing type=explanation, whatYouHear, whyItWorks, tryThis, and reflect.
- Suggestions: strict JSON containing type=suggestion, one concrete suggestion, and a brief reason.
- Ask: answer the learner naturally in plain text without fixed headings or JSON.

Keep the complete response under 180 words. Be encouraging but specific. Briefly explain specialized terminology when useful. Do not use generic praise.
```

### Accuracy strategy

Do not train or fine-tune a model for the first sample. Accuracy will improve more quickly through grounded inputs and deterministic checks:

1. Compute objective facts in code: pitch classes, bass and soprano motion, common tones, semitone motion, interval changes, beat costs, generated notes, and score measure location.
2. Pass those computed facts to GPT-5.6 as structured evidence.
3. Ask GPT-5.6 to explain the facts pedagogically rather than rediscover them.
4. Maintain a small golden set covering all eight techniques plus direct transitions.
5. Have a musically knowledgeable teammate review the golden answers.
6. Log or locally capture failed examples during development and convert them into regression cases.

This is recommended implementation guidance, not a change to the progression or compile data model.

## 9. Important Prompt Correction

The current mood-to-progression prompt says it serves a beginner and requests `{rootMidi, quality, bars, inversion}` objects. This does not match the target audience or the notes-as-truth progression contract.

Because mood generation is deferred, do not block the first sample on this. Before enabling it later:

- Change the audience to intermediate-to-advanced pianists.
- Treat generated root/quality/inversion data as a proposal that is converted through the same chord factory into explicit `notes`.
- Store only the resulting chord object defined by `state.js`; do not introduce a parallel chord representation.
- Validate quality names against the chord table and reject malformed model output.

## 10. Automated Tests

Use the repository's existing JavaScript test framework. If none exists, add the smallest suitable setup and document the command.

### Required engine tests

1. A generated technique chord stays near the departing chord's register even when the arriving chord is in a distant octave.
2. A wide scale run never exceeds its allocated beat budget.
3. Plain user chords retain their exact MIDI notes after compilation.
4. Compiled segment durations fill the expected total duration without overflow.
5. Cross-measure splits share a `sourceId` and have correct measure-relative `startBeat` values.
6. Unknown technique keys behave like `null` and warn without throwing.
7. `reconcileSeams` preserves unchanged adjacencies and clears changed ones.
8. A technique is unavailable when `beatCost > availableBeats`.
9. Tempo changes do not change compile output.
10. `hint` changes do not change compile output.

### Coach tests

1. The prompt contains exact chord voicings and generated notes.
2. No tonal key is inferred from the key-signature setting.
3. A direct transition is described as direct and does not invent a technique.
4. Invalid model JSON produces a controlled error.
5. The API key never appears in client JavaScript or browser-delivered configuration.

## 11. First-Sample Acceptance Criteria

The first sample is complete only when all of the following are true:

- Running the documented local command opens a usable app with no console-breaking error.
- A default progression appears or can be loaded with one click.
- A user can add at least two explicitly voiced chords through the piano modal.
- The displayed notation and scheduled audio come from one compiled segment list.
- The exact user-entered MIDI notes are preserved.
- The user can select at least one valid technique and hear and see its generated material.
- All eight registry techniques exist and pass deterministic engine checks, even if the demo highlights only two or three.
- Ineligible techniques are disabled or hidden based on the departing chord's available beat budget.
- The current measure receives a basic visual highlight during playback.
- The selected seam can be sent to GPT-5.6 through the server endpoint.
- The coach returns the validated mode-specific response: a four-section explanation, a suggestion with a reason, or a natural Ask answer.
- Coach failure does not break composition, notation, or playback.
- The two non-negotiable silent-failure tests pass.
- The README lets another developer run the app and tests from a clean clone.

## 12. Demo Scenario

Bundle a concise progression that showcases audible contrast and explainable voice leading. Use explicit MIDI voicings and confirm the exact progression with the music lead before hardcoding it.

Suggested demonstration sequence:

1. Load the example and play the direct transition.
2. Select one block-chord technique, such as `secondaryDom`, and replay.
3. Open the coach explanation and show all four educational fields.
4. Open Suggestions to show one focused alternative and its reason.
5. Ask a follow-up question and show its natural conversational answer.
6. Try the suggestion, replay, and compare.

Do not claim that one transition is universally “better.” Describe how the musical effect changes and let the pianist compare alternatives.

## 13. Codex Delivery Format

When the first sample is ready, report:

1. What is now working.
2. The files materially changed.
3. How to run the app locally.
4. How to configure the server-side OpenAI key.
5. How to run tests and their results.
6. Any documented assumptions or deviations from the authoritative data model.
7. Deferred features and the next recommended milestone.

Do not stop after scaffolding. Continue until the first-sample acceptance criteria are met, or until a concrete external dependency requires user action.
