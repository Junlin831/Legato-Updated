/**
 * Editor view — the composition workspace.
 *
 * This is the previous `main.js` logic wrapped in a mount/unmount contract
 * so the router can swap between landing and editor. All state (progression,
 * segments, selectedSeam, key-source maps) lives locally in `mount()` — no
 * module-level singletons, so navigating away and back gives a clean slate.
 *
 *   UI mutates progression → compile() → segments
 *                                       → sheetMusic.render()
 *                                       → playSegments()
 *                                       → sheetMusic.setActiveMeasure()
 *
 * On top of every mutation, `scheduleAutosave()` debounces a write to the
 * ProjectStore so localStorage stays in sync without a manual save button.
 *
 * Layout: a persistent top bar (brand + project title, always visible — this
 * is also what the startup handoff animation lands on, see main.js) sits
 * above the full-width sheet music, which is free to use the whole viewport
 * since nothing docks to an edge. Chord editing lives in a small floating,
 * draggable card (see ui/chords-floating-panel.js) toggled by a round button
 * on the sheet's own toolbar — a picture-in-picture window the user parks
 * wherever they like, not a panel that permanently claims screen space.
 */
import { compile, makeChord, makeRest, makeTheme, reconcileSeams, beatsToBars, isTechniqueUsable, isRest } from '../state.js';
import { evaluateAllTechniques } from '../engine/technique-eligibility.js';
import {
  playSegments,
  stopPlayback,
  pausePlayback,
  resumePlayback,
  preparePlaybackAudio,
} from '../audio/playback.js';
import { openPianoModal, populateChordControls } from '../ui/piano-modal.js';
import { openProjectSettingsModal } from '../ui/project-settings-modal.js';
import { mountEditorPanel } from '../ui/editor-panel.js';
import { mountSheetMusicPanel } from '../ui/sheet-music-panel.js';
import { mountChordsFloatingPanel } from '../ui/chords-floating-panel.js';
import { mountChordsMinimap } from '../ui/chords-minimap.js';
import { mountTransport } from '../ui/transport.js';
import { applyTheme, clearTheme } from '../theme.js';
import { navigate, LANDING_HASH } from '../router.js';
import { withViewFade } from '../ui/view-fade.js';

const SHELL_TEMPLATE = `
  <div class="app-shell">
    <header id="editor-topbar-mount" class="editor-topbar"></header>
    <main id="sheet-music-pane-mount"></main>
    <div id="chords-floating-mount"></div>
  </div>
`;

const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * @param {{ store: ReturnType<import('../persistence.js').createProjectStore>, pianoDialog: any, projectSettingsDialog: any }} deps
 */
