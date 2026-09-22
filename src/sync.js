// Sync with an ideamine server, so that every Claude on every machine sees one archive. The server
// (`ideamine serve`, for example behind nginx on a WireGuard address) holds the archive, and
// ideas.json on this machine is a copy of it. A change goes into the outbox first and then to the
// server. When the server does not answer, the change waits in the outbox, so no idea is lost. The
// prompt log takes the same way. No process stays alive: the hook calls kick() for each prompt, and
// kick() starts a background sync when work waits or the copy is old.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';
import { stamp } from './render.js';
import { dbPath, home, withLock, writeAtomic } from './store.js';
import { clip } from './text.js';

const PULL_EVERY_MS = 60 * 1000; // a copy older than this is pulled again in the background
const PROMPTS_EVERY_MS = 20 * 1000; // prompts wait at least this long, so that a prompt starts no process each time
const WAIT_AFTER_ERROR_MS = 2 * 60 * 1000; // after a failed sync, before kick() tries again
const LOCK_STALE_MS = 10 * 60 * 1000;
const OPS_PER_REQUEST = 100;
const PROMPT_BYTES_PER_REQUEST = 256 * 1024;
const USAGE_EVERY_MS = 10 * 60 * 1000; // the token use goes to the server at most this often
const USAGE_DAYS = 365; // the rows that go to the server, so that one request stays small
const MAX_PROMPT_CHARS = 100 * 1000; // a longer paste is cut, so that each prompt fits in a request

const outboxPath = () => path.join(home(), 'outbox.jsonl');
const promptsPath = () => path.join(home(), 'prompts-outbox.jsonl');
const statePath = () => path.join(home(), 'sync.json');
const lockPath = () => path.join(home(), '.sync');

/** The server does not answer, or it refuses the request. The change stays in the outbox. */
export class SyncError extends Error {}

/** The address of the server, with a slash at the end, or '' when sync is off. */
export function serverUrl() {
  const url = config.get('sync_url');
  return url ? (url.endsWith('/') ? url : `${url}/`) : '';
}

export const enabled = () => serverUrl() !== '';
export const logsPrompts = () => enabled() && /^(on|true|yes|1)$/i.test(config.get('prompt_log'));

function readLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line that a crash cut in half. The rest of the file is still good.
    }
  }
  return out;
}

const writeLines = (file, items) => writeAtomic(file, items.map((i) => `${JSON.stringify(i)}\n`).join(''));
const append = (file, items) => withLock(() => fs.appendFileSync(file, items.map((i) => `${JSON.stringify(i)}\n`).join('')));
const size = (file) => fs.statSync(file, { throwIfNoEntry: false })?.size || 0;

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

// Call it while you hold the lock.
const saveState = (patch) => writeAtomic(statePath(), `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`);
const writeState = (patch) => withLock(() => saveState(patch));
const failed = (e) => writeState({ error: e.message, errorAt: new Date().toISOString() });

