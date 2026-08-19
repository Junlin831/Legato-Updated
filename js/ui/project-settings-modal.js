/**
 * The "Project settings" modal — shared by the create-project flow on the
 * landing page and the edit flow on the editor page.
 *
 * Two entry points:
 *   - `mountProjectSettingsModal({ container })` injects the dialog template
 *     into a mount div and returns the <dialog> element.
 *   - `openProjectSettingsModal(dialog, { mode, initial, onSubmit })` opens
 *     the dialog with either "Create new project" or "Edit project settings"
 *     chrome. On submit, calls `onSubmit({ name, settings })` with freshly-
 *     built values; the caller decides whether to createProject or to mutate
 *     an existing progression's settings.
 *
 * The modal is presentation-only: it never touches the store, the router, or
 * progression.chords/seams. The full -7..+7 range of circle-of-fifths key
 * signatures is offered via a 12-wedge dial with overlapping spellings shown
 * on the relevant circle positions; the engine already supports the full range.
 */
import { installBackdropDismissal } from './dialog.js';
import { icon } from './icons.js';
import { TEMPO_MIN, TEMPO_MAX, TEMPO_DEFAULT, isCompoundMeter, CARD_DENSITIES, DEFAULT_CARD_DENSITY } from '../state.js';

const DENSITY_LABELS = { loose: 'Loose', compact: 'Compact', dense: 'Dense' };

// 12 clock positions around the dial, going clockwise from 12 o'clock. Each
// wedge stores its canonical circle-of-fifths integer. The three overlapping
// spellings live directly on their circle positions instead of in a separate
// control row beneath the dial.
const WEDGES = [
  { key: 0, major: 'C', minor: 'Am' },
  { key: 1, major: 'G', minor: 'Em' },
  { key: 2, major: 'D', minor: 'Bm' },
  { key: 3, major: 'A', minor: 'F♯m' },
  { key: 4, major: 'E', minor: 'C♯m' },
  { key: 5, major: 'C♭ / B', minor: 'G♯m', ariaLabel: 'C-flat or B major; A-flat minor or G-sharp minor' },
  { key: 6, major: 'G♭ / F♯', minor: 'D♯m', ariaLabel: 'G-flat or F-sharp major; E-flat minor or D-sharp minor' },
  { key: -5, major: 'C♯ / D♭', minor: 'B♭m', ariaLabel: 'C-sharp or D-flat major; A-sharp minor or B-flat minor' },
  { key: -4, major: 'A♭', minor: 'Fm' },
  { key: -3, major: 'E♭', minor: 'Cm' },
  { key: -2, major: 'B♭', minor: 'Gm' },
  { key: -1, major: 'F', minor: 'Dm' },
];

// Maps a raw key value to the wedge index that should visually light up.
// Enharmonic spellings fall onto their sibling wedge.
const ENHARMONIC_TO_WEDGE = { [-7]: 5, [-6]: 6, [7]: 7 };

const KEY_LABELS = {
  '-7': 'C♭ major / A♭ minor · 7 flats',
  '-6': 'G♭ major / E♭ minor · 6 flats',
  '-5': 'D♭ major / B♭ minor · 5 flats',
  '-4': 'A♭ major / F minor · 4 flats',
  '-3': 'E♭ major / C minor · 3 flats',
  '-2': 'B♭ major / G minor · 2 flats',
  '-1': 'F major / D minor · 1 flat',
  '0': 'C major / A minor · no accidentals',
  '1': 'G major / E minor · 1 sharp',
  '2': 'D major / B minor · 2 sharps',
  '3': 'A major / F♯ minor · 3 sharps',
  '4': 'E major / C♯ minor · 4 sharps',
  '5': 'B major / G♯ minor · 5 sharps',
  '6': 'F♯ major / D♯ minor · 6 sharps',
  '7': 'C♯ major / A♯ minor · 7 sharps',
};

const METER_OPTIONS = {
  simple: ['3/4', '4/4', '5/4', '7/4'],
  compound: ['6/8', '9/8', '12/8'],
};

const TEMPO_INPUT_ATTRS = `min="${ TEMPO_MIN }" max="${ TEMPO_MAX }" step="1" inputmode="numeric"`;

const DIAL_SIZE = 260;
const DIAL_CENTER = DIAL_SIZE / 2;
const DIAL_OUTER_RADIUS = 122;
const DIAL_MINOR_RADIUS = 78;
const DIAL_INNER_RADIUS = 44;

