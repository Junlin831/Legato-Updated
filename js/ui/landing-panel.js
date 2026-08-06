/**
 * Landing / projects hub panel.
 *
 * The single page a user lands on when opening the app (unless the router's
 * time-guarded resume sends them straight back into the editor). Sections:
 *
 *   1. Actions row        — New project, Import…, Export all, Export selected.
 *   2. Recent projects    — user's active projects, sorted by updatedAt desc,
 *                            organized through folder filter chips. Cards can
 *                            be multi-selected (hover checkbox) and moved to
 *                            a folder by dragging onto a chip or through the
 *                            floating selection bar.
 *   3. Demo projects      — read from js/data/demo-projects.js; opening one
 *                            clones it into localStorage as a new project.
 *   4. Trash              — collapsible; Restore / Delete permanently.
 *
 * DOM lives here. The view module owns the filter/selection state and wires
 * callbacks up to the store.
 */
import { escapeHtml } from '../util/html.js';
import { icon } from './icons.js';
import { CHORD_FONTS, DEFAULT_CHORD_FONT } from '../state.js';

const TEMPLATE = `
<div class="landing-shell">
  <header class="landing-header">
    <div class="landing-brand">
      <img class="brand-mark" src="/assets/brand/legato-icon.png" alt="" draggable="false">
      <span class="brand">LEGATO</span>
    </div>
    <span class="landing-tagline"><a class="landing-github-link" href="https://github.com/Feegoat06/OpenAI_Build_Week_Project" target="_blank" rel="noopener noreferrer" aria-label="Open the LEGATO GitHub repository">${ icon('github') }</a><span>Created with ♥ and ♫ from Fee, Louie, and Eric</span></span>
  </header>

  <div class="landing-scroll">
    <div id="landing-notice" class="landing-notice" hidden></div>

    <section class="landing-section" aria-labelledby="landing-recent-title">
      <div class="landing-section-head">
        <h2 id="landing-recent-title" class="section-heading">Your Creations</h2>
        <span id="landing-recent-count" class="landing-count"></span>
        <div class="landing-section-utilities">
          <button id="landing-import" class="landing-secondary" type="button">Import…</button>
          <button id="landing-export-all" class="landing-secondary" type="button">Export all</button>
          <button id="landing-export-selected" class="landing-secondary" type="button" disabled>Export Selected</button>
          <input id="landing-import-file" type="file" accept="application/json,.json" hidden />
        </div>
        <div class="landing-section-actions">
          <button id="landing-new" class="primary-action" type="button">${ icon('plus') }<span>New Project</span></button>
        </div>
      </div>
      <div id="landing-folder-row" class="landing-folder-row" role="toolbar" aria-label="Project folders"></div>
      <div id="landing-recent-grid" class="landing-grid landing-grid-rail"></div>
    </section>

    <section class="landing-section" aria-labelledby="landing-demos-title">
      <div class="landing-section-head">
        <h2 id="landing-demos-title" class="section-heading">Demos</h2>
        <span class="landing-count">curated by the LEGATO team</span>
      </div>
      <div id="landing-demos-grid" class="landing-grid landing-grid-rail"></div>
    </section>

    <section class="landing-section landing-trash" aria-labelledby="landing-trash-title">
      <div class="landing-trash-header">
        <button id="landing-trash-toggle" class="landing-section-head landing-trash-toggle" type="button" aria-expanded="false" aria-controls="landing-trash-region">
          <h2 id="landing-trash-title" class="section-heading">Trash Bin</h2>
          <span id="landing-trash-count" class="landing-count">Empty</span>
          <span class="landing-trash-caret">${ icon('chevronDown') }</span>
        </button>
        <button id="landing-trash-empty" class="landing-trash-empty" type="button" hidden>${ icon('trash') }<span>Empty Trash</span></button>
      </div>
      <div id="landing-trash-region" class="landing-trash-region" aria-hidden="true">
        <div id="landing-trash-grid" class="landing-grid landing-trash-grid"></div>
      </div>
    </section>

    <footer class="landing-footer">
      <p>Projects are stored on this device. Use Export to back them up or move them to another browser.</p>
    </footer>
  </div>

  <div id="landing-selection-bar" class="landing-selection-bar" hidden>
    <span id="landing-selection-count" class="landing-selection-count"></span>
    <div class="landing-selection-move">
      <button id="landing-selection-move-btn" class="landing-selection-action" type="button" aria-haspopup="true" aria-expanded="false">${ icon('folder') }<span>Move to folder</span>${ icon('chevronUp') }</button>
      <div id="landing-selection-menu" class="landing-selection-menu" role="menu" hidden></div>
    </div>
    <button id="landing-selection-clear" class="landing-selection-action" type="button">${ icon('close') }<span>Clear</span></button>
  </div>
</div>
`;

