/**
 * Composition workspace, split across two mount points:
 *   - `headerContainer` — the persistent top bar (brand + project title,
 *     Edit Project Settings, meta pills, save status). Always visible, never
 *     scrolls or collapses.
 *   - `bodyContainer` — the Chords section (Add Rest/Add Chord, the ordered
 *     progression list). Lives inside editor-view's bottom drawer.
 *
 * State lives in editor-view.js; this module renders from it and hands user
 * events back through `callbacks`. Score settings (tempo, time signature,
 * key, clef, chord card density) are all edited through the shared
 * project-settings-modal opened by the pencil button — they no longer have
 * inline controls here.
 */
import { availableBeats, beatChoicesForMeter, chordTotalBeats, barsToBeats, beatsToBars, isTechniqueUsable, isRest } from '../state.js';
import { chordDisplayName, formatChordSymbol, noteName, chordToneName, chordSpellingIdentity } from '../engine/chords.js';
import { evaluateAllTechniques } from '../engine/technique-eligibility.js';
import { escapeHtml } from '../util/html.js';
import { majorKeyName, timeSigLabel } from '../util/labels.js';
import { icon } from './icons.js';

const UI_MOTION_MS = 340;
const UI_MOTION_NAME = 'surface-enter';

const HEADER_TEMPLATE = `
<header class="brand-block">
  <button id="brand-home" class="brand-home" type="button" aria-label="Go to your constellation">
    <img class="brand-mark" src="/assets/brand/legato-icon.png" alt="" draggable="false">
    <span class="brand">LEGATO</span>
  </button>
</header>
<section class="project-title-block">
  <div class="project-title-row">
    <div id="project-name-field" class="project-name-field">
      <input id="project-name-input" class="project-name-input" type="text" spellcheck="false" autocomplete="off" aria-label="Project name" />
    </div>
    <div id="project-meta-pills" class="project-meta-pills"></div>
    <span id="save-status" class="save-status" aria-live="polite">Saved</span>
    <button id="edit-project-settings" class="edit-project-settings" type="button" aria-label="Edit project settings">
      ${ icon('edit') }<span>Edit Project Settings</span>
    </button>
  </div>
</section>
`;

const BODY_TEMPLATE = `
<section class="editor-section" aria-label="Chords">
  <div class="section-title">
    <div class="section-actions">
      <button id="add-rest" class="ghost-action" type="button">${ icon('rest') }<span>Add Rest</span></button>
      <button id="add-chord" class="primary-action" type="button">${ icon('plus') }<span>Add Chord</span></button>
    </div>
  </div>
  <div id="progression-list" class="progression-list"></div>
</section>

<div id="delete-toast" class="delete-toast" role="status" aria-live="polite">
  <span id="delete-toast-message" class="delete-toast-message"></span>
  <button id="delete-toast-undo" type="button" class="delete-toast-undo">Undo</button>
</div>
`;