async function request(route, { body, timeoutMs }) {
  const target = new URL(route, serverUrl());
  const init = { signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) Object.assign(init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : e.cause?.code || e.cause?.message || e.message;
    throw new SyncError(`cannot reach ${target.origin} (${why})`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: the error below shows the text.
  }
  if (!res.ok || !json?.ok) throw new SyncError(`${target.origin} answered ${res.status}: ${json?.error || clip(text, 160)}`);
  return json;
}

/** Keep the archive of the server as the copy here, unless the copy is newer: a slow answer must not undo a later one. */
function keep(db) {
  if (!db || !Array.isArray(db.ideas)) throw new SyncError('the server sent no archive');
  withLock(() => {
    const state = readState();
    if (db.uid === state.uid && (Number(db.rev) || 0) < (Number(state.rev) || 0)) return;
    writeAtomic(dbPath(), `${JSON.stringify(db, null, 2)}\n`, { backup: true });
    saveState({ uid: db.uid, rev: db.rev, pulled: new Date().toISOString(), error: null, errorAt: null });
  });
}

/**
 * Send the changes of the outbox, oldest first. `extra` must go even when another process took it
 * from the outbox already: the server applies a change only once, and it answers with the result.
 * Resolves to the results by oid, and to the archive of the server after the last change.
 */
async function sendOps({ extra = null, timeoutMs }) {
  const ops = withLock(() => readLines(outboxPath()));
  if (extra && !ops.some((op) => op.oid === extra.oid)) ops.push(extra);
  const results = new Map();
  let db = null;
  for (let i = 0; i < ops.length; i += OPS_PER_REQUEST) {
    const part = ops.slice(i, i + OPS_PER_REQUEST);
    const out = await request('api/ops', { body: { ops: part }, timeoutMs });
    part.forEach((op, k) => results.set(op.oid, out.results[k]));
    withLock(() => writeLines(outboxPath(), readLines(outboxPath()).filter((op) => !results.has(op.oid))));
    db = out.db;
  }
  return { results, db };
}

async function sendPrompts({ timeoutMs }) {
  const prompts = withLock(() => readLines(promptsPath()));
  let part = [];
  let bytes = 0;
  const sendPart = async () => {
    if (!part.length) return;
    await request('api/prompts', { body: { prompts: part }, timeoutMs });
    const sent = new Set(part.map((p) => p.id));
    withLock(() => writeLines(promptsPath(), readLines(promptsPath()).filter((p) => !sent.has(p.id))));
    part = [];
    bytes = 0;
  };
  for (const p of prompts) {
    const n = Buffer.byteLength(JSON.stringify(p));
    if (bytes + n > PROMPT_BYTES_PER_REQUEST) await sendPart();
    part.push(p);
    bytes += n;
  }
  await sendPart();
}

/** The id of this machine, so that the server keeps the token use of each machine apart. */
export function machineId() {
  const state = readState();
  if (state.machine) return state.machine;
  const machine = crypto.randomUUID();
  writeState({ machine });
  return machine;
}

/**
 * Send the token use of this machine. The server keeps one set of rows for each machine, so the new
 * rows take the place of the rows from before. The scan reads only the new bytes of the transcripts.
 */
async function sendUsage({ timeoutMs }) {
  const state = readState();
  if (Date.now() - Date.parse(state.usageAt || 0) < USAGE_EVERY_MS) return;
  const usage = await import('./usage.js');
  const rows = usage.since(usage.scan().rows, USAGE_DAYS);
  if (!rows.length) return;
  await request('api/usage', { body: { machine: machineId(), host: os.hostname(), rows }, timeoutMs });
  writeState({ usageAt: new Date().toISOString() });
}

/**
 * Bring the copy here up to date: send the changes that wait, then take the archive of the server.
 * With `prompts`, send the prompts and the token use too. Throws SyncError when the server does not
 * answer.
 */
export async function pull({ timeoutMs = 10000, prompts = false } = {}) {
  let { db } = await sendOps({ timeoutMs });
  if (prompts) {
    await sendPrompts({ timeoutMs });
    await sendUsage({ timeoutMs });
  }
  db ||= (await request('api/db', { timeoutMs })).db;
  keep(db);
}

/**
 * Change the archive on the server. The change goes into the outbox, then to the server. Resolves
 * to { value }, the result of the change, or to { queued, reason } when the server does not answer:
 * the change then waits in the outbox. A change that the server refuses throws.
 */
export async function change(op, { timeoutMs = 3000 } = {}) {
  const item = { ...op, oid: crypto.randomUUID(), at: new Date().toISOString() };
  append(outboxPath(), [item]);
  let sent;
  try {
    sent = await sendOps({ extra: item, timeoutMs });
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    failed(e);
    return { queued: true, reason: e.message };
  }
  keep(sent.db);
  const r = sent.results.get(item.oid);
  if (!r?.ok) throw new Error(r?.error || 'the server sent no result');
  return { value: r.value };
}

/** How many changes wait in the outbox. */
export const waiting = () => readLines(outboxPath()).length;

/**
 * The text of a prompt for the log, or null when nothing is left. The notes that Claude Code and the
 * desktop app put into a prompt (<system-reminder> blocks) go, and a huge paste is cut.
 */
function promptText(raw) {
  const text = String(raw ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return null;
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n… (cut: ${text.length - MAX_PROMPT_CHARS} more characters)` : text;
}

/** Put a prompt into the prompt outbox. The next background sync sends it. */
export function logPrompt({ prompt, session = null, cwd = null, at = new Date().toISOString() }) {
  const text = promptText(prompt);
  if (!text) return;
  append(promptsPath(), [{ id: crypto.randomUUID(), at, host: os.hostname(), session, cwd, prompt: text }]);
  if (!readState().promptsSince) writeState({ promptsSince: at });
}

// The text that the user typed, from one line of a Claude Code transcript. Null for everything
// else: tool results, subagent prompts, command output, and notes that Claude Code adds itself.
function typedText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || entry.toolUseResult) return null;
  const content = entry.message?.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.every((b) => b?.type === 'text' || b?.type === 'image')) {
    text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (!text?.trim()) return null;
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${name[1]} ${args ? args[1] : ''}`.trim();
  }
  if (/^(<(local-command-stdout|local-command-stderr|command-message|bash-input|bash-stdout|bash-stderr)>|\[Request interrupted)/.test(text.trim())) return null;
  return text;
}

/** The transcripts folder of Claude Code on this machine. */
export function transcriptsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/**
 * Prompts from the Claude Code transcripts of this machine, for the prompt log. Only prompts from
 * before the live prompt log started are taken, so that no prompt comes twice. An id made from the
 * session, the time, and the text lets the server skip a prompt that an earlier import sent.
 */
export function importPrompts({ dir = transcriptsDir() } = {}) {
  const before = readState().promptsSince || null;
  const found = [];
  let files = [];
  try {
    files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
  } catch {
    return 0;
  }
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, String(file)), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('"user"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const prompt = promptText(typedText(entry));
      if (!prompt || !entry.timestamp || (before && entry.timestamp >= before)) continue;
      const id = crypto.createHash('sha256').update(`${entry.sessionId}\n${entry.timestamp}\n${prompt}`).digest('hex').slice(0, 32);
      found.push({ id, at: entry.timestamp, host: os.hostname(), session: entry.sessionId || null, cwd: entry.cwd || null, prompt });
    }
  }
  if (found.length) append(promptsPath(), found);
  return found.length;
}

