/**
 * Editor view — the two-pane composition workspace.
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
 */
import { compile, makeChord, makeRest, makeTheme, reconcileSeams, beatsToBars, isTechniqueUsable } from '../state.js';
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
import { mountTransport } from '../ui/transport.js';
import { applyTheme, clearTheme } from '../theme.js';
import { navigate, LANDING_HASH } from '../router.js';
import { icon } from '../ui/icons.js';
import { withViewFade } from '../ui/view-fade.js';

const SHELL_TEMPLATE = `
  <div class="app-shell">
    <aside id="editor-pane-mount"></aside>
    <div id="panel-resizer" class="panel-resizer" role="separator" aria-label="Resize editor and notation panels" aria-orientation="vertical" aria-controls="editor-pane-mount sheet-music-pane-mount" tabindex="0">
      <button type="button" id="panel-collapse-toggle" class="panel-collapse-toggle" aria-label="Collapse editor panel" aria-expanded="true" aria-controls="editor-pane-mount">${ icon('chevronLeft') }</button>
    </div>
    <main id="sheet-music-pane-mount"></main>
  </div>
`;

const AUTOSAVE_DEBOUNCE_MS = 500;
const MIN_EDITOR_PANE_WIDTH = 410;
const MIN_SHEET_MUSIC_PANE_WIDTH = 480;

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
      const editorPaneMount = shell.querySelector('#editor-pane-mount');
      const panelResizer = shell.querySelector('#panel-resizer');
      const collapseToggle = shell.querySelector('#panel-collapse-toggle');
      let activeResizePointerId = null;
      // Starts collapsed so the sheet music fills the screen on open; the
      // user expands it explicitly via the toggle. No prior width to restore
      // to yet, so the first expand falls back to MIN_EDITOR_PANE_WIDTH (see
      // toggleEditorCollapse's `widthBeforeCollapse || min`).
      let editorCollapsed = true;
      let widthBeforeCollapse = null;
      shell.classList.add('is-editor-collapsed');
      shell.style.setProperty('--editor-pane-width', '0px');
      collapseToggle.setAttribute('aria-expanded', 'false');
      collapseToggle.setAttribute('aria-label', 'Expand editor panel');
      collapseToggle.title = 'Expand editor panel';

      function isSideBySideLayout() {
        return !window.matchMedia('(max-width: 1000px)').matches;
      }

      function getPaneResizeBounds() {
        const shellBounds = shell.getBoundingClientRect();
        const splitterWidth = panelResizer.getBoundingClientRect().width;
        return {
          left: shellBounds.left,
          min: MIN_EDITOR_PANE_WIDTH,
          max: Math.max(MIN_EDITOR_PANE_WIDTH, shellBounds.width - splitterWidth - MIN_SHEET_MUSIC_PANE_WIDTH),
        };
      }

      function syncPanelResizer() {
        if (!isSideBySideLayout()) return;
        const { min, max } = getPaneResizeBounds();
        // While collapsed the explicit width is intentionally below the
        // ordinary minimum (0px) — clamping it here would fight the collapse.
        if (!editorCollapsed) {
          const explicitWidth = Number.parseFloat(shell.style.getPropertyValue('--editor-pane-width'));
          if (Number.isFinite(explicitWidth)) {
            const clampedWidth = Math.min(max, Math.max(min, explicitWidth));
            if (clampedWidth !== explicitWidth) shell.style.setProperty('--editor-pane-width', `${ clampedWidth }px`);
          }
        }
        const editorWidth = Math.round(editorPaneMount.getBoundingClientRect().width);
        panelResizer.setAttribute('aria-valuemin', String(min));
        panelResizer.setAttribute('aria-valuemax', String(max));
        panelResizer.setAttribute('aria-valuenow', String(editorWidth));
        panelResizer.setAttribute('aria-valuetext', `Editor panel width ${ editorWidth } pixels`);
      }

      function setEditorPaneWidth(width) {
        if (!isSideBySideLayout() || editorCollapsed) return;
        const { min, max } = getPaneResizeBounds();
        const nextWidth = Math.round(Math.min(max, Math.max(min, width)));
        shell.style.setProperty('--editor-pane-width', `${ nextWidth }px`);
        syncPanelResizer();
      }

      function stopPanelResize() {
        activeResizePointerId = null;
        shell.classList.remove('is-resizing');
      }

      // Collapsing lets the sheet-music pane claim the full viewport width —
      // useful for a denser score or just a bigger, higher-resolution stage
      // for the cosmic notation. The pane's own ResizeObserver (see
      // sheet-music-panel.js) already reflows VexFlow and the particle
      // renderer whenever their container resizes, so no extra wiring is
      // needed there.
      function toggleEditorCollapse() {
        if (!isSideBySideLayout()) return;
        editorCollapsed = !editorCollapsed;
        if (editorCollapsed) {
          widthBeforeCollapse = editorPaneMount.getBoundingClientRect().width;
          shell.style.setProperty('--editor-pane-width', '0px');
        } else {
          const { min, max } = getPaneResizeBounds();
          const restored = Math.min(max, Math.max(min, widthBeforeCollapse || min));
          shell.style.setProperty('--editor-pane-width', `${ Math.round(restored) }px`);
        }
        shell.classList.toggle('is-editor-collapsed', editorCollapsed);
        collapseToggle.setAttribute('aria-expanded', String(!editorCollapsed));
        const label = editorCollapsed ? 'Expand editor panel' : 'Collapse editor panel';
        collapseToggle.setAttribute('aria-label', label);
        collapseToggle.title = label;
        syncPanelResizer();
      }

      collapseToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleEditorCollapse();
      });
      panelResizer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !isSideBySideLayout() || editorCollapsed || collapseToggle.contains(event.target)) return;
        event.preventDefault();
        activeResizePointerId = event.pointerId;
        panelResizer.setPointerCapture(event.pointerId);
        shell.classList.add('is-resizing');
        const { left } = getPaneResizeBounds();
        setEditorPaneWidth(event.clientX - left);
      });
      panelResizer.addEventListener('pointermove', (event) => {
        if (event.pointerId !== activeResizePointerId) return;
        const { left } = getPaneResizeBounds();
        setEditorPaneWidth(event.clientX - left);
      });
      panelResizer.addEventListener('pointerup', stopPanelResize);
      panelResizer.addEventListener('pointercancel', stopPanelResize);
      panelResizer.addEventListener('lostpointercapture', stopPanelResize);
      panelResizer.addEventListener('keydown', (event) => {
        if (!isSideBySideLayout() || editorCollapsed || collapseToggle.contains(event.target)) return;
        const { min, max } = getPaneResizeBounds();
        const currentWidth = editorPaneMount.getBoundingClientRect().width;
        const step = event.shiftKey ? 80 : 24;
        const nextWidth = event.key === 'ArrowLeft' ? currentWidth - step
          : event.key === 'ArrowRight' ? currentWidth + step
            : event.key === 'Home' ? min
              : event.key === 'End' ? max
                : null;
        if (nextWidth == null) return;
        event.preventDefault();
        setEditorPaneWidth(nextWidth);
      });
      window.addEventListener('resize', syncPanelResizer);
      requestAnimationFrame(syncPanelResizer);

      async function goHome() {
        await withViewFade(async () => navigate(LANDING_HASH));
      }

      const sheetMusic = mountSheetMusicPanel({
        container: shell.querySelector('#sheet-music-pane-mount'),
        callbacks: {
          onEffectiveSettingsChange() {
            // Tempo/clef overrides don't touch progression state, but they do
            // affect what Play should schedule. Nothing else to do here — the
            // panel and audio scheduler both re-read effective settings on
            // demand.
          },
          // Also reachable from the sidebar's own brand button, but that's
          // hidden while the editor panel is collapsed — this is the only way
          // home when the sheet music fills the screen.
          onGoHome: goHome,
        },
      });

      const editor = mountEditorPanel({
        container: shell.querySelector('#editor-pane-mount'),
        callbacks: {
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
                  theme: { ...progression.settings.theme },
                },
              },
              onSubmit: ({ name, settings }) => applyProjectSettings({ name, settings }),
              onAccentPreview: (accent) => applyTheme({
                ...progression.settings.theme,
                accent,
              }),
            });
          },
          onAddChord() {
            editingId = null;
            openPianoModal(pianoDialog, null, saveChord, progression.settings.timeSig, progression.settings.key);
          },
          onAddRest() {
            const rest = makeRest(beatsToBars(1, progression.settings.timeSig));
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
            replaceChords(progression.chords.filter((item) => item.id !== chord.id));
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
        const nameChanged = currentName !== name;
        const nextTheme = makeTheme(settings.theme);
        const themeChanged = previous.theme.accent !== nextTheme.accent || previous.theme.chordFont !== nextTheme.chordFont;

        currentName = name;
        progression.settings = {
          tempo: settings.tempo,
          timeSig: { ...settings.timeSig },
          meterType: settings.meterType ?? previous.meterType,
          key: settings.key,
          clef: settings.clef,
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
        if (tempoChanged || keyChanged || timeSigChanged || clefChanged || nameChanged || themeChanged) {
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
          window.removeEventListener('resize', syncPanelResizer);
          stopPlayback();
          await flushSave();
          editor.unmount?.();
          sheetMusic.unmount?.();
          clearTheme();
          root.replaceChildren();
        },
      };
    },
  };
}