const DRAG_MIME = 'application/x-legato-project-ids';

export function mountLandingPanel({ container, callbacks }) {
  container.insertAdjacentHTML('beforeend', TEMPLATE);
  const shell = container.querySelector('.landing-shell');

  const newBtn = shell.querySelector('#landing-new');
  const importBtn = shell.querySelector('#landing-import');
  const importInput = shell.querySelector('#landing-import-file');
  const exportAllBtn = shell.querySelector('#landing-export-all');
  const exportSelectedBtn = shell.querySelector('#landing-export-selected');
  const noticeEl = shell.querySelector('#landing-notice');
  const folderRow = shell.querySelector('#landing-folder-row');
  const recentGrid = shell.querySelector('#landing-recent-grid');
  const recentCount = shell.querySelector('#landing-recent-count');
  const demosGrid = shell.querySelector('#landing-demos-grid');
  const trashToggle = shell.querySelector('#landing-trash-toggle');
  const trashEmptyBtn = shell.querySelector('#landing-trash-empty');
  const trashRegion = shell.querySelector('#landing-trash-region');
  const trashGrid = shell.querySelector('#landing-trash-grid');
  const trashCount = shell.querySelector('#landing-trash-count');
  const selectionBar = shell.querySelector('#landing-selection-bar');
  const selectionCount = shell.querySelector('#landing-selection-count');
  const selectionMoveBtn = shell.querySelector('#landing-selection-move-btn');
  const selectionMenu = shell.querySelector('#landing-selection-menu');
  const selectionClearBtn = shell.querySelector('#landing-selection-clear');

  let trashOpen = false;
  // Snapshot of the last render, read by the selection bar, folder chips,
  // and drag handlers. The view owns this state; the panel only mirrors it.
  let currentFolders = [];
  let currentSelected = new Set();
  let dragPreviewEl = null;

  newBtn.onclick = () => callbacks.onNewProject();
  importBtn.onclick = () => importInput.click();
  exportAllBtn.onclick = () => callbacks.onExportAll();
  exportSelectedBtn.onclick = () => callbacks.onExportSelected([...currentSelected]);
  importInput.onchange = async (event) => {
    const file = event.target.files?.[0];
    importInput.value = '';
    if (!file) return;
    const text = await file.text();
    callbacks.onImport(text);
  };
  trashToggle.onclick = () => {
    trashOpen = !trashOpen;
    trashToggle.setAttribute('aria-expanded', String(trashOpen));
    trashRegion.classList.toggle('is-open', trashOpen);
    trashRegion.setAttribute('aria-hidden', String(!trashOpen));
  };
  trashEmptyBtn.onclick = () => callbacks.onEmptyTrash();

  // ── Selection bar ─────────────────────────────────────────────────────
  selectionClearBtn.onclick = () => callbacks.onClearSelection();
  selectionMoveBtn.onclick = (event) => {
    event.stopPropagation();
    if (selectionMenu.hidden) openSelectionMenu();
    else closeSelectionMenu();
  };
  shell.addEventListener('click', (event) => {
    if (!selectionMenu.hidden && !event.target.closest('.landing-selection-move')) {
      closeSelectionMenu();
    }
  });

  function menuItem({ label, iconName, onPick }) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'landing-selection-menu-item';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `${ iconName ? icon(iconName) : '' }<span>${ escapeHtml(label) }</span>`;
    item.onclick = () => { closeSelectionMenu(); onPick(); };
    return item;
  }

  function openSelectionMenu() {
    selectionMenu.replaceChildren();
    const ids = () => [...currentSelected];
    for (const folder of currentFolders) {
      selectionMenu.append(menuItem({
        label: folder.name,
        iconName: 'folder',
        onPick: () => callbacks.onMoveToFolder(ids(), folder.id),
      }));
    }
    selectionMenu.append(menuItem({
      label: 'New folder…',
      iconName: 'plus',
      onPick: () => {
        const name = prompt('Folder name', 'New folder');
        if (name && name.trim()) callbacks.onMoveToNewFolder(name.trim(), ids());
      },
    }));
    if (currentFolders.length) {
      selectionMenu.append(menuItem({
        label: 'Remove from folder',
        iconName: 'close',
        onPick: () => callbacks.onMoveToFolder(ids(), null),
      }));
    }
    selectionMenu.hidden = false;
    selectionMoveBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSelectionMenu() {
    selectionMenu.hidden = true;
    selectionMoveBtn.setAttribute('aria-expanded', 'false');
  }

  function renderSelectionBar() {
    const count = currentSelected.size;
    selectionBar.hidden = count === 0;
    exportSelectedBtn.disabled = count === 0;
    // While selecting, every card keeps its checkbox visible instead of
    // hover-only, so the selection surface is obvious.
    shell.classList.toggle('has-selection', count > 0);
    if (!count) { closeSelectionMenu(); return; }
    selectionCount.textContent = `${ count } selected`;
  }

  // ── Folder chips ──────────────────────────────────────────────────────
  function folderChip({ folder = null, count, active }) {
    const isAll = folder === null;
    const chip = document.createElement('div');
    chip.className = `landing-folder-chip${ active ? ' is-active' : '' }${ isAll ? ' is-all' : '' }`;
    chip.dataset.folderId = folder?.id ?? '';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'landing-folder-chip-main';
    main.setAttribute('aria-pressed', String(active));
    main.innerHTML = `
      ${ isAll ? '' : icon('folder') }
      <span class="landing-folder-chip-name">${ escapeHtml(isAll ? 'All projects' : folder.name) }</span>
      <span class="landing-folder-chip-count">${ count }</span>
    `;
    main.onclick = () => callbacks.onSelectFolder(folder?.id ?? null);
    chip.append(main);

    if (!isAll) {
      const tools = document.createElement('span');
      tools.className = 'landing-folder-chip-tools';
      tools.innerHTML = `
        <button type="button" class="icon-button" data-action="rename-folder" title="Rename folder" aria-label="Rename folder ${ escapeHtml(folder.name) }">${ icon('rename') }</button>
        <button type="button" class="icon-button is-danger" data-action="delete-folder" title="Delete folder" aria-label="Delete folder ${ escapeHtml(folder.name) }">${ icon('trash') }</button>
      `;
      tools.querySelector('[data-action="rename-folder"]').onclick = (event) => {
        event.stopPropagation();
        const next = prompt('Rename folder', folder.name);
        if (next && next.trim()) callbacks.onRenameFolder(folder.id, next.trim());
      };
      tools.querySelector('[data-action="delete-folder"]').onclick = (event) => {
        event.stopPropagation();
        if (confirm(`Delete folder "${ folder.name }"? Projects inside are kept and return to All projects.`)) {
          callbacks.onDeleteFolder(folder.id);
        }
      };
      chip.append(tools);
    }

    // Drop target: filing projects by dragging cards onto the chip. The All
    // chip doubles as "remove from folder".
    chip.addEventListener('dragover', (event) => {
      if (![...event.dataTransfer.types].includes(DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      chip.classList.add('is-drop-target');
    });
    chip.addEventListener('dragleave', (event) => {
      // Ignore transitions into the chip's own children — only clear the
      // highlight when the pointer truly leaves the chip.
      if (!(event.relatedTarget instanceof Node) || !chip.contains(event.relatedTarget)) {
        chip.classList.remove('is-drop-target');
      }
    });
    chip.addEventListener('drop', (event) => {
      chip.classList.remove('is-drop-target');
      const raw = event.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.length) callbacks.onMoveToFolder(ids, folder?.id ?? null);
      } catch { /* Foreign drag payload — ignore. */ }
    });

    return chip;
  }

  function renderFolderRow(folders, recent, activeFolderId) {
    folderRow.replaceChildren();
    folderRow.append(folderChip({ folder: null, count: recent.length, active: activeFolderId == null }));
    for (const folder of folders) {
      const count = recent.filter((p) => (p.folderId ?? null) === folder.id).length;
      folderRow.append(folderChip({ folder, count, active: activeFolderId === folder.id }));
    }
    const newFolderBtn = document.createElement('button');
    newFolderBtn.type = 'button';
    newFolderBtn.className = 'landing-folder-new';
    newFolderBtn.innerHTML = `${ icon('plus') }<span>New folder</span>`;
    newFolderBtn.onclick = () => {
      const name = prompt('Folder name', 'New folder');
      if (name && name.trim()) callbacks.onCreateFolder(name.trim());
    };
    folderRow.append(newFolderBtn);
  }

  // ── Multi-select + drag source on recent cards ────────────────────────
  function cleanupDrag() {
    shell.classList.remove('is-dragging-projects');
    folderRow.querySelectorAll('.is-drop-target').forEach((chip) => chip.classList.remove('is-drop-target'));
    dragPreviewEl?.remove();
    dragPreviewEl = null;
  }

  function decorateRecentCard(card, project) {
    const selected = currentSelected.has(project.id);
    card.classList.toggle('is-selected', selected);

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'landing-card-select';
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('aria-checked', String(selected));
    checkbox.setAttribute('aria-label', `Select ${ project.name }`);
    checkbox.innerHTML = icon('check');
    checkbox.onclick = (event) => {
      event.stopPropagation();
      callbacks.onToggleSelect(project.id);
    };
    card.append(checkbox);

    // While a selection is active, the whole card toggles membership instead
    // of opening the editor — same pattern as file managers and Canva.
    card.querySelector('.landing-card-body').onclick = () => {
      if (currentSelected.size) callbacks.onToggleSelect(project.id);
      else callbacks.onOpenProject(project.id);
    };

    card.draggable = true;
    card.addEventListener('dragstart', (event) => {
      const ids = currentSelected.has(project.id) ? [...currentSelected] : [project.id];
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
      event.dataTransfer.setData('text/plain', ids.length === 1 ? project.name : `${ ids.length } projects`);
      shell.classList.add('is-dragging-projects');
      dragPreviewEl = document.createElement('div');
      dragPreviewEl.className = 'landing-drag-preview';
      dragPreviewEl.innerHTML = `${ icon('folder') }<span>${ escapeHtml(ids.length === 1 ? project.name : `${ ids.length } projects`) }</span>`;
      document.body.append(dragPreviewEl);
      event.dataTransfer.setDragImage(dragPreviewEl, 18, 18);
    });
    card.addEventListener('dragend', cleanupDrag);
  }

  function renderCards(gridEl, cards, kind, emptyText) {
    gridEl.replaceChildren();
    if (!cards.length) {
      const empty = document.createElement('div');
      empty.className = 'landing-empty';
      empty.textContent = emptyText ?? emptyMessage(kind);
      gridEl.append(empty);
      return;
    }
    for (const card of cards) {
      const el = renderCard(card, kind, callbacks);
      if (kind === 'recent') decorateRecentCard(el, card);
      gridEl.append(el);
    }
  }

  return {
    render({ recent, demos, trashed, folders = [], activeFolderId = null, selectedIds = new Set() }) {
      currentFolders = folders;
      currentSelected = selectedIds;
      const filtered = activeFolderId == null
        ? recent
        : recent.filter((p) => (p.folderId ?? null) === activeFolderId);
      renderFolderRow(folders, recent, activeFolderId);
      renderCards(
        recentGrid,
        filtered,
        'recent',
        activeFolderId != null && !filtered.length
          ? 'This folder is empty. Drag projects onto its chip, or use Move to folder.'
          : undefined,
      );
      renderCards(demosGrid, demos, 'demo');
      renderCards(trashGrid, trashed, 'trashed');
      recentCount.textContent = activeFolderId == null
        ? (recent.length === 1 ? '1 project' : `${ recent.length } projects`)
        : `${ filtered.length } of ${ recent.length } project${ recent.length === 1 ? '' : 's' }`;
      trashCount.textContent = trashed.length ? `${ trashed.length } item${ trashed.length === 1 ? '' : 's' }` : 'Empty';
      trashEmptyBtn.hidden = !trashed.length;
      renderSelectionBar();
    },
    showNotice({ message, level = 'info' }) {
      noticeEl.textContent = message;
      noticeEl.dataset.level = level;
      noticeEl.hidden = false;
    },
    hideNotice() {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
    },
  };
}