export function createEditorView({ store, pianoDialog, projectSettingsDialog }) {
  return {
    async mount(root, params) {
      const project = await store.getProject(params.id);
      if (!project || project.deletedAt) {
        navigate(LANDING_HASH);
        return { unmount() {} };
      }
      // Ensure the shared piano modal is populated for this session.
      populateChordControls(pianoDialog);

      // ── Local state (was module-level in the old main.js) ────────────
      let progression = project.progression;
      let currentName = project.name;
      let segments = [];
      let editingId = null;
      let selectedSeam = 0;

      // Apply per-project accent + chord-font to the document root so every
      // panel restyles instantly. Cleared on unmount so navigating away
      // (landing page, other project) doesn't inherit this project's look.
      applyTheme(progression.settings.theme);

      // ── DOM shell + panels ──────────────────────────────────────────
      root.insertAdjacentHTML('beforeend', SHELL_TEMPLATE);
      const shell = root.querySelector('.app-shell');
      const editorTopbarMount = shell.querySelector('#editor-topbar-mount');

      // Floating, not docked — starts closed so the sheet fills the screen;
      // the user opens it explicitly via the round toggle on the sheet's
      // toolbar. Unlike the old docked drawer, clicking elsewhere on the
      // sheet does NOT close it — a picture-in-picture window is meant to
      // stay put while you work, not disappear on a stray click.
      const chordsPanel = mountChordsFloatingPanel({
        container: shell.querySelector('#chords-floating-mount'),
      });
      const chordsMinimap = mountChordsMinimap({ container: chordsPanel.minimapMount });

      async function goHome() {
        await withViewFade(async () => navigate(LANDING_HASH));
      }

      function toggleChordsPanel() {
        chordsPanel.toggle();
        sheetMusic.setChordsPanelOpen(chordsPanel.isOpen());
      }

      const sheetMusic = mountSheetMusicPanel({
        container: shell.querySelector('#sheet-music-pane-mount'),
        callbacks: {
          onEffectiveSettingsChange() {
            // The tempo override doesn't touch progression state, but it
            // does affect what Play should schedule. Nothing else to do
            // here — the panel and audio scheduler both re-read effective
            // settings on demand.
          },
          onToggleChordsPanel: toggleChordsPanel,
          onNotationLayoutChange({ measureCount, measuresPerSystem }) {
            chordsMinimap.render(measureCount, measuresPerSystem);
          },
        },
      });

      const editor = mountEditorPanel({
        headerContainer: editorTopbarMount,
        bodyContainer: chordsPanel.bodyContainer,
        callbacks: {
          onVisibleBarsChange(range) {
            chordsMinimap.setVisibleRange(range);
          },
          onEditProjectSettings() {
            openProjectSettingsModal(projectSettingsDialog, {
              mode: 'edit',
              initial: {
                name: currentName,
                settings: {
                  tempo: progression.settings.tempo,
                  timeSig: { ...progression.settings.timeSig },
                  meterType: progression.settings.meterType,
                  key: progression.settings.key,
                  clef: progression.settings.clef,
                  cardDensity: progression.settings.cardDensity,
                },
              },
              onSubmit: ({ name, settings }) => applyProjectSettings({ name, settings }),
            });
          },
          onAddChord() {
            editingId = null;
            openPianoModal(pianoDialog, null, saveChord, progression.settings.timeSig, progression.settings.key);
          },
          onAddRest() {
            // A whole bar by default, same as a freshly added chord fills a
            // full bar until the user shortens it via the beats dropdown.
            const rest = makeRest(1);
            progression.chords.push(rest);
            if (progression.chords.length > 1) progression.seams.push(null);
            resetIneligibleSeams();
            rerender();
            editor.animateAddedChord(rest.id);
          },
          onEditChord(chord) {
            editingId = chord.id;
            openPianoModal(pianoDialog, chord, saveChord, progression.settings.timeSig, progression.settings.key);
          },
          onDeleteChord(chord) {
            // No confirmation dialog — that would add friction to routine
            // edits — but a misclick shouldn't be unrecoverable either, so
            // the panel offers a brief undo instead (apple-design's
            // agency/forgiveness principle).
            const previousChords = progression.chords;
            const previousSeams = progression.seams;
            const previousSelectedSeam = selectedSeam;
            replaceChords(progression.chords.filter((item) => item.id !== chord.id));
            editor.offerDeleteUndo(isRest(chord) ? 'Rest removed' : 'Chord removed', () => {
              progression.chords = previousChords;
              progression.seams = previousSeams;
              selectedSeam = previousSelectedSeam;
              rerender();
            });
          },
          onReorderChords(orderedIds) {
            const byId = new Map(progression.chords.map((c) => [c.id, c]));
            const nextChords = orderedIds.map((id) => byId.get(id)).filter(Boolean);
            if (nextChords.length !== progression.chords.length) return;
            replaceChords(nextChords);
          },
          onSetChordBeats(chord, beats) {
            chord.bars = beatsToBars(beats, progression.settings.timeSig);
            resetIneligibleSeams();
            rerender();
          },
          onSelectSeam(index) {
            selectedSeam = index;
            editor.render({ progression, selectedSeam, projectName: currentName });
          },
          onSetSeamTechnique(index, techniqueId) {
            progression.seams[index] = techniqueId;
            selectedSeam = index;
            rerender();
          },
          onGoHome: goHome,
          onRenameProject(name) {
            const clean = name.trim() || 'Untitled project';
            currentName = clean;
            scheduleAutosave();
            editor.render({ progression, selectedSeam, projectName: currentName });
          },
        },
      });

      const transport = mountTransport({
        container: sheetMusic.transportMount,
        callbacks: {
          onPlayToggle: handlePlayToggle,
          onStop: handleStop,
        },
      });

      // ── Autosave ────────────────────────────────────────────────────
      let saveTimer = null;
      let saveInFlight = false;

      function scheduleAutosave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
      }

      async function flushSave() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (saveInFlight) return;
        saveInFlight = true;
        try {
          await store.saveProject({
            ...project,
            name: currentName,
            progression,
          });
          editor.flashSaved();
        } catch (error) {
          console.error(error);
        } finally {
          saveInFlight = false;
        }
      }

      const beforeUnload = () => { flushSave(); };
      window.addEventListener('beforeunload', beforeUnload);

      // ── State mutation helpers (behavior identical to old main.js) ──
      function replaceChords(nextChords) {
        progression.seams = reconcileSeams(progression.chords, progression.seams, nextChords);
        progression.chords = nextChords;
        resetIneligibleSeams();
        selectedSeam = Math.min(selectedSeam, Math.max(0, progression.seams.length - 1));
        rerender();
      }

      function applyProjectSettings({ name, settings }) {
        const previous = progression.settings;
        const tempoChanged = previous.tempo !== settings.tempo;
        const timeSigChanged = previous.timeSig.num !== settings.timeSig.num || previous.timeSig.den !== settings.timeSig.den;
        const keyChanged = previous.key !== settings.key;
        const clefChanged = previous.clef !== settings.clef;
        const cardDensityChanged = previous.cardDensity !== settings.cardDensity;
        const nameChanged = currentName !== name;
        const nextTheme = makeTheme();
        const themeChanged = previous.theme.accent !== nextTheme.accent || previous.theme.chordFont !== nextTheme.chordFont;

        currentName = name;
        progression.settings = {
          tempo: settings.tempo,
          timeSig: { ...settings.timeSig },
          meterType: settings.meterType ?? previous.meterType,
          key: settings.key,
          clef: settings.clef,
          cardDensity: settings.cardDensity ?? previous.cardDensity,
          theme: nextTheme,
        };
        if (themeChanged) applyTheme(nextTheme);

        // Key is spelling only: it never mutates chord.notes. Transposition is
        // a separate future feature. Time signature can invalidate technique
        // seam beat-costs, so those still get re-checked here.
        if (timeSigChanged) resetIneligibleSeams();

        // Theme flips need a rerender so the chord-font toggle syncs its
        // active pill and the meta pills re-read the accent-derived colors.
        // (Accent color itself cascades via CSS custom properties without a
        // rerender, but the segmented toggle stores its state in DOM classes.)
        if (tempoChanged || keyChanged || timeSigChanged || clefChanged || cardDensityChanged || nameChanged || themeChanged) {
          rerender();
        } else {
          scheduleAutosave();
        }
      }

      function resetIneligibleSeams() {
        progression.seams = progression.seams.map((techniqueId, index) => {
          if (!techniqueId) return null;
          const technique = evaluateAllTechniques(progression.chords[index], progression.chords[index + 1])
            .find((candidate) => candidate.id === techniqueId);
          return technique?.valid && isTechniqueUsable(technique, progression.chords[index], progression.settings.timeSig)
            ? techniqueId
            : null;
        });
      }

      function saveChord(input) {
        let changedChordId;
        let addedChord = null;
        if (editingId) {
          const chord = progression.chords.find((item) => item.id === editingId);
          const { hint: _oldHint, ...withoutHint } = chord;
          Object.assign(chord, withoutHint, input);
          if (!input.hint) delete chord.hint;
          changedChordId = chord.id;
        } else {
          addedChord = makeChord(input.notes, input.bars, input.hint);
          progression.chords.push(addedChord);
          if (progression.chords.length > 1) progression.seams.push(null);
          changedChordId = addedChord.id;
        }
        resetIneligibleSeams();
        editingId = null;
        rerender();
        if (addedChord) editor.animateAddedChord(addedChord.id);
      }

      // ── Transport ───────────────────────────────────────────────────
      /** @type {'idle' | 'playing' | 'paused'} */
      let playbackState = 'idle';
      let playbackRequest = 0;

      function setPlaybackState(next) {
        playbackState = next;
        sheetMusic.setPlaybackControlsDisabled(next === 'playing');
        if (next === 'playing') transport.setPlayMode('pause');
        else if (next === 'paused') transport.setPlayMode('resume');
        else transport.setPlayMode('play');
      }

      function handlePlayToggle() {
        if (playbackState === 'playing') {
          pausePlayback();
          setPlaybackState('paused');
          sheetMusic.particles.settle({ preserveProgress: true });
        } else if (playbackState === 'paused') {
          resumePlayback();
          setPlaybackState('playing');
          sheetMusic.particles.beginPlayback({ resume: true });
        } else {
          startPlaybackFromStart();
        }
      }

      async function startPlaybackFromStart() {
        const request = ++playbackRequest;
        transport.setPlayEnabled(false);
        const playbackSettings = sheetMusic.getEffectiveSettings() ?? progression.settings;
        try {
          await Promise.all([
            preparePlaybackAudio(),
            sheetMusic.particles.ready(),
          ]);
          if (request !== playbackRequest) return;
          sheetMusic.particles.beginPlayback();
          setPlaybackState('playing');
          transport.setPlayEnabled(true);
          await playSegments(
            segments,
            playbackSettings,
            (measure) => {
              sheetMusic.setActiveMeasure(measure);
            },
            () => {
              sheetMusic.particles.settle();
              setPlaybackState('idle');
              transport.setPlayEnabled(true);
            },
            (progress, measure, measureProgress) => {
              sheetMusic.particles.setProgress(progress, measure, measureProgress);
            },
          );
        } catch (error) {
          sheetMusic.particles.settle({ immediate: true });
          setPlaybackState('idle');
          transport.setPlayEnabled(true);
          console.error(error);
        }
      }

      function handleStop() {
        playbackRequest++;
        stopPlayback();
        // Full reset: no progress rail, no lingering "paused" glow — Stop
        // should look identical to the just-loaded state.
        sheetMusic.particles.settle({ immediate: true });
        sheetMusic.setActiveMeasure(null);
        setPlaybackState('idle');
        transport.setPlayEnabled(true);
      }

      // ── Render pipeline ─────────────────────────────────────────────
      function rerender() {
        playbackRequest++;
        stopPlayback();
        sheetMusic.particles.settle({ immediate: true });
        sheetMusic.setActiveMeasure(null);
        setPlaybackState('idle');
        transport.setPlayEnabled(true);
        segments = compile(progression);
        editor.render({ progression, selectedSeam, projectName: currentName });
        sheetMusic.render(segments, progression.settings, progression.chords);
        scheduleAutosave();
      }

      rerender();
      shell.dataset.viewReady = 'true';

      return {
        async unmount() {
          playbackRequest++;
          window.removeEventListener('beforeunload', beforeUnload);
          stopPlayback();
          await flushSave();
          editor.unmount?.();
          sheetMusic.unmount?.();
          chordsMinimap.unmount?.();
          chordsPanel.unmount?.();
          clearTheme();
          root.replaceChildren();
        },
      };
    },
  };
}
