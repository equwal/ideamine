// Each change of the archive goes through here: to the archive on this machine, or to the ideamine
// server when sync is on. Callers await each function in both cases. When the server does not
// answer, a change resolves to { queued: true, reason }: it waits in the outbox and goes later.

import os from 'node:os';
import { absolute, addIdeas, applyTriage, findIdea, load, removeIdeas, updateIdea } from './store.js';
import * as sync from './sync.js';

let offline = null;

/**
 * The archive, fresh from the server when sync is on. When the server does not answer, the copy on
 * this machine, and offline() tells why.
 */
export async function fresh({ timeoutMs = 1500 } = {}) {
  offline = null;
  if (sync.enabled()) {
    try {
      await sync.pull({ timeoutMs });
    } catch (e) {
      if (!(e instanceof sync.SyncError)) throw e;
      offline = e.message;
    }
  }
  return load();
}

/** Why the last fresh() gave the copy on this machine, or null. */
export const offlineReason = () => offline;

export async function add(texts, { source = 'mcp', project = null, session = null, tags = [] } = {}) {
  const host = os.hostname();
  if (!sync.enabled()) return addIdeas(texts, { source, project, session, tags, host });
  const items = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!items.length) throw new Error('idea text is empty');
  const out = await sync.change({ op: 'add', texts: items, source, project: project ? absolute(project) : null, session, tags, host });
  if (out.queued) return out;
  const db = load();
  return out.value.map((r) => ({ idea: findIdea(db, r.id), similar: r.similar }));
}

export async function update(id, patch = {}) {
  if (!sync.enabled()) return updateIdea(id, patch);
  const clean = patch.project ? { ...patch, project: absolute(patch.project) } : patch;
  const out = await sync.change({ op: 'update', id, patch: clean });
  return out.queued ? out : findIdea(load(), out.value.id);
}

export async function remove(ids) {
  if (!sync.enabled()) return removeIdeas(ids);
  const out = await sync.change({ op: 'remove', ids });
  return out.queued ? out : out.value;
}

export async function triage(verdicts, { by = null, projects = null } = {}) {
  if (!sync.enabled()) return applyTriage(verdicts, { by, projects });
  const out = await sync.change({ op: 'triage', verdicts, by, projects });
  return out.queued ? out : out.value;
}

/** The text for a change that waits in the outbox. */
export const queuedText = (out) => `The ideamine server does not answer (${out.reason}). The change waits here and goes to the server later.`;
