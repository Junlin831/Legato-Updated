# LEGATO

LEGATO is a chord progression composer for pianists. Build exact chord voicings, connect them with a harmonic technique, then see and hear the compiled result. The interface uses an editorial “sand hologram” composition-studio direction with Fraunces, Inter, and Space Grotesk.

## Run locally

Requires Node.js 20+.

```bash
npm start
```

Open `http://localhost:8000`. The app loads VexFlow, Tone.js, and Salamander piano samples from CDNs, so notation/audio need an internet connection on first load.

If port 8000 is already occupied, choose another one:

```bash
PORT=8001 npm start
```

## Architecture

The UI mutates one `progression`. Pure `compile()` turns it into atomic segments with exact pitches and timing. VexFlow notation, Tone.js playback, and highlighting all consume that same segment list. User MIDI voicings are never altered; generated technique material alone uses closest-voicing search.

Key areas: `js/state.js` (runtime contract), `js/engine/` (techniques, voice leading, rhythm), `js/notation/`, `js/audio/`, and `js/ui/`.

## Test

```bash
npm test
```

Tests cover seam preservation, validation, all eight registry techniques, user-voicing integrity, generated-register choice, run beat caps, measure-relative timing, and tempo and hint independence.

## Current scope

When an explicit note set does not exactly match a supported quality, technique targeting uses the chord’s lowest note as a deterministic fallback root without adding fields to stored state.
