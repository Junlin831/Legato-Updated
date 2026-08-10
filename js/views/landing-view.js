/**
 * Landing view — mounts the projects hub and wires its actions to the store.
 *
 * Owns the "read from store, render panel, react to callbacks, re-render"
 * loop. Navigation lives here: opening/cloning a project pushes an editor
 * route via the router.
 */
import { mountConstellationMap } from '../ui/constellation-map.js';
import { navigate, editorHash } from '../router.js';
import { makeProgression, makeSettings } from '../state.js';
import { withViewFade } from '../ui/view-fade.js';

export function createLandingView({ store, projectSettingsDialog }) {
  return {
    async mount(root) {
      // Folder filter + multi-select state. Session-only by design: a page
      // load always starts back at "All projects" with nothing selected.
      let activeFolderId = null;
      let selectedIds = new Set();

      const panel = mountConstellationMap({
        container: root,
        callbacks: {
          onCreateProject: async (name) => {
            const progression = makeProgression({ settings: makeSettings() });
            const project = await tryStore(() => store.createProject({ name, progression }));
            if (!project) return;
            await withViewFade(async () => navigate(editorHash(project.id)));
          },
          onImport: async (text) => {
            panel.hideNotice();
            try {
              const { added, warnings, error } = await store.importProjects(text);
              if (error) { panel.showNotice({ message: error, level: 'error' }); return; }
              const parts = [`Imported ${ added.length } project${ added.length === 1 ? '' : 's' }.`];
              if (warnings.length) parts.push(warnings.slice(0, 3).join(' '));
              if (warnings.length > 3) parts.push(`(+${ warnings.length - 3 } more warnings)`);
              panel.showNotice({ message: parts.join(' '), level: warnings.length ? 'warn' : 'info' });
              await refresh();
            } catch (error) {
              panel.showNotice({ message: error.message, level: 'error' });
            }
          },
          onExportAll: async () => {
            try {
              const { blob, filename, count } = await store.exportProjects();
              if (!count) { panel.showNotice({ message: 'No projects to export.', level: 'warn' }); return; }
              downloadBlob(blob, filename);
            } catch (error) {
              panel.showNotice({ message: error.message, level: 'error' });
            }
          },
          onExportProject: async (id) => {
            try {
              const { blob, filename } = await store.exportProjects([id]);
              downloadBlob(blob, filename);
            } catch (error) {
              panel.showNotice({ message: error.message, level: 'error' });
            }
          },
          onExportSelected: async (ids) => {
            try {
              const { blob, filename, count } = await store.exportProjects(ids);
              if (!count) { panel.showNotice({ message: 'No selected projects to export.', level: 'warn' }); return; }
              downloadBlob(blob, filename);
            } catch (error) {
              panel.showNotice({ message: error.message, level: 'error' });
            }
          },
          onOpenProject: async (id) => {
            await withViewFade(async () => navigate(editorHash(id)));
          },
          onOpenDemo: async (demoId) => {
            const clone = await tryStore(() => store.cloneDemo(demoId));
            if (clone) await withViewFade(async () => navigate(editorHash(clone.id)));
          },
          onRenameProject: async (id, name) => {
            await tryStore(() => store.renameProject(id, name));
            await refresh();
          },
          onDuplicateProject: async (id) => {
            await tryStore(() => store.duplicateProject(id));
            await refresh();
          },
          onTrashProject: async (id) => {
            await tryStore(() => store.trashProject(id));
            selectedIds.delete(id);
            await refresh();
          },
          onRestoreProject: async (id) => {
            await tryStore(() => store.restoreProject(id));
            await refresh();
          },
          onDeleteProject: async (id) => {
            await tryStore(() => store.deleteProject(id));
            await refresh();
          },
          onEmptyTrash: async () => {
            const trashed = await store.listTrashed();
            if (!trashed.length) return;
            const label = trashed.length === 1 ? '1 project' : `${ trashed.length } projects`;
            if (!confirm(`Permanently delete ${ label } in the trash? This can't be undone.`)) return;
            for (const project of trashed) {
              await tryStore(() => store.deleteProject(project.id));
            }
            await refresh();
          },

          // ── Folders + multi-select ────────────────────────────────────
          onSelectFolder: async (folderId) => {
            activeFolderId = folderId;
            // Switching the filter drops the selection so a bulk action can
            // never touch cards that are no longer visible.
            selectedIds = new Set();
            await refresh();
          },
          onCreateFolder: async (name) => {
            await tryStore(() => store.createFolder(name));
            await refresh();
          },
          onRenameFolder: async (id, name) => {
            await tryStore(() => store.renameFolder(id, name));
            await refresh();
          },
          onDeleteFolder: async (id) => {
            await tryStore(() => store.deleteFolder(id));
            if (activeFolderId === id) activeFolderId = null;
            await refresh();
          },
          onToggleSelect: async (id) => {
            if (selectedIds.has(id)) selectedIds.delete(id);
            else selectedIds.add(id);
            await refresh();
          },
          onClearSelection: async () => {
            selectedIds = new Set();
            await refresh();
          },
          onMoveToFolder: async (ids, folderId) => {
            await tryStore(() => store.assignToFolder(ids, folderId));
            selectedIds = new Set();
            await refresh();
          },
          onMoveToNewFolder: async (name, ids) => {
            const folder = await tryStore(() => store.createFolder(name));
            if (folder) await tryStore(() => store.assignToFolder(ids, folder.id));
            selectedIds = new Set();
            await refresh();
          },
        },
      });

      async function refresh() {
        const [recent, demos, trashed, folders] = await Promise.all([
          store.listProjects(),
          store.listDemos(),
          store.listTrashed(),
          store.listFolders(),
        ]);
        // Single fixed central demo for now — see docs/legato-home-revamp-prompt.md
        // §2. If a second demo is ever added, the constellation map will need a
        // real multi-central-node treatment; not needed for the current one.
        panel.render({ recent, demo: demos[0] ?? null, trashed, folders, activeFolderId, selectedIds });
      }

      async function tryStore(fn) {
        try {
          return await fn();
        } catch (error) {
          panel.showNotice({ message: error.message, level: 'error' });
          return null;
        }
      }

      await refresh();

      return {
        async unmount() {
          root.replaceChildren();
        },
      };
    },
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