function isRunning(now) {
  try {
    return now - fs.statSync(lockPath()).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function startProcess() {
  const bin = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
  const child = spawn(process.execPath, [bin, 'sync', '--background'], { cwd: home(), detached: true, stdio: 'ignore', windowsHide: true });
  // A sync that cannot start must not stop the caller.
  child.on('error', (e) => failed(new Error(`cannot start a sync: ${e.message}`)));
  child.unref();
}

/**
 * Start a background sync when sync is on, no sync runs, no sync failed a short time ago, and
 * changes wait, prompts wait since the last sync 20 seconds ago, or the copy is older than a minute.
 */
export function kick({ start = startProcess, now = Date.now() } = {}) {
  if (!enabled()) return false;
  const state = readState();
  if (state.errorAt && now - Date.parse(state.errorAt) < WAIT_AFTER_ERROR_MS) return false;
  if (isRunning(now)) return false;
  const age = state.pulled ? now - Date.parse(state.pulled) : Infinity;
  const due = age > PULL_EVERY_MS || size(outboxPath()) > 0 || (size(promptsPath()) > 0 && age > PROMPTS_EVERY_MS);
  if (!due) return false;
  start();
  return true;
}

/** One background sync, from kick(). Only one runs at a time. */
export async function backgroundSync() {
  fs.mkdirSync(home(), { recursive: true });
  try {
    fs.mkdirSync(lockPath());
  } catch (e) {
    if (e.code !== 'EEXIST' || isRunning(Date.now())) return 'busy';
    fs.utimesSync(lockPath(), new Date(), new Date()); // take over the lock of a crashed sync
  }
  try {
    await pull({ timeoutMs: 30000, prompts: true });
    return 'done';
  } catch (e) {
    failed(e);
    return 'error';
  } finally {
    fs.rmSync(lockPath(), { recursive: true, force: true });
  }
}

/**
 * Turn sync on with the server at `url`, or off with ''. Before the first sync with a server, the
 * archive here goes to a backup file, because the archive of the server takes its place.
 */
export function setServer(url) {
  const clean = String(url || '').trim();
  if (clean && !/^https?:\/\//i.test(clean)) throw new Error(`"${clean}" is not an http:// or https:// address`);
  let backup = null;
  if (clean && fs.existsSync(dbPath()) && !readState().uid) {
    backup = path.join(home(), `ideas.before-sync-${new Date().toISOString().slice(0, 10)}.json`);
    fs.copyFileSync(dbPath(), backup);
  }
  config.set('sync_url', clean);
  if (clean) config.set('publish_url', ''); // the server shows the live archive: no uploads
  else writeState({ uid: null, rev: null, pulled: null, error: null, errorAt: null });
  return backup;
}

/** On or off, the last sync, and what waits. */
export function status() {
  const url = serverUrl();
  if (!url) return 'ideamine sync: off. The archive is on this machine. /ideas-sync <url> shares it through an ideamine server.';
  const s = readState();
  const lines = [`ideamine sync: ${url}`];
  lines.push(s.pulled ? `last sync ${stamp(s.pulled)}${s.rev ? `, revision ${s.rev}` : ''}.` : 'Not synced yet.');
  const changes = waiting();
  if (changes) lines.push(`${changes} change${changes === 1 ? ' waits' : 's wait'} for the server.`);
  const prompts = readLines(promptsPath()).length;
  if (prompts) lines.push(`${prompts} prompt${prompts === 1 ? ' waits' : 's wait'} for the server.`);
  lines.push(logsPrompts() ? 'The prompt log is on.' : 'The prompt log is off. `ideamine config prompt_log on` turns it on.');
  if (s.error) lines.push(`The last sync failed at ${stamp(s.errorAt)}: ${s.error}`);
  return lines.join('\n');
}
