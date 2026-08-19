/**
 * Project persistence — localStorage-backed store with an async API.
 *
 * Views never touch localStorage directly. They call `createProjectStore()`
 * once and use the returned object. The API is intentionally Promise-based
 * even though localStorage is synchronous, so a future auth/REST backend is
 * a drop-in swap for this module with zero view changes.
 *
 * Layout (versioned so future migrations are safe):
 *   legato.schemaVersion   → "1"
 *   legato.projects        → JSON array of Project objects
 *   legato.folders         → JSON array of Folder objects ({id, name, ...})
 *
 * Each stored Project has a `deletedAt: string|null` field — soft-delete flag
 * for Trash. `null` means active; ISO string means trashed. Projects also
 * carry `folderId: string|null` — device-local organization into folders.
 * Export drops both fields so on-disk export files stay on the schema in
 * docs/data-model.md §0; imported projects always land outside any folder.
 */
import { SCHEMA_VERSION, newId, makeProgression, makeSettings, validateProgression } from './state.js';
import { DEMO_PROJECTS } from './data/demo-projects.js';

const STORAGE_KEY = 'legato.projects';
const FOLDERS_KEY = 'legato.folders';
const VERSION_KEY = 'legato.schemaVersion';
const EXPORT_KIND = 'legato-projects';

/**
 * Build a fresh store instance. Multiple instances are safe — they all read
 * and write the same localStorage keys.
 */
