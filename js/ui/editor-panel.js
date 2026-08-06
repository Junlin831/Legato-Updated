/**
 * Left composition workspace: project title (with an Edit Project Settings
 * button beside it) and one ordered progression list. Each transition is
 * rendered at the seam between its two adjacent chord rows.
 *
 * State lives in editor-view.js; this module renders from it and hands user
 * events back through `callbacks`. Score settings (tempo, time signature,
 * key, clef) are now edited through the shared project-settings-modal opened
 * by the pencil button — they no longer have inline controls here.
 */
import { availableBeats, beatChoicesForMeter, chordTotalBeats, barsToBeats, beatsToBars, isTechniqueUsable, isRest } from '../state.js';
import { chordDisplayName, formatChordSymbol, noteName, chordToneName, chordSpellingIdentity } from '../engine/chords.js';
import { evaluateAllTechniques } from '../engine/technique-eligibility.js';
import { escapeHtml } from '../util/html.js';
import { majorKeyName, timeSigLabel, tempoLabel } from '../util/labels.js';
import { icon } from './icons.js';

const CARD_DENSITIES = ['loose', 'compact', 'dense'];
const UI_MOTION_MS = 340;
const UI_MOTION_NAME = 'surface-enter';

const TEMPLATE = `
<header class="brand-block">
  <button id="brand-home" class="brand-home" type="button" aria-label="View all projects">
    <img class="brand-mark" src="/assets/brand/legato-icon.png" alt="" draggable="false">
    <span class="brand">LEGATO</span>
  </button>
  <button id="view-all-projects" class="text-action view-all-projects" type="button">${ icon('home') }<span>All projects</span></button>
</header>

<div class="editor-scroll">
  <section class="project-title-block">
    <div class="project-title-row">
      <div id="project-name-field" class="project-name-field">
        <input id="project-name-input" class="project-name-input" type="text" spellcheck="false" autocomplete="off" aria-label="Project name" />
      </div>
      <button id="edit-project-settings" class="edit-project-settings" type="button" aria-label="Edit project settings">
        ${ icon('edit') }<span>Edit Project Settings</span>
      </button>
    </div>
    <div id="project-meta-pills" class="project-meta-pills"></div>
  </section>

  <section class="editor-section" aria-labelledby="chords-title">
    <div class="section-title">
      <div class="section-heading-group">
        <h2 id="chords-title" class="section-heading">Chords</h2>
        <button id="cycle-card-density" class="density-control" type="button">${ icon('density') }</button>
      </div>
      <div class="section-actions">
        <button id="add-rest" class="ghost-action" type="button">${ icon('rest') }<span>Add Rest</span></button>
        <button id="add-chord" class="primary-action" type="button">${ icon('plus') }<span>Add Chord</span></button>
      </div>
    </div>
    <div id="progression-list" class="progression-list"></div>
  </section>
</div>
`;

