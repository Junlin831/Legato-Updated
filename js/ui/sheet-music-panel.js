/**
 * Sheet music surface: VexFlow SVG (scrollable, no zoom control) plus the
 * transport row (play/stop plus a session-only tempo override).
 *
 * The tempo control here is a session-only override: it never mutates the
 * project's persistent settings. When the persistent tempo changes
 * externally (via project settings), the override is cleared so the panel
 * reflects the new source of truth. Clef is only ever set via project
 * settings now — no quick-access override here.
 *
 * The transport row is a sibling inside <main class="sheet-music-pane">;
 * this module exposes its mount point for editor-view. Going home is handled
 * by editor-view's persistent top brand bar; opening the floating Chords
 * panel is handled by editor-view via the `onToggleChordsPanel` callback.
 * `onNotationLayoutChange` fires on every redraw with the measure count and
 * how many bars each system holds, so the FOV minimap's own row-wrapping can
 * mirror the real sheet (see chords-minimap.js) instead of drifting from it.
 */
import { renderNotation } from '../sheet-music/render.js';
import { createSheetMusicParticles } from '../sheet-music/particles.js';
import { TEMPO_MIN, TEMPO_MAX } from '../state.js';
import { icon } from './icons.js';

const TEMPLATE = `
<section class="notation-stage" aria-label="Progression notation">
  <div class="notation-stage-toolbar">
    <button id="chords-panel-toggle" class="chords-panel-toggle" type="button" aria-label="Open chords panel" aria-pressed="false">${ icon('density') }</button>
  </div>
  <div class="staff-glow" aria-hidden="true"></div>
  <div id="sheet-music-layer" class="sheet-music-layer">
    <div id="sheet-music" class="sheet-music"></div>
    <canvas id="sheet-music-particles" class="sheet-music-particles" aria-hidden="true"></canvas>
  </div>
  <div class="sheet-music-progress-rail" aria-hidden="true"><span></span></div>
</section>

<div class="transport-row">
  <div id="transport-mount"></div>
  <div class="sheet-music-controls">
    <label>
      <span>Tempo</span>
      <div class="tempo-control">
        <input id="sheet-music-tempo-slider" type="range" min="${ TEMPO_MIN }" max="${ TEMPO_MAX }" step="1" />
        <input id="sheet-music-tempo-input" type="number" min="${ TEMPO_MIN }" max="${ TEMPO_MAX }" step="1" inputmode="numeric" />
        <small>BPM</small>
      </div>
    </label>
  </div>
</div>
`;

