/**
 * Trash view — mounts the abandoned-library panel and wires its actions to
 * the store. Mirrors landing-view's "read from store, render, react to
 * callbacks, re-render" shape.
 *
 * Recovering a project navigates straight back to the constellation (a
 * recovered star belongs on the map, not in the library) via the same
 * fade-to-black used elsewhere. `onRecovered` is how trash-view hands the
 * recovered project's id across that navigation boundary — main.js holds it
 * in memory just long enough for landing-view's next mount to pick it up and
 * play the star's "just came back" birth animation.
 */
import { mountTrashLibrary } from '../ui/trash-library.js';
import { navigate, LANDING_HASH } from '../router.js';
import { withViewFade } from '../ui/view-fade.js';

export function createTrashView({ store, onRecovered }) {
  return {
    async mount(root) {
      const panel = mountTrashLibrary({
        container: root,
        callbacks: {
          onBack: async () => {
            await withViewFade(async () => navigate(LANDING_HASH));
          },
          onRecover: async (id) => {
            const restored = await tryStore(() => store.restoreProject(id));
            if (restored) onRecovered?.(id);
            await withViewFade(async () => navigate(LANDING_HASH));
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
        },
      });

      async function refresh() {
        const trashed = await store.listTrashed();
        panel.render(trashed);
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
          panel.destroy();
          root.replaceChildren();
        },
      };
    },
  };
}