export function mountEditorPanel({ container, callbacks }) {
  container.classList.add('editor-pane');
  container.innerHTML = TEMPLATE;

  const editorScrollEl = container.querySelector('.editor-scroll');
  const progressionListEl = container.querySelector('#progression-list');
  const chordsSectionEl = progressionListEl.closest('.editor-section');
  const addChordBtn = container.querySelector('#add-chord');
  const addRestBtn = container.querySelector('#add-rest');
  const densityControlBtn = container.querySelector('#cycle-card-density');

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
  const brandHomeBtn = container.querySelector('#brand-home');
  const viewAllBtn = container.querySelector('#view-all-projects');
  const projectTitleRowEl = container.querySelector('.project-title-row');
  const projectNameFieldEl = container.querySelector('#project-name-field');
  const projectNameInput = container.querySelector('#project-name-input');
  const editSettingsBtn = container.querySelector('#edit-project-settings');
  const metaPillsEl = container.querySelector('#project-meta-pills');
  const expandedSeamIndexes = new Set();
  let directEditorOpenForCurrentRender = null;
  let cardDensity = 'loose';

  addChordBtn.onclick = () => callbacks.onAddChord();
  addRestBtn.onclick = () => callbacks.onAddRest();
  densityControlBtn.onclick = () => {
    const currentIndex = CARD_DENSITIES.indexOf(cardDensity);
    cardDensity = CARD_DENSITIES[(currentIndex + 1) % CARD_DENSITIES.length];
    syncCardDensity();
  };
  brandHomeBtn.onclick = () => callbacks.onGoHome();
  viewAllBtn.onclick = () => callbacks.onGoHome();
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

  function syncCardDensity() {
    const nextDensity = CARD_DENSITIES[(CARD_DENSITIES.indexOf(cardDensity) + 1) % CARD_DENSITIES.length];
    const currentLabel = cardDensity[0].toUpperCase() + cardDensity.slice(1);
    const nextLabel = nextDensity[0].toUpperCase() + nextDensity.slice(1);
    progressionListEl.dataset.cardDensity = cardDensity;
    densityControlBtn.dataset.cardDensity = cardDensity;
    densityControlBtn.setAttribute('aria-label', `Chord card density: ${ currentLabel }. Switch to ${ nextLabel }.`);
    densityControlBtn.title = `Card density: ${ currentLabel }. Switch to ${ nextLabel }.`;
  }

  function makeChordRow(progression, chord, index) {
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
    row.innerHTML = `<button class="chord-drag-handle" type="button" aria-label="Reorder ${ displayName }" tabindex="-1">${ icon('grip') }</button>${ mainHtml }<label class="chord-beats" aria-label="Beats for ${ displayName }"><span class="chord-beats-display" aria-hidden="true">${ formatBeatDisplay(currentBeats) } <em>${ currentBeats === 1 ? 'beat' : 'beats' }</em></span><select class="chord-beats-select">${ options.map((beats) => `<option value="${ beats }" ${ beats === currentBeats ? 'selected' : '' }>${ formatBeatDisplay(beats) }</option>`).join('') }</select></label><button class="delete-button" aria-label="Delete ${ displayName }">${ icon('trash') }</button>`;
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
    progressionListEl.replaceChildren();
    const isEmpty = !progression.chords.length;
    editorScrollEl.classList.toggle('editor-scroll--empty', isEmpty);
    chordsSectionEl.classList.toggle('editor-section--empty', isEmpty);
    if (isEmpty) {
      progressionListEl.append(makeEmptyState());
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
      progressionListEl.append(makeChordRow(progression, chord, index));
      if (index < progression.seams.length) progressionListEl.append(makeTransitionSeam(progression, index, selectedSeam));
    });
  }

  function renderMetaPills(settings) {
    metaPillsEl.replaceChildren();
    const pills = [
      { label: timeSigLabel(settings.timeSig), variant: 'filled' },
      { label: majorKeyName(settings.key), variant: 'outline' },
      { label: tempoLabel(settings.tempo), variant: 'outline' },
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
    // Measure with the full label visible, then compact only if the whole
    // project title, gap, and action cannot share the row.
    projectTitleRowEl.classList.remove('is-compact');
    const styles = getComputedStyle(projectNameInput);
    const measureContext = document.createElement('canvas').getContext('2d');
    measureContext.font = styles.font;
    const titleWidth = measureContext.measureText(projectNameInput.value).width;
    const gap = Number.parseFloat(getComputedStyle(projectTitleRowEl).gap) || 0;
    const neededWidth = Math.ceil(titleWidth) + Math.ceil(editSettingsBtn.getBoundingClientRect().width) + gap;
    projectTitleRowEl.classList.toggle('is-compact', neededWidth > projectTitleRowEl.clientWidth);
    syncProjectNameOverflow();
  }

  function syncProjectNameOverflow() {
    projectNameFieldEl.classList.toggle(
      'is-truncated',
      projectNameInput.scrollWidth > projectNameInput.clientWidth,
    );
  }

  return {
    render({ progression, selectedSeam, projectName }) {
      syncCardDensity();
      syncProjectName(projectName);
      renderMetaPills(progression.settings);
      renderProgression(progression, selectedSeam);
    },
    animateAddedChord,
    unmount() {
      sortable?.destroy();
      projectTitleResizeObserver?.disconnect();
    },
  };
}
