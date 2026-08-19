/**
 * Application bootstrap.
 *
 * Two views (landing, editor) and one router. Everything else — progression
 * state, sheet music rendering, audio — lives inside the editor view
 * so navigating away and back gives a clean slate.
 *
 *   #/           → landing view (constellation map)
 *   #/edit/:id   → editor view
 *   #/trash      → trash view (the abandoned library)
 *
 * The piano modal is mounted once here (shared across sessions) because it
 * is stateful DOM the editor opens and closes many times per session; a per-
 * mount rebuild would slow chord edits down for no gain.
 */
import { mountPianoModal } from './ui/piano-modal.js';
import { mountProjectSettingsModal } from './ui/project-settings-modal.js';
import { mountStarOpenTransition } from './ui/star-open-transition.js';
import { createProjectStore } from './persistence.js';
import { createRouter, parseEditorHash, LANDING_HASH, TRASH_HASH } from './router.js';
import { createLandingView } from './views/landing-view.js';
import { createEditorView } from './views/editor-view.js';
import { createTrashView } from './views/trash-view.js';
import {
  beginStartupHandoff,
  completeStartupHandoff,
  mountStartupSplash,
  waitForStartupHandoffTarget,
} from './ui/startup-splash.js';

const appRoot = document.querySelector('#app-root');
const startupSplash = appRoot.querySelector('.startup-splash');
const pianoDialog = mountPianoModal({
  container: document.querySelector('#piano-modal-mount'),
});
const projectSettingsDialog = mountProjectSettingsModal({
  container: document.querySelector('#project-settings-modal-mount'),
});
const starOpenTransition = mountStarOpenTransition(document.querySelector('#star-dive-mount'));

const store = createProjectStore();

// One-shot handoff for "this star was just recovered from the trash" across
// the trash-view -> landing-view navigation boundary. Each view is torn down
// and rebuilt fresh on every mount (see landing-view.js's own doc comment),
// so there's nowhere inside either view to hold this — it has to live here,
// in the one thing that outlives both. Consumed exactly once by landing-view
// right after its next mount.
let pendingRecoveredId = null;
function consumeRecoveredStarId() {
  const id = pendingRecoveredId;
  pendingRecoveredId = null;
  return id;
}

const landingView = createLandingView({ store, projectSettingsDialog, starOpenTransition, consumeRecoveredStarId });
const editorView = createEditorView({
  store,
  pianoDialog,
  projectSettingsDialog,
});
const trashView = createTrashView({
  store,
  onRecovered: (id) => { pendingRecoveredId = id; },
});

const router = createRouter({
  root: appRoot,
  routes: [
    { match: (hash) => (hash === LANDING_HASH ? {} : null), view: landingView },
    { match: (hash) => parseEditorHash(hash), view: editorView },
    { match: (hash) => (hash === TRASH_HASH ? {} : null), view: trashView },
  ],
  notFound: landingView,
});

if (startupSplash) {
  // Keep the splash outside the router root so the destination view can mount
  // invisibly behind its black handoff stage.
  document.body.append(startupSplash);
  const splashController = mountStartupSplash(startupSplash);
  const startupCharacter = await beginStartupHandoff(startupSplash);
  splashController.destroy();
  await router.start();
  const destination = await waitForStartupHandoffTarget(appRoot);
  await completeStartupHandoff(startupSplash, startupCharacter, destination);
} else {
  startupSplash?.remove();
  await router.start();
}