const DIALOG_TEMPLATE = `
<dialog id="project-settings-dialog">
  <form method="dialog" class="dialog-shell project-settings-shell" onsubmit="return false">
    <header class="dialog-header">
      <h2 id="project-settings-title">Create New Project</h2>
      <button id="project-settings-cancel" class="close-button" type="button" aria-label="Close project settings">${ icon('close') }</button>
    </header>
    <div class="project-settings-body">
      <div class="project-settings-controls">
        <label class="project-settings-name">
          <span>Project name</span>
          <input id="project-settings-name-input" type="text" spellcheck="false" autocomplete="off" maxlength="120" />
        </label>
        <div class="settings-grid">
          <label id="project-settings-meter-type-field"><span>Meter type</span>
            <select id="project-settings-meter-type" class="form-select">
              <option value="simple">Simple</option>
              <option value="compound">Compound</option>
            </select>
          </label>
          <label id="project-settings-meter-field"><span>Time signature</span>
            <select id="project-settings-meter" class="form-select"></select>
          </label>
          <label id="project-settings-tempo-field"><span>Tempo</span>
            <div class="tempo-control">
              <input id="project-settings-tempo-slider" type="range" ${ TEMPO_INPUT_ATTRS } />
              <input id="project-settings-tempo" type="number" ${ TEMPO_INPUT_ATTRS } />
              <small>BPM</small>
            </div>
          </label>
          <label id="project-settings-clef-field"><span>Clef</span>
            <select id="project-settings-clef" class="form-select">
              <option value="auto">Auto</option>
              <option value="treble">Treble</option>
              <option value="bass">Bass</option>
            </select>
          </label>
        </div>
      </div>
      <fieldset class="key-signature-fieldset">
        <legend>Key signature</legend>
        <div class="key-dial-container">
          <div id="project-settings-key-dial" class="key-dial" role="radiogroup" aria-label="Key signature"></div>
          <div class="key-dial-readout">
            <p class="kicker">Selected</p>
            <strong id="project-settings-key-label">C major / A minor</strong>
            <small id="project-settings-key-sub">No accidentals</small>
          </div>
        </div>
      </fieldset>
    </div>
    <fieldset class="chord-density-fieldset">
      <legend>Chord card style</legend>
      <div id="project-settings-density-picker" class="density-picker" role="radiogroup" aria-label="Chord card density">
        ${ CARD_DENSITIES.map((density) => `<button type="button" class="density-option" data-density="${ density }" role="radio" aria-checked="false">${ DENSITY_LABELS[density] }</button>`).join('') }
      </div>
      <div class="chord-density-preview" aria-hidden="true">
        <div id="project-settings-density-preview" class="progression-list">
          <article class="chord-row">
            <span class="chord-drag-handle">${ icon('grip') }</span>
            <span class="chord-main"><strong class="chord-glyph">Cmaj7</strong><small>C · E · G · B</small></span>
            <span class="chord-beats"><span class="chord-beats-display">1 <em>beat</em></span></span>
            <span class="delete-button">${ icon('trash') }</span>
          </article>
        </div>
      </div>
    </fieldset>
    <footer class="dialog-footer">
      <button id="project-settings-submit" class="save-button" type="button">Create ${ icon('arrowRight') }</button>
    </footer>
  </form>
</dialog>
`;

/** Inject the dialog HTML into `container` and return the <dialog> element. */
export function mountProjectSettingsModal({ container }) {
  container.innerHTML = DIALOG_TEMPLATE;
  const dialog = container.querySelector('#project-settings-dialog');
  populateStaticOptions(dialog);
  renderKeyDial(dialog);
  return dialog;
}

function populateStaticOptions(dialog) {
  syncMeterOptions(dialog.querySelector('#project-settings-meter'), 'simple', '4/4');
}

function syncMeterOptions(select, meterType, selected) {
  select.replaceChildren();
  METER_OPTIONS[meterType].forEach((label) => select.add(new Option(label, label, false, label === selected)));
}

function polar(angleRad, radius) {
  return {
    x: DIAL_CENTER + radius * Math.sin(angleRad),
    y: DIAL_CENTER - radius * Math.cos(angleRad),
  };
}