export function mountSheetMusicPanel({ container, callbacks = {} }) {
  container.classList.add('sheet-music-pane');
  container.innerHTML = TEMPLATE;

  const sheetMusicEl = container.querySelector('#sheet-music');
  const particlesCanvas = container.querySelector('#sheet-music-particles');
  const particles = createSheetMusicParticles(particlesCanvas);
  const chordsPanelToggleBtn = container.querySelector('#chords-panel-toggle');
  chordsPanelToggleBtn.addEventListener('click', () => callbacks.onToggleChordsPanel?.());
  const tempoSliderEl = container.querySelector('#sheet-music-tempo-slider');
  const tempoInputEl = container.querySelector('#sheet-music-tempo-input');

  let resizeFrame = 0;
  let currentSegments = [];
  let baseSettings = null;
  let effectiveSettings = null;
  let currentChords = [];
  let activeMeasure = null;
  let overrideTempo = null;
  let measureCount = 0;
  let measuresPerSystem = 1;

  function computeEffectiveSettings() {
    if (!baseSettings) return null;
    return {
      ...baseSettings,
      tempo: overrideTempo ?? baseSettings.tempo,
    };
  }

  function applyActiveMeasureClasses() {
    container.querySelectorAll('.measure-group').forEach((measure) => {
      measure.classList.toggle('is-playing', Number(measure.dataset.measure) === activeMeasure);
    });
  }

  function setPlaybackControlsDisabled(disabled) {
    tempoSliderEl.disabled = disabled;
    tempoInputEl.disabled = disabled;
    container.querySelector('.sheet-music-controls')?.classList.toggle('is-disabled', disabled);
  }

  function drawSheetMusic() {
    if (!effectiveSettings) {
      measureCount = 0;
      measuresPerSystem = 1;
      callbacks.onNotationLayoutChange?.({ measureCount, measuresPerSystem });
      return { measureCount: 0, layout: [], measuresPerSystem: 1 };
    }
    const result = renderNotation(sheetMusicEl, currentSegments, effectiveSettings, currentChords);
    measureCount = result.measureCount;
    measuresPerSystem = result.measuresPerSystem;
    particles.setSheetMusic(sheetMusicEl.querySelector('svg'), result.layout);
    applyActiveMeasureClasses();
    // Fires on every redraw, including the resize-triggered ones from
    // scheduleRerender() below — measuresPerSystem depends on viewport width,
    // so the FOV minimap (js/ui/chords-minimap.js) needs to stay in sync with
    // resizes too, not just progression edits.
    callbacks.onNotationLayoutChange?.({ measureCount, measuresPerSystem });
    return result;
  }

  function scheduleRerender() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(drawSheetMusic);
  }

  window.addEventListener('resize', scheduleRerender);
  const panelResizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(scheduleRerender);
  panelResizeObserver?.observe(container);

  // ── Tempo override ────────────────────────────────────────────────
  function syncTempoInputs(tempo) {
    if (document.activeElement !== tempoSliderEl) tempoSliderEl.value = String(tempo);
    if (document.activeElement !== tempoInputEl) tempoInputEl.value = String(tempo);
  }

  function applyTempo(tempo) {
    const clamped = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(tempo)));
    overrideTempo = clamped;
    effectiveSettings = computeEffectiveSettings();
    syncTempoInputs(clamped);
    // Tempo affects only playback timing, not the notation itself. Skip the
    // re-render so scrubbing the slider doesn't thrash VexFlow.
    callbacks.onEffectiveSettingsChange?.(effectiveSettings);
  }

  tempoSliderEl.addEventListener('input', (event) => {
    applyTempo(Number(event.target.value));
  });
  tempoInputEl.addEventListener('input', (event) => {
    const parsed = Number(event.target.value);
    if (!Number.isFinite(parsed)) return;
    applyTempo(parsed);
  });
  tempoInputEl.addEventListener('blur', () => {
    if (overrideTempo != null) syncTempoInputs(overrideTempo);
  });

  return {
    transportMount: container.querySelector('#transport-mount'),
    particles,
    render(segments, settings, chords = []) {
      currentSegments = segments;
      currentChords = chords;
      // Reset the override when the persistent tempo changes externally so
      // the panel never disagrees with the source of truth after a project
      // settings edit.
      if (baseSettings && baseSettings.tempo !== settings.tempo) overrideTempo = null;
      baseSettings = settings;
      effectiveSettings = computeEffectiveSettings();
      syncTempoInputs(effectiveSettings.tempo);
      drawSheetMusic();
    },
    setActiveMeasure(index) {
      activeMeasure = index;
      applyActiveMeasureClasses();
    },
    setPlaybackControlsDisabled,
    /** Effective (override-aware) settings used for playback and rendering. */
    getEffectiveSettings() {
      return effectiveSettings ?? baseSettings;
    },
    setChordsPanelOpen(open) {
      chordsPanelToggleBtn.classList.toggle('is-active', open);
      chordsPanelToggleBtn.setAttribute('aria-pressed', String(open));
      chordsPanelToggleBtn.setAttribute('aria-label', open ? 'Close chords panel' : 'Open chords panel');
    },
    unmount() {
      window.removeEventListener('resize', scheduleRerender);
      panelResizeObserver?.disconnect();
      cancelAnimationFrame(resizeFrame);
      particles.destroy();
    },
  };
}