export function createProjectStore({ storage = defaultStorage() } = {}) {
  function readAll() {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalizeStoredProject) : [];
    } catch {
      return [];
    }
  }

  function writeAll(projects) {
    try {
      storage.setItem(VERSION_KEY, String(SCHEMA_VERSION));
      storage.setItem(STORAGE_KEY, JSON.stringify(projects));
      return { ok: true };
    } catch (error) {
      const quota = isQuotaError(error);
      return { ok: false, quota, error };
    }
  }

  function readFolders() {
    const raw = storage.getItem(FOLDERS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
        : [];
    } catch {
      return [];
    }
  }

  function writeFolders(folders) {
    try {
      storage.setItem(FOLDERS_KEY, JSON.stringify(folders));
      return { ok: true };
    } catch (error) {
      return { ok: false, quota: isQuotaError(error), error };
    }
  }

  function upsert(project) {
    const all = readAll();
    const index = all.findIndex((entry) => entry.id === project.id);
    const next = { ...project, updatedAt: new Date().toISOString() };
    if (index === -1) all.push(next);
    else all[index] = next;
    const result = writeAll(all);
    if (!result.ok) throw makeStorageError(result);
    return next;
  }

  function activeSorted(projects) {
    return projects.filter((p) => !p.deletedAt).sort(byUpdatedDesc);
  }

  function trashedSorted(projects) {
    return projects.filter((p) => p.deletedAt).sort(byUpdatedDesc);
  }

  return {
    async listProjects() {
      return activeSorted(readAll());
    },
    async listTrashed() {
      return trashedSorted(readAll());
    },
    async listDemos() {
      return DEMO_PROJECTS;
    },
    async getProject(id) {
      const found = readAll().find((p) => p.id === id);
      return found ?? null;
    },
    async createProject({ name = 'Untitled project', progression, folderId = null, sourceDemoId = null } = {}) {
      const now = new Date().toISOString();
      const project = {
        id: newId('p'),
        name,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        folderId: folderId && readFolders().some((f) => f.id === folderId) ? folderId : null,
        // Marks this project as a user's editable copy of a bundled demo, so
        // reopening the demo star finds and reuses it (see cloneDemo below)
        // instead of minting a fresh constellation star every time.
        sourceDemoId,
        progression: progression ?? emptyProgression(),
      };
      const all = readAll();
      all.push(project);
      const result = writeAll(all);
      if (!result.ok) throw makeStorageError(result);
      return project;
    },
    async saveProject(project) {
      return upsert(project);
    },
    async renameProject(id, name) {
      const all = readAll();
      const project = all.find((p) => p.id === id);
      if (!project) return null;
      project.name = name;
      project.updatedAt = new Date().toISOString();
      const result = writeAll(all);
      if (!result.ok) throw makeStorageError(result);
      return project;
    },
    /**
     * Remember where the user dragged a star on the constellation map, so it
     * stays put across visits instead of settling back to its seeded spot.
     * Not a content edit — like folder assignment above, `updatedAt` is left
     * untouched so repositioning a star never reshuffles anything else.
     */
    async setMapPosition(id, pos) {
      const all = readAll();
      const project = all.find((p) => p.id === id);
      if (!project) return null;
      project.mapPosition = pos ?? null;
      const result = writeAll(all);
      if (!result.ok) throw makeStorageError(result);
      return project;
    },
    async trashProject(id) {
      const all = readAll();
      const project = all.find((p) => p.id === id);
      if (!project) return null;
      project.deletedAt = new Date().toISOString();
      project.updatedAt = project.deletedAt;
      const result = writeAll(all);
      if (!result.ok) throw makeStorageError(result);
      return project;
    },
    async restoreProject(id) {
      const all = readAll();
      const project = all.find((p) => p.id === id);
      if (!project) return null;
      project.deletedAt = null;
      project.updatedAt = new Date().toISOString();
      const result = writeAll(all);
      if (!result.ok) throw makeStorageError(result);
      return project;
    },
    async deleteProject(id) {
      const all = readAll().filter((p) => p.id !== id);
      const result = writeAll(all);
      if (!result.ok) throw makeStorageError(result);
      return true;
    },
    async duplicateProject(id) {
      const source = readAll().find((p) => p.id === id);
      if (!source) return null;
      const name = uniqueName(`${ source.name } (copy)`, readAll());
      // The copy stays in the source's folder so it appears next to the
      // original when the user is filtered to that folder.
      return this.createProject({
        name,
        progression: cloneProgression(source.progression),
        folderId: source.folderId ?? null,
      });
    },
    /**
     * Opening the demo star clones it into a real, editable project the
     * first time — but reopening it later reuses that same clone rather
     * than minting a fresh constellation star on every visit. A trashed
     * clone doesn't count as "existing": the user discarded it, so opening
     * the demo again starts a new one.
     */
    async cloneDemo(demoId, { name } = {}) {
      const demo = DEMO_PROJECTS.find((d) => d.id === demoId);
      if (!demo) return null;
      const existing = activeSorted(readAll()).find((p) => p.sourceDemoId === demoId);
      if (existing) return existing;
      const finalName = uniqueName(name ?? demo.name, readAll());
      return this.createProject({ name: finalName, progression: cloneProgression(demo.progression), sourceDemoId: demoId });
    },

    // ── Folders — device-local project organization ─────────────────────
    async listFolders() {
      return readFolders().sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    },
    async createFolder(name) {
      const folders = readFolders();
      const now = new Date().toISOString();
      const folder = {
        id: newId('f'),
        name: uniqueFolderName(String(name || 'New folder').trim() || 'New folder', folders),
        createdAt: now,
        updatedAt: now,
      };
      const result = writeFolders([...folders, folder]);
      if (!result.ok) throw makeStorageError(result);
      return folder;
    },
    async renameFolder(id, name) {
      const folders = readFolders();
      const folder = folders.find((f) => f.id === id);
      if (!folder) return null;
      const trimmed = String(name || '').trim();
      if (!trimmed) return folder;
      folder.name = uniqueFolderName(trimmed, folders.filter((f) => f.id !== id));
      folder.updatedAt = new Date().toISOString();
      const result = writeFolders(folders);
      if (!result.ok) throw makeStorageError(result);
      return folder;
    },
    /**
     * Deleting a folder never deletes projects: members are released back
     * to the unfiled ("All projects") surface.
     */
    async deleteFolder(id) {
      const folders = readFolders();
      if (!folders.some((f) => f.id === id)) return false;
      const foldersResult = writeFolders(folders.filter((f) => f.id !== id));
      if (!foldersResult.ok) throw makeStorageError(foldersResult);
      const all = readAll();
      let touched = false;
      for (const project of all) {
        if (project.folderId === id) {
          project.folderId = null;
          touched = true;
        }
      }
      if (touched) {
        const projectsResult = writeAll(all);
        if (!projectsResult.ok) throw makeStorageError(projectsResult);
      }
      return true;
    },
    /**
     * Move projects into a folder (or out of any folder with `null`).
     * Assignment is not a content edit, so `updatedAt` is left untouched —
     * filing a project must not reshuffle the recency-sorted grid.
     */
    async assignToFolder(projectIds, folderId) {
      const target = folderId == null ? null : folderId;
      if (target && !readFolders().some((f) => f.id === target)) return [];
      const wanted = new Set(Array.isArray(projectIds) ? projectIds : [projectIds]);
      const all = readAll();
      const moved = [];
      for (const project of all) {
        if (wanted.has(project.id) && (project.folderId ?? null) !== target) {
          project.folderId = target;
          moved.push(project);
        }
      }
      if (moved.length) {
        const result = writeAll(all);
        if (!result.ok) throw makeStorageError(result);
      }
      return moved;
    },

    /**
     * @param {string[]} [ids]  If omitted or empty, exports all active projects.
     * @returns {Promise<{ blob: Blob, filename: string, count: number }>}
     */
    async exportProjects(ids) {
      const all = activeSorted(readAll());
      const chosen = ids && ids.length
        ? all.filter((p) => ids.includes(p.id))
        : all;
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        kind: EXPORT_KIND,
        projects: chosen.map(stripInternalFields),
      };
      const filename = chosen.length === 1
        ? `${ safeFilename(chosen[0].name) }.legato.json`
        : 'legato-projects.legato.json';
      return {
        blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        filename,
        count: chosen.length,
      };
    },

    /**
     * @param {string} json  Raw JSON text from a picked file.
     * @returns {Promise<{ added: Project[], warnings: string[], error?: string }>}
     */
    async importProjects(json) {
      const warnings = [];
      let payload;
      try {
        payload = JSON.parse(json);
      } catch (error) {
        return { added: [], warnings, error: `File is not valid JSON: ${ error.message }` };
      }
      if (!payload || payload.kind !== EXPORT_KIND || !Array.isArray(payload.projects)) {
        return { added: [], warnings, error: 'Not a LEGATO export file.' };
      }
      if (Number.isInteger(payload.schemaVersion) && payload.schemaVersion > SCHEMA_VERSION) {
        warnings.push(`File was written by a newer schema (v${ payload.schemaVersion }); some data may be ignored.`);
      }

      const all = readAll();
      const added = [];
      const now = new Date().toISOString();
      for (const entry of payload.projects) {
        const result = validateProgression(entry?.progression);
        if (!result.ok) {
          warnings.push(`Skipped "${ entry?.name ?? 'untitled' }": ${ result.error }`);
          continue;
        }
        warnings.push(...result.warnings);
        const name = uniqueName(String(entry?.name || 'Imported project'), all, added);
        added.push({
          id: newId('p'),
          name,
          createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : now,
          updatedAt: now,
          deletedAt: null,
          folderId: null,
          progression: result.progression,
        });
      }

      const writeResult = writeAll([...all, ...added]);
      if (!writeResult.ok) throw makeStorageError(writeResult);
      return { added, warnings };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function defaultStorage() {
  if (typeof localStorage !== 'undefined') return localStorage;
  // In-memory fallback for tests / SSR. Never used in the browser.
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

function emptyProgression() {
  return makeProgression();
}

/**
 * Normalize a project shape loaded from localStorage against the current
 * Settings contract. Pre-revamp projects lack `theme` (accent + chordFont);
 * without this, editor-view's applyTheme() crashes on undefined access.
 *
 * We only patch `settings` — chords/seams already went through
 * `validateProgression` on save, and touching them here would re-run that
 * cost on every read. Migration is lazy: the normalized shape only reaches
 * disk on the next mutation, so unopened projects stay bit-identical.
 */
function normalizeStoredProject(project) {
  if (!project?.progression?.settings) return project;
  const settings = project.progression.settings;
  const normalizedSettings = makeSettings(settings);
  if (settings.theme?.accent && settings.theme?.chordFont
    && settings.meterType === normalizedSettings.meterType) return project;
  return {
    ...project,
    progression: {
      ...project.progression,
      settings: normalizedSettings,
    },
  };
}

function cloneProgression(progression) {
  return JSON.parse(JSON.stringify(progression));
}

function stripInternalFields(project) {
  const { deletedAt: _deletedAt, folderId: _folderId, mapPosition: _mapPosition, sourceDemoId: _sourceDemoId, ...rest } = project;
  return rest;
}

function safeFilename(name) {
  return name.replace(/[^\w\-. ]+/g, '_').trim() || 'project';
}

function uniqueName(base, existing, pending = []) {
  // Trashed projects don't count as name collisions — they're archived, not
  // present in the user's active browsing surface. Two "My progression"
  // can coexist if one is in the trash.
  const taken = new Set(
    [...existing, ...pending]
      .filter((p) => !p.deletedAt)
      .map((p) => p.name),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${ base } (${ n })`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${ base } (${ Date.now().toString(36) })`;
}

function uniqueFolderName(base, existing) {
  const taken = new Set(existing.map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${ base } (${ n })`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${ base } (${ Date.now().toString(36) })`;
}

function isQuotaError(error) {
  if (!error) return false;
  const name = error.name || '';
  const code = error.code;
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || code === 22
    || code === 1014;
}

function makeStorageError({ quota, error }) {
  const message = quota
    ? 'Browser storage is full — export or delete some projects to make room.'
    : `Could not save to browser storage: ${ error?.message ?? error }`;
  const wrapped = new Error(message);
  wrapped.name = quota ? 'QuotaExceededError' : 'StorageError';
  wrapped.cause = error;
  return wrapped;
}