export function mountEditorPanel({ headerContainer, bodyContainer, callbacks }) {
  headerContainer.classList.add('editor-topbar-inner');
  headerContainer.innerHTML = HEADER_TEMPLATE;
  bodyContainer.classList.add('chords-panel-scroll');
  bodyContainer.innerHTML = BODY_TEMPLATE;

  const progressionListEl = bodyContainer.querySelector('#progression-list');
  const chordsSectionEl = progressionListEl.closest('.editor-section');
  const addChordBtn = bodyContainer.querySelector('#add-chord');
  const addRestBtn = bodyContainer.querySelector('#add-rest');
  const saveStatusEl = headerContainer.querySelector('#save-status');
  const deleteToastEl = bodyContainer.querySelector('#delete-toast');
  const deleteToastMessageEl = bodyContainer.querySelector('#delete-toast-message');
  const deleteToastUndoBtn = bodyContainer.querySelector('#delete-toast-undo');

  // Drag-to-reorder chord cards. SortableJS observes DOM mutations, so the
  // instance survives the replaceChildren() inside renderProgression().
  const sortable = window.Sortable?.create(progressionListEl, {
    handle: '.chord-drag-handle',
    draggable: '.chord-row',
    animation: 200,
    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    ghostClass: 'chord-row--drag-ghost',
    chosenClass: 'chord-row--drag-chosen',
    dragClass: 'chord-row--drag-active',
    // Native HTML5 drag ghost is inconsistent across browsers; the fallback
    // path gives us a real DOM clone we can style.
    forceFallback: true,
    fallbackClass: 'chord-row--drag-fallback',
    onStart() {
      progressionListEl.classList.add('progression-list--dragging');
    },
    onEnd(evt) {
      progressionListEl.classList.remove('progression-list--dragging');
      if (evt.oldIndex === evt.newIndex) return;
      const orderedIds = [...progressionListEl.querySelectorAll('.chord-row')]
        .map((el) => el.dataset.chordId)
        .filter(Boolean);
      callbacks.onReorderChords(orderedIds);
    },
  });
  const brandHomeBtn = headerContainer.querySelector('#brand-home');
  const projectTitleRowEl = headerContainer.querySelector('.project-title-row');
  const projectNameFieldEl = headerContainer.querySelector('#project-name-field');
  const projectNameInput = headerContainer.querySelector('#project-name-input');
  const editSettingsBtn = headerContainer.querySelector('#edit-project-settings');
  const metaPillsEl = headerContainer.querySelector('#project-meta-pills');
  const expandedSeamIndexes = new Set();
  let directEditorOpenForCurrentRender = null;
  let currentBarRanges = [];

  // ── Bar-range tracking for the FOV minimap ────────────────────────
  // As the user scrolls the chord list, tell editor-view which bars are
  // currently in view so the minimap (see chords-minimap.js) can highlight
  // the matching cells — the minimap has no scroll of its own, so this is
  // its only way of tracking what's visible.
  function computeBarRanges(chords) {
    let bars = 0;
    return chords.map((chord) => {
      const start = Math.floor(bars) + 1;
      bars += chord.bars;
      const end = Math.max(start, Math.ceil(bars - 1e-6));
      return { start, end };
    });
  }

  let visibleBarsFrame = 0;
  function scheduleVisibleBarsReport() {
    cancelAnimationFrame(visibleBarsFrame);
    visibleBarsFrame = requestAnimationFrame(reportVisibleBars);
  }
  progressionListEl.addEventListener('scroll', scheduleVisibleBarsReport, { passive: true });

  function reportVisibleBars() {
    const rows = [...progressionListEl.querySelectorAll('.chord-row')];
    if (!rows.length) { callbacks.onVisibleBarsChange?.(null); return; }
    const listRect = progressionListEl.getBoundingClientRect();
    let firstIndex = null;
    let lastIndex = null;
    rows.forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > listRect.top && rect.top < listRect.bottom) {
        if (firstIndex === null) firstIndex = index;
        lastIndex = index;
      }
    });
    if (firstIndex === null) { callbacks.onVisibleBarsChange?.(null); return; }
    const start = currentBarRanges[firstIndex]?.start ?? 1;
    const end = currentBarRanges[lastIndex]?.end ?? start;
    callbacks.onVisibleBarsChange?.({ start, end });
  }

  addChordBtn.onclick = () => callbacks.onAddChord();
  addRestBtn.onclick = () => callbacks.onAddRest();
  brandHomeBtn.onclick = () => callbacks.onGoHome();
  editSettingsBtn.onclick = () => callbacks.onEditProjectSettings();
  projectNameInput.onfocus = () => {
    projectNameInput.select();
    requestAnimationFrame(() => { projectNameInput.scrollLeft = projectNameInput.scrollWidth; });
  };
  projectNameInput.oninput = syncProjectTitleLayout;
  projectNameInput.onblur = () => callbacks.onRenameProject(projectNameInput.value);
  projectNameInput.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); projectNameInput.blur(); }
    if (event.key === 'Escape') { projectNameInput.value = projectNameInput.dataset.lastCommitted ?? ''; projectNameInput.blur(); }
  };
  const projectTitleResizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(syncProjectTitleLayout);
  projectTitleResizeObserver?.observe(projectTitleRowEl);

  function syncCardDensity(density) {
    progressionListEl.dataset.cardDensity = density;
  }

  function makeChordRow(progression, chord, index, barRange) {
    const timeSig = progression.settings.timeSig;
    const beatChoices = beatChoicesForMeter(timeSig);
    const row = document.createElement('article');
    const isRestRow = isRest(chord);
    row.className = `chord-row${ isRestRow ? ' chord-row--rest' : '' }`;
    row.dataset.chordId = chord.id;
    const identity = chordSpellingIdentity(chord);
    const notes = isRestRow ? 'silence' : chord.notes.map((note) => identity
      ? chordToneName(note, identity, progression.settings.key)
      : noteName(note, progression.settings.key)).join(' · ');
    const currentBeats = Number(barsToBeats(chord.bars, timeSig).toFixed(4));
    const options = beatChoices.includes(currentBeats) ? beatChoices : [...beatChoices, currentBeats].sort((a, b) => a - b);
    const displayName = escapeHtml(chordDisplayName(chord, progression.settings.key));
    const glyphHtml = isRestRow ? 'Rest' : renderChordGlyph(formatChordSymbol(chord, progression.settings.key));
    // A rest has no notes to edit, so its main area is inert (no piano modal).
    const mainHtml = isRestRow
      ? `<div class="chord-main chord-main--rest"><strong class="chord-glyph">${ glyphHtml }</strong><small>${ escapeHtml(notes) }</small></div>`
      : `<button class="chord-main" aria-label="Edit ${ displayName }"><strong class="chord-glyph">${ glyphHtml }</strong><small>${ escapeHtml(notes) }</small></button>`;
    const barLabel = barRange.start === barRange.end ? `Bar ${ barRange.start }` : `Bars ${ barRange.start }–${ barRange.end }`;
    row.innerHTML = `<span class="chord-bar-number" aria-hidden="true">${ barRange.start }</span><button class="chord-drag-handle" type="button" aria-label="Reorder ${ displayName }" tabindex="-1">${ icon('grip') }</button>${ mainHtml }<label class="chord-beats" aria-label="Beats for ${ displayName }"><span class="chord-beats-display" aria-hidden="true">${ formatBeatDisplay(currentBeats) } <em>${ currentBeats === 1 ? 'beat' : 'beats' }</em></span><select class="chord-beats-select">${ options.map((beats) => `<option value="${ beats }" ${ beats === currentBeats ? 'selected' : '' }>${ formatBeatDisplay(beats) }</option>`).join('') }</select></label><button class="delete-button" aria-label="Delete ${ displayName }">${ icon('trash') }</button>`;
    row.title = barLabel;
    if (!isRestRow) row.querySelector('.chord-main').onclick = () => callbacks.onEditChord(chord);
    row.querySelector('.chord-beats-select').onchange = (event) => callbacks.onSetChordBeats(chord, Number(event.target.value));
    row.querySelector('.delete-button').onclick = () => deleteChordWithAnimation(row, chord);
    return row;
  }

  /**
   * Let a departing chord finish its visual exit before the state update
   * replaces the progression DOM. This keeps the card from disappearing
   * abruptly while preserving the existing single rerender state flow.
   */
  function deleteChordWithAnimation(row, chord) {
    if (row.dataset.deleting === 'true') return;

    if (prefersReducedMotion()) {
      callbacks.onDeleteChord(chord);
      return;
    }

    row.dataset.deleting = 'true';
    row.querySelectorAll('button, select').forEach((control) => { control.disabled = true; });
    const adjacentSeams = [row.previousElementSibling, row.nextElementSibling]
      .filter((element) => element?.classList.contains('transition-seam'));
    adjacentSeams.forEach((seam) => {
      seam.classList.add('transition-seam--deleting');
      seam.querySelectorAll('button, select').forEach((control) => { control.disabled = true; });
    });
    const chordRows = [...progressionListEl.querySelectorAll('.chord-row')];
    const chordIndex = chordRows.indexOf(row);
    const previousChordId = chordRows[chordIndex - 1]?.dataset.chordId;
    const nextChordId = chordRows[chordIndex + 1]?.dataset.chordId;
    if (row.contains(document.activeElement)) document.activeElement.blur();

    runExitAnimation(row, 'chord-row--deleting', () => {
      callbacks.onDeleteChord(chord);
      if (previousChordId && nextChordId) animateAddedTransition(previousChordId, nextChordId);
    });
  }

  function animateAddedChord(chordId) {
    const row = [...progressionListEl.querySelectorAll('.chord-row')]
      .find((item) => item.dataset.chordId === chordId);
    if (!row) return;
    runEntryAnimation(row, 'chord-row--entering');
    animateTransitionEntry(row.previousElementSibling);
  }

  function animateAddedTransition(fromChordId, toChordId) {
    const seam = [...progressionListEl.querySelectorAll('.transition-seam')].find((item) => (
      item.dataset.fromChordId === fromChordId && item.dataset.toChordId === toChordId
    ));
    animateTransitionEntry(seam);
  }

  function animateTransitionEntry(seam) {
    runEntryAnimation(seam, 'transition-seam--entering');
  }

  function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  function runEntryAnimation(element, className) {
    if (!element || prefersReducedMotion()) return;
    requestAnimationFrame(() => {
      element.classList.add(className);
      element.addEventListener('animationend', (event) => {
        if (event.target === element && event.animationName === UI_MOTION_NAME) {
          element.classList.remove(className);
        }
      }, { once: true });
    });
  }

  function runExitAnimation(element, className, onComplete) {
    if (!element || prefersReducedMotion()) {
      onComplete();
      return;
    }

    const start = () => {
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        window.clearTimeout(fallback);
        onComplete();
      };
      const fallback = window.setTimeout(finish, UI_MOTION_MS + 50);
      element.addEventListener('animationend', (event) => {
        if (event.target === element && event.animationName === UI_MOTION_NAME) finish();
      });
      element.classList.add(className);
    };

    // Keyframe animations restart from their own defined endpoint rather
    // than retargeting from wherever they currently are — layering the exit
    // animation on top of a still-playing entrance would make the element
    // visibly snap to the entrance's finished state for a frame before
    // reversing. Letting the entrance finish on its own terms first (with
    // the same fallback-timeout safety net used above, in case its own
    // animationend never fires) avoids that snap entirely.
    const isEntering = element.classList.contains('chord-row--entering')
      || element.classList.contains('transition-seam--entering');
    if (!isEntering) { start(); return; }
    let proceeded = false;
    const proceedOnce = () => {
      if (proceeded) return;
      proceeded = true;
      window.clearTimeout(enterFallback);
      start();
    };
    const enterFallback = window.setTimeout(proceedOnce, UI_MOTION_MS + 50);
    element.addEventListener('animationend', (event) => {
      if (event.target === element && event.animationName === UI_MOTION_NAME) proceedOnce();
    });
  }

  function renderChordGlyph({ root, baseline, marker, suffix, superscript, plain }) {
    if (!root) return escapeHtml(plain);
    const rootHtml = escapeHtml(root);
    const baselineHtml = baseline ? escapeHtml(baseline) : '';
    const markerHtml = marker ? `<sup class="chord-quality-marker">${ escapeHtml(marker) }</sup>` : '';
    const suffixHtml = suffix ? `<sup class="chord-quality-suffix">${ escapeHtml(suffix) }</sup>` : '';
    const supHtml = superscript ? `<sup>${ escapeHtml(superscript) }</sup>` : '';
    return `${ rootHtml }${ baselineHtml }${ markerHtml }${ suffixHtml }${ supHtml }`;
  }

  function formatBeatDisplay(beats) {
    if (beats === 0.5) return '½';
    if (beats === 1.5) return '1½';
    return String(beats);
  }

  function formatBeatCost(beats) {
    return `${ beats } beat${ beats > 1 ? 's' : '' }`;
  }

  function addTechniqueOptions(select, techniques, departingChord, timeSig, budget) {
    select.add(new Option('Direct transition (None)', ''));
    techniques.forEach((technique) => {
      const affordable = isTechniqueUsable(technique, departingChord, timeSig);
      const option = new Option(`${ technique.name } · ${ formatBeatCost(technique.beatCost) }`, technique.id, false, false);
      option.disabled = !technique.valid || !affordable;
      option.title = !technique.valid ? technique.reason : (!affordable ? `Requires ${ formatBeatCost(technique.beatCost) }; only ${ budget } available.` : '');
      select.add(option);
    });
  }

  function makeTransitionSeam(progression, index, selectedSeam) {
    const selectedTechniqueId = progression.seams[index];
    const fromChord = progression.chords[index];
    const toChord = progression.chords[index + 1];
    // Rests can't carry a transition technique: render a quiet divider
    // instead of the interactive seam controls.
    if (isRest(fromChord) || isRest(toChord)) {
      const seam = document.createElement('article');
      seam.className = 'transition-seam is-direct transition-seam--rest';
      seam.dataset.fromChordId = fromChord.id;
      seam.dataset.toChordId = toChord.id;
      seam.innerHTML = '<div class="transition-connector"><span class="transition-rule" aria-hidden="true"></span></div>';
      return seam;
    }
    const budget = availableBeats(chordTotalBeats(fromChord, progression.settings.timeSig));
    const techniques = evaluateAllTechniques(fromChord, toChord);
    const selectedTechnique = techniques.find((technique) => technique.id === selectedTechniqueId);
    const fromName = escapeHtml(chordDisplayName(fromChord, progression.settings.key));
    const toName = escapeHtml(chordDisplayName(toChord, progression.settings.key));
    const isOpen = expandedSeamIndexes.has(index);
    const seam = document.createElement('article');
    seam.className = `transition-seam ${ selectedTechnique ? 'has-technique' : 'is-direct' } ${ selectedSeam === index ? 'selected' : '' } ${ isOpen ? 'is-open' : '' }`;
    seam.dataset.fromChordId = fromChord.id;
    seam.dataset.toChordId = toChord.id;
    const toggleLabel = selectedTechnique
      ? `${ escapeHtml(selectedTechnique.name) } · ${ formatBeatCost(selectedTechnique.beatCost) }`
      : `${ icon('plus', 'transition-label-icon') } Add transition`;
    seam.innerHTML = `<div class="transition-connector"><button class="transition-toggle" type="button" aria-expanded="${ isOpen }"><span class="transition-rule" aria-hidden="true"></span><span class="transition-label">${ toggleLabel }</span><span class="transition-rule" aria-hidden="true"></span></button></div>${ isOpen ? `<div class="transition-editor"><div class="transition-editor-copy"><small>${ budget } beat${ budget === 1 ? '' : 's' } available in the departing tail</small></div><label>Technique <select class="transition-select" aria-label="Technique for ${ fromName } to ${ toName }"></select></label></div>` : '' }`;
    const toggle = seam.querySelector('.transition-toggle');
    toggle.onclick = () => {
      if (isOpen) {
        expandedSeamIndexes.delete(index);
      } else {
        expandedSeamIndexes.add(index);
        // A direct seam survives the selection render that opened it, then
        // closes on the next state update unless a technique is chosen.
        directEditorOpenForCurrentRender = selectedTechnique ? null : index;
      }
      callbacks.onSelectSeam(index);
    };
    const select = seam.querySelector('.transition-select');
    if (select) {
      addTechniqueOptions(select, techniques, fromChord, progression.settings.timeSig, budget);
      select.value = selectedTechniqueId ?? '';
      select.onchange = () => {
        const techniqueId = select.value || null;
        if (techniqueId) expandedSeamIndexes.add(index);
        else expandedSeamIndexes.delete(index);
        directEditorOpenForCurrentRender = null;
        callbacks.onSetSeamTechnique(index, techniqueId);
      };
    }
    return seam;
  }

  function renderProgression(progression, selectedSeam) {
    // Rebuilding the list wholesale (replaceChildren + fresh rows below) can
    // knock scrollTop back to 0 the instant a focused row/toggle is
    // destroyed — reproducible by clicking "+ Add transition" partway down a
    // long list. Not worth chasing the exact browser focus-loss quirk;
    // saving and restoring the scroll position across the rebuild sidesteps
    // it entirely, whatever the cause.
    const previousScrollTop = progressionListEl.scrollTop;
    progressionListEl.replaceChildren();
    const isEmpty = !progression.chords.length;
    bodyContainer.classList.toggle('chords-panel-scroll--empty', isEmpty);
    chordsSectionEl.classList.toggle('editor-section--empty', isEmpty);
    currentBarRanges = computeBarRanges(progression.chords);
    if (isEmpty) {
      progressionListEl.append(makeEmptyState());
      callbacks.onVisibleBarsChange?.(null);
      return;
    }
    expandedSeamIndexes.forEach((index) => {
      const isDirect = !progression.seams[index];
      const isOutOfRange = index >= progression.seams.length;
      if (isOutOfRange || (isDirect && directEditorOpenForCurrentRender !== index)) {
        expandedSeamIndexes.delete(index);
      }
    });
    directEditorOpenForCurrentRender = null;
    progression.chords.forEach((chord, index) => {
      progressionListEl.append(makeChordRow(progression, chord, index, currentBarRanges[index]));
      if (index < progression.seams.length) progressionListEl.append(makeTransitionSeam(progression, index, selectedSeam));
    });
    progressionListEl.scrollTop = previousScrollTop;
    reportVisibleBars();
  }

  function renderMetaPills(settings) {
    metaPillsEl.replaceChildren();
    const pills = [
      { label: timeSigLabel(settings.timeSig), variant: 'filled' },
      { label: majorKeyName(settings.key), variant: 'outline' },
    ];
    for (const pill of pills) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `meta-pill meta-pill--${ pill.variant }`;
      el.textContent = pill.label;
      el.setAttribute('aria-label', `Edit project settings: ${ pill.label }`);
      el.onclick = () => callbacks.onEditProjectSettings();
      metaPillsEl.append(el);
    }
  }

  function makeEmptyState() {
    // See css/editor-pane.css `.empty-state` for the treatment.
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.innerHTML = `
      <div class="empty-state-copy">
        <h3 class="empty-state-headline">Nothing here yet.</h3>
        <p class="empty-state-subcopy">Add a chord to begin!</p>
      </div>
    `;
    return el;
  }

  function syncProjectName(name) {
    // Don't overwrite while the user is actively editing.
    if (document.activeElement === projectNameInput) return;
    projectNameInput.value = name ?? '';
    projectNameInput.dataset.lastCommitted = projectNameInput.value;
    requestAnimationFrame(syncProjectTitleLayout);
  }

  function syncProjectTitleLayout() {
    // Measure with the full label visible, then compact only if the title,
    // meta pills, save status, action button, and the gaps between all four
    // cannot share the row.
    projectTitleRowEl.classList.remove('is-compact');
    const styles = getComputedStyle(projectNameInput);
    const measureContext = document.createElement('canvas').getContext('2d');
    measureContext.font = styles.font;
    const titleWidth = measureContext.measureText(projectNameInput.value).width;
    const gap = Number.parseFloat(getComputedStyle(projectTitleRowEl).gap) || 0;
    const pillsWidth = metaPillsEl.getBoundingClientRect().width;
    const saveStatusWidth = saveStatusEl.getBoundingClientRect().width;
    const buttonWidth = editSettingsBtn.getBoundingClientRect().width;
    const neededWidth = Math.ceil(titleWidth) + pillsWidth + saveStatusWidth + Math.ceil(buttonWidth) + gap * 3;
    projectTitleRowEl.classList.toggle('is-compact', neededWidth > projectTitleRowEl.clientWidth);
    syncProjectNameOverflow();
  }

  function syncProjectNameOverflow() {
    projectNameFieldEl.classList.toggle(
      'is-truncated',
      projectNameInput.scrollWidth > projectNameInput.clientWidth,
    );
  }

  // Deleting a chord is instant and irreversible from the UI's point of view
  // — no confirmation dialog (that would add friction to routine edits), but
  // a brief undo window catches the accidental click without asking the user
  // to confirm every intentional one. Single-slot: a second delete while this
  // is showing replaces the pending undo rather than queuing a history.
  const DELETE_UNDO_MS = 5000;
  let deleteUndoTimer = 0;
  let pendingUndo = null;

  function offerDeleteUndo(message, onUndo) {
    window.clearTimeout(deleteUndoTimer);
    pendingUndo = onUndo;
    deleteToastMessageEl.textContent = message;
    deleteToastEl.classList.remove('is-visible');
    // Force a reflow so replacing an already-visible toast (rapid deletes)
    // restarts its entrance instead of the repeated class-add being a no-op.
    void deleteToastEl.offsetWidth;
    deleteToastEl.classList.add('is-visible');
    deleteUndoTimer = window.setTimeout(hideDeleteToast, DELETE_UNDO_MS);
  }

  function hideDeleteToast() {
    window.clearTimeout(deleteUndoTimer);
    deleteToastEl.classList.remove('is-visible');
    pendingUndo = null;
  }

  deleteToastUndoBtn.onclick = () => {
    const restore = pendingUndo;
    hideDeleteToast();
    restore?.();
  };

  // Autosave itself is silent (debounced, no dedicated save button) — this
  // is the only signal the user gets that an edit actually persisted.
  // Status/completion feedback for an otherwise-invisible background action.
  // Kept even under reduced motion (as an instant show/hide, via CSS) since
  // it's informational rather than decorative.
  let saveStatusTimer = 0;
  function flashSaved() {
    window.clearTimeout(saveStatusTimer);
    saveStatusEl.classList.remove('is-visible');
    // Force a reflow so re-triggering while still visible (rapid edits)
    // restarts the fade instead of the repeated class-add being a no-op.
    void saveStatusEl.offsetWidth;
    saveStatusEl.classList.add('is-visible');
    saveStatusTimer = window.setTimeout(() => {
      saveStatusEl.classList.remove('is-visible');
    }, 1600);
  }

  return {
    render({ progression, selectedSeam, projectName }) {
      syncCardDensity(progression.settings.cardDensity);
      syncProjectName(projectName);
      renderMetaPills(progression.settings);
      renderProgression(progression, selectedSeam);
    },
    animateAddedChord,
    flashSaved,
    offerDeleteUndo,
    unmount() {
      sortable?.destroy();
      projectTitleResizeObserver?.disconnect();
      window.clearTimeout(saveStatusTimer);
      window.clearTimeout(deleteUndoTimer);
      cancelAnimationFrame(visibleBarsFrame);
    },
  };
}