function emptyMessage(kind) {
  if (kind === 'recent') return 'No projects yet. Start a new one or open a demo below.';
  if (kind === 'trashed') return 'Nothing in the trash.';
  return 'No demos.';
}

/**
 * Push each project's own theme onto its card so the accent stripe (border-
 * left) and title font reflect that project — not whatever theme was last
 * applied to the document root. `--card-accent` overrides `--accent` inside
 * the card scope; `data-chord-font` re-resolves `--font-chord` locally.
 */
function applyCardTheme(card, project) {
  const theme = project.progression?.settings?.theme;
  if (theme?.accent) card.style.setProperty('--card-accent', theme.accent);
  const requested = theme?.chordFont?.toLowerCase();
  const chordFont = CHORD_FONTS.includes(requested) ? requested : DEFAULT_CHORD_FONT;
  card.dataset.chordFont = chordFont;
  card.classList.toggle('is-classical-project', chordFont === 'classical');
}

function iconButton({ icon: iconName, label, action, dangerous = false }) {
  // Uses the shared .icon-button primitive from css/base.css so every icon
  // button in the app (landing, editor, dialog) picks up hover/focus tweaks
  // in one place.
  const classes = ['icon-button', 'is-bordered'];
  if (dangerous) classes.push('is-danger');
  return `<button type="button" class="${ classes.join(' ') }" data-action="${ action }" title="${ label }" aria-label="${ label }">${ icon(iconName) }</button>`;
}