function renderKeyDial(dialog) {
  const container = dialog.querySelector('#project-settings-key-dial');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${ DIAL_SIZE } ${ DIAL_SIZE }`);
  svg.setAttribute('class', 'key-dial-svg');
  svg.setAttribute('role', 'presentation');

  const wedgeGap = (Math.PI * 2) / WEDGES.length;
  WEDGES.forEach((wedge, index) => {
    const midAngle = index * wedgeGap;
    const startAngle = midAngle - wedgeGap / 2;
    const endAngle = midAngle + wedgeGap / 2;
    const p1 = polar(startAngle, DIAL_OUTER_RADIUS);
    const p2 = polar(endAngle, DIAL_OUTER_RADIUS);
    const p3 = polar(endAngle, DIAL_INNER_RADIUS);
    const p4 = polar(startAngle, DIAL_INNER_RADIUS);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', [
      `M ${ p1.x } ${ p1.y }`,
      `A ${ DIAL_OUTER_RADIUS } ${ DIAL_OUTER_RADIUS } 0 0 1 ${ p2.x } ${ p2.y }`,
      `L ${ p3.x } ${ p3.y }`,
      `A ${ DIAL_INNER_RADIUS } ${ DIAL_INNER_RADIUS } 0 0 0 ${ p4.x } ${ p4.y }`,
      'Z',
    ].join(' '));
    path.setAttribute('class', 'key-wedge');
    path.setAttribute('data-key', String(wedge.key));
    path.setAttribute('data-wedge-index', String(index));
    path.setAttribute('role', 'radio');
    path.setAttribute('tabindex', '0');
    path.setAttribute('aria-label', wedge.ariaLabel ?? `${ wedge.major } major or ${ wedge.minor }`);
    svg.appendChild(path);

    // Divider between major and minor rings.
    const rDivider = (DIAL_MINOR_RADIUS + (DIAL_MINOR_RADIUS - 6));
    const divPStart = polar(startAngle, DIAL_MINOR_RADIUS);
    const divPEnd = polar(endAngle, DIAL_MINOR_RADIUS);
    void rDivider; void divPStart; void divPEnd; // (kept for future; no divider drawn now)

    // Major label — outer ring.
    const majorLabelPos = polar(midAngle, (DIAL_OUTER_RADIUS + DIAL_MINOR_RADIUS) / 2);
    const majorText = document.createElementNS(svgNS, 'text');
    majorText.setAttribute('x', String(majorLabelPos.x));
    majorText.setAttribute('y', String(majorLabelPos.y));
    majorText.setAttribute('text-anchor', 'middle');
    majorText.setAttribute('dominant-baseline', 'central');
    majorText.setAttribute('class', wedge.major.includes('/') ? 'key-wedge-major key-wedge-major--long' : 'key-wedge-major');
    majorText.textContent = wedge.major;
    svg.appendChild(majorText);

    // Minor label — inner ring.
    const minorLabelPos = polar(midAngle, (DIAL_MINOR_RADIUS + DIAL_INNER_RADIUS) / 2);
    const minorText = document.createElementNS(svgNS, 'text');
    minorText.setAttribute('x', String(minorLabelPos.x));
    minorText.setAttribute('y', String(minorLabelPos.y));
    minorText.setAttribute('text-anchor', 'middle');
    minorText.setAttribute('dominant-baseline', 'central');
    minorText.setAttribute('class', 'key-wedge-minor');
    minorText.textContent = wedge.minor;
    svg.appendChild(minorText);
  });

  // Separator ring between major and minor labels.
  const ring = document.createElementNS(svgNS, 'circle');
  ring.setAttribute('cx', String(DIAL_CENTER));
  ring.setAttribute('cy', String(DIAL_CENTER));
  ring.setAttribute('r', String(DIAL_MINOR_RADIUS));
  ring.setAttribute('class', 'key-dial-ring');
  ring.setAttribute('fill', 'none');
  svg.appendChild(ring);

  container.replaceChildren(svg);
}

/**
 * Open the modal.
 *
 * @param {HTMLDialogElement} dialog
 * @param {{
 *   mode: 'create' | 'edit',
 *   initial: { name: string, settings: { tempo: number, timeSig: {num:number, den:number}, key: number, clef: 'auto'|'treble'|'bass', cardDensity?: 'loose'|'compact'|'dense' } },
 *   onSubmit: (result: { name: string, settings: { tempo: number, timeSig: {num:number, den:number}, key: number, clef: 'auto'|'treble'|'bass', cardDensity: 'loose'|'compact'|'dense' } }) => void,
 * }} options
 */
export function openProjectSettingsModal(dialog, { mode, initial, onSubmit }) {
  const title = dialog.querySelector('#project-settings-title');
  const nameInput = dialog.querySelector('#project-settings-name-input');
  const tempoInput = dialog.querySelector('#project-settings-tempo');
  const tempoSlider = dialog.querySelector('#project-settings-tempo-slider');
  const meterTypeSelect = dialog.querySelector('#project-settings-meter-type');
  const meterSelect = dialog.querySelector('#project-settings-meter');
  const clefSelect = dialog.querySelector('#project-settings-clef');
  const cancelBtn = dialog.querySelector('#project-settings-cancel');
  const submitBtn = dialog.querySelector('#project-settings-submit');
  const dial = dialog.querySelector('#project-settings-key-dial');
  const keyLabel = dialog.querySelector('#project-settings-key-label');
  const keySubLabel = dialog.querySelector('#project-settings-key-sub');
  const densityPicker = dialog.querySelector('#project-settings-density-picker');
  const densityPreview = dialog.querySelector('#project-settings-density-preview');

  const isCreate = mode === 'create';
  title.textContent = isCreate ? 'Create New Project' : 'Edit Project Settings';
  submitBtn.innerHTML = isCreate ? `Create ${ icon('arrowRight') }` : `Save ${ icon('arrowRight') }`;

  nameInput.value = initial.name ?? '';
  tempoInput.value = String(initial.settings.tempo);
  tempoSlider.value = String(initial.settings.tempo);
  // Two views on one value — mirror across slider/number so either input
  // reflects the user's latest edit without clamping until commit().
  tempoSlider.oninput = () => { tempoInput.value = tempoSlider.value; };
  tempoInput.oninput = () => {
    const parsed = Number(tempoInput.value);
    if (Number.isFinite(parsed)) tempoSlider.value = String(parsed);
  };
  const initialMeter = `${ initial.settings.timeSig.num }/${ initial.settings.timeSig.den }`;
  const initialMeterType = initial.settings.meterType ?? (isCompoundMeter(initial.settings.timeSig) ? 'compound' : 'simple');
  meterTypeSelect.value = initialMeterType;
  syncMeterOptions(meterSelect, initialMeterType, initialMeter);
  clefSelect.value = initial.settings.clef;

  meterTypeSelect.onchange = () => syncMeterOptions(meterSelect, meterTypeSelect.value, METER_OPTIONS[meterTypeSelect.value][0]);

  let currentKey = initial.settings.key;
  syncKeyUI();

  function syncKeyUI() {
    const canonical = ENHARMONIC_TO_WEDGE[currentKey] ?? null;
    const wedgeIndex = canonical != null
      ? canonical
      : WEDGES.findIndex((w) => w.key === currentKey);
    dial.querySelectorAll('.key-wedge').forEach((el) => {
      const idx = Number(el.dataset.wedgeIndex);
      const active = idx === wedgeIndex;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-checked', String(active));
    });
    const [main, sub] = (KEY_LABELS[String(currentKey)] ?? '').split(' · ');
    keyLabel.textContent = main ?? '';
    keySubLabel.textContent = sub ?? '';
  }

  dial.onclick = (event) => {
    const wedge = event.target.closest('.key-wedge');
    if (!wedge) return;
    currentKey = Number(wedge.dataset.key);
    syncKeyUI();
  };
  dial.onkeydown = (event) => {
    const wedge = event.target.closest('.key-wedge');
    if (!wedge) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      currentKey = Number(wedge.dataset.key);
      syncKeyUI();
    }
  };

  let currentDensity = CARD_DENSITIES.includes(initial.settings.cardDensity) ? initial.settings.cardDensity : DEFAULT_CARD_DENSITY;
  syncDensityUI();

  function syncDensityUI() {
    densityPicker.querySelectorAll('.density-option').forEach((el) => {
      const active = el.dataset.density === currentDensity;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-checked', String(active));
    });
    densityPreview.dataset.cardDensity = currentDensity;
  }

  densityPicker.onclick = (event) => {
    const option = event.target.closest('.density-option');
    if (!option) return;
    currentDensity = option.dataset.density;
    syncDensityUI();
  };

  const close = () => { dialog.close(); };
  cancelBtn.onclick = close;
  installBackdropDismissal(dialog, close);
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };

  function commit() {
    const cleanName = (nameInput.value || '').trim() || 'Untitled project';
    const [num, den] = meterSelect.value.split('/').map(Number);
    const parsedTempo = Number(tempoInput.value);
    const tempo = Number.isFinite(parsedTempo) ? Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(parsedTempo))) : TEMPO_DEFAULT;
    onSubmit({
      name: cleanName,
      settings: {
        tempo,
        timeSig: { num, den },
        meterType: meterTypeSelect.value,
        key: currentKey,
        clef: clefSelect.value,
        cardDensity: currentDensity,
      },
    });
    dialog.close();
  }

  submitBtn.onclick = commit;

  // Enter submits from anywhere in the form (except the number spinner, where
  // Enter is the browser's own "commit value" gesture we want to allow). Esc
  // still cancels via <dialog>'s default.
  dialog.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (target?.tagName === 'TEXTAREA') return;
    event.preventDefault();
    commit();
  };

  dialog.showModal();
  requestAnimationFrame(() => {
    nameInput.focus();
    if (isCreate) nameInput.select();
  });
}
