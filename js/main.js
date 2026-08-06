/**
 * Application bootstrap.
 *
 * Two views (landing, editor) and one router. Everything else — progression
 * state, sheet music rendering, audio — lives inside the editor view
 * so navigating away and back gives a clean slate.
 *
 *   #/           → landing view
 *   #/edit/:id   → editor view
 *
 * The piano modal is mounted once here (shared across sessions) because it
 * is stateful DOM the editor opens and closes many times per session; a per-
 * mount rebuild would slow chord edits down for no gain.
 */
import { mountPianoModal } from './ui/piano-modal.js';
import { mountProjectSettingsModal } from './ui/project-settings-modal.js';
import { createProjectStore } from './persistence.js';
import { createRouter, makeEditorResumePolicy, parseEditorHash, LANDING_HASH } from './router.js';
import { createLandingView } from './views/landing-view.js';
import { createEditorView } from './views/editor-view.js';
import {
  beginStartupHandoff,
  completeStartupHandoff,
  mountStartupSplash,
  shouldShowStartupSplash,
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

const store = createProjectStore();
const landingView = createLandingView({ store, projectSettingsDialog });
const editorView = createEditorView({
  store,
  pianoDialog,
  projectSettingsDialog,
});

const router = createRouter({
  root: appRoot,
  routes: [
    { match: (hash) => (hash === LANDING_HASH ? {} : null), view: landingView },
    { match: (hash) => parseEditorHash(hash), view: editorView },
  ],
  notFound: landingView,
  resume: makeEditorResumePolicy(store),
});

if (startupSplash && shouldShowStartupSplash()) {
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