function renderCard(project, kind, callbacks) {
  const chordCount = project.progression?.chords?.length ?? 0;
  const seamCount = project.progression?.seams?.filter(Boolean).length ?? 0;
  const meta = kind === 'demo'
    ? escapeHtml(project.blurb ?? `${ chordCount } chord${ chordCount === 1 ? '' : 's' }`)
    : `${ chordCount } chord${ chordCount === 1 ? '' : 's' } · ${ seamCount } transition${ seamCount === 1 ? '' : 's' }`;

  // Demo cards are one big clickable target that opens a copy — no separate
  // primary button, no ambiguity about what a click does. Recent + trashed
  // cards keep the two-region layout (body + actions).
  if (kind === 'demo') {
    const card = document.createElement('button');
    card.className = `landing-card landing-card-demo`;
    card.dataset.projectId = project.id;
    card.type = 'button';
    applyCardTheme(card, project);
    card.innerHTML = `
      <span class="landing-card-badge">Demo · click to open a copy</span>
      <span class="landing-card-name">${ escapeHtml(project.name) }</span>
      <span class="landing-card-meta">${ meta }</span>
    `;
    card.onclick = () => callbacks.onOpenDemo(project.id);
    return card;
  }

  const card = document.createElement('article');
  card.className = `landing-card landing-card-${ kind }`;
  card.dataset.projectId = project.id;
  applyCardTheme(card, project);

  const iconRow = kind === 'recent'
    ? [
        iconButton({ icon: 'rename', label: 'Rename', action: 'rename' }),
        iconButton({ icon: 'duplicate', label: 'Duplicate', action: 'duplicate' }),
        iconButton({ icon: 'export', label: 'Export', action: 'export' }),
        iconButton({ icon: 'trash', label: 'Move to trash', action: 'trash', dangerous: true }),
      ].join('')
    : '';

  const updatedAt = project.updatedAt ? `<span class="landing-card-updated">${ formatRelative(project.updatedAt) }</span>` : '';
  const primaryAction = kind === 'trashed'
    ? '<button class="landing-card-primary" type="button">Restore</button>'
    : '';
  const bodyTag = kind === 'recent' ? 'button' : 'div';
  const bodyAttrs = kind === 'recent' ? 'type="button"' : '';

  card.innerHTML = `
    <${ bodyTag } class="landing-card-body" ${ bodyAttrs }>
      <div class="landing-card-title-row">
        <span class="landing-card-name">${ escapeHtml(project.name) }</span>
        ${ updatedAt }
      </div>
      <span class="landing-card-meta">${ meta }</span>
    </${ bodyTag }>
    <div class="landing-card-actions">
      ${ primaryAction }
      ${ iconRow }
      ${ kind === 'trashed' ? iconButton({ icon: 'trash', label: 'Delete permanently', action: 'delete', dangerous: true }) : '' }
    </div>
  `;

  const primaryBtn = card.querySelector('.landing-card-primary');

  if (kind === 'recent') {
    const open = () => callbacks.onOpenProject(project.id);
    card.querySelector('.landing-card-body').onclick = open;
    card.querySelector('.landing-card-actions').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action]');
      if (!btn) return;
      event.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'rename') {
        const next = prompt('Rename project', project.name);
        if (next && next.trim()) callbacks.onRenameProject(project.id, next.trim());
      } else if (action === 'duplicate') {
        callbacks.onDuplicateProject(project.id);
      } else if (action === 'export') {
        callbacks.onExportProject(project.id);
      } else if (action === 'trash') {
        callbacks.onTrashProject(project.id);
      }
    });
  } else {
    primaryBtn.onclick = () => callbacks.onRestoreProject(project.id);
    card.querySelector('.landing-card-actions').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action="delete"]');
      if (!btn) return;
      event.stopPropagation();
      if (confirm(`Permanently delete "${ project.name }"? This can't be undone.`)) {
        callbacks.onDeleteProject(project.id);
      }
    });
  }

  return card;
}

function formatRelative(iso) {
  if (!iso) return 'just now';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${ Math.floor(seconds / 60) } min ago`;
  if (seconds < 86400) return `${ Math.floor(seconds / 3600) } hr ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${ days } day${ days === 1 ? '' : 's' } ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
