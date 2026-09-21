// The watcher: the cheapest model triages new ideas and pairs each one with its project, in the
// background. No process stays alive between passes, because a process like that can stop (a
// crash, a reboot, a full context, a usage limit). Instead, the UserPromptSubmit hook calls kick()
// for each prompt, and kick() starts a pass when there is work. Thus the watcher goes on while it
// is on, and it costs nothing while no new ideas come in.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stamp } from './render.js';
import { home, lane, load } from './store.js';

const MODEL = 'haiku';
const RETRY_WAITS_MS = [30 * 1000, 2 * 60 * 1000]; // after a failed call, in the same pass
const WAIT_AFTER_ERROR_MS = 10 * 60 * 1000; // after a failed pass, before kick() starts a new one
const LOCK_STALE_MS = 30 * 60 * 1000; // a pass is much shorter: an older lock is from a crashed pass
const MAX_ROUNDS = 5; // triage calls in one pass, 20 ideas each
const LOG_LINES = 200;

const statePath = () => path.join(home(), 'watch.json');
const logPath = () => path.join(home(), 'watch.log');
const lockPath = () => path.join(home(), '.watch');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { on: false };
  }
}

function writeState(patch) {
  fs.mkdirSync(home(), { recursive: true });
  const state = { ...readState(), ...patch };
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n');
  return state;
}

export function turnOn() {
  const state = readState();
  return state.on ? state : writeState({ on: true, since: new Date().toISOString(), error: null, errorAt: null });
}

export function turnOff() {
  return writeState({ on: false });
}

/** Ids that the watcher must triage: the inbox, and open ideas that were triaged before pairing. */
export function pendingWork(db) {
  return db.ideas.filter((i) => lane(i) === 'inbox' || (['do', 'maybe'].includes(lane(i)) && !i.triage?.paired)).map((i) => i.id);
}

function isRunning(now) {
  try {
    return now - fs.statSync(lockPath()).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Run a pass in a separate process, which goes on after the caller (the hook) exits. */
function startPassProcess() {
  const bin = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
  spawn(process.execPath, [bin, 'watch-pass'], { cwd: home(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Start a pass if the watcher is on, there is work, no pass runs, and no pass failed a short time ago. */
export function kick({ startPass = startPassProcess, now = Date.now() } = {}) {
  const state = readState();
  if (!state.on) return false;
  if (state.errorAt && now - Date.parse(state.errorAt) < WAIT_AFTER_ERROR_MS) return false;
  if (isRunning(now) || !pendingWork(load()).length) return false;
  startPass();
  return true;
}

function readLog() {
  try {
    return fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function log(text) {
  const lines = [...readLog(), `${stamp(new Date().toISOString())}  ${text}`];
  fs.writeFileSync(logPath(), lines.slice(-LOG_LINES).join('\n') + '\n');
}

function describe(out) {
  const ok = out.results.filter((r) => !r.error);
  const moved = ok.filter((r) => r.moved).map((r) => `#${r.id} → ${path.basename(r.moved)}`);
  const tokens = `${out.tokens.input} in / ${out.tokens.output} out tokens`;
  return `triaged ${ok.map((r) => `#${r.id}`).join(' ')} (${out.model}, ${tokens})${moved.length ? ` · paired ${moved.join(', ')}` : ''}`;
}

async function withRetries(fn, retries) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)]);
    }
  }
}

/** One pass: triage and pair all pending ideas with the cheapest model. Only one pass runs at a time. */
export async function pass({ model = MODEL, retries = RETRY_WAITS_MS.length } = {}) {
  fs.mkdirSync(home(), { recursive: true });
  try {
    fs.mkdirSync(lockPath());
  } catch (e) {
    if (e.code !== 'EEXIST' || isRunning(Date.now())) return 'busy';
    fs.utimesSync(lockPath(), new Date(), new Date()); // take over the lock of a crashed pass
  }
  try {
    // Loaded here, not at the top: the hook imports this module for each prompt.
    const { headlessTriage } = await import('./claude.js');
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const ids = pendingWork(load()).slice(0, 20);
      if (!ids.length) break;
      const out = await withRetries(() => headlessTriage({ model, ids }), retries);
      if (out.message) break; // the ideas were deleted in the meantime
      log(describe(out));
      // An idea that the triage cannot sort must not start a new pass for each prompt.
      const stuck = pendingWork(load()).filter((id) => ids.includes(id));
      if (stuck.length) throw new Error(`the triage did not sort ${stuck.map((id) => `#${id}`).join(' ')}`);
    }
    writeState({ lastPass: new Date().toISOString(), error: null, errorAt: null });
    return 'done';
  } catch (e) {
    log(`error: ${e.message}`);
    writeState({ error: e.message, errorAt: new Date().toISOString() });
    return 'error';
  } finally {
    fs.rmSync(lockPath(), { recursive: true, force: true });
  }
}

/** On or off, what waits, and the last passes. */
export function status() {
  const state = readState();
  if (!state.on) return 'ideamine watch: off. /ideas-watch turns it on.';
  const waiting = pendingWork(load()).length;
  const lines = [`ideamine watch: on since ${stamp(state.since)}. ${MODEL} triages new ideas and pairs each one with its project.`];
  lines.push(waiting ? `${waiting} idea${waiting === 1 ? ' waits' : 's wait'} for the watcher.` : 'No idea waits.');
  if (isRunning(Date.now())) lines.push('A pass runs now.');
  if (state.error) lines.push(`The last pass failed: ${state.error}. The watcher tries again 10 minutes after the failure.`);
  const recent = readLog().slice(-5);
  if (recent.length) lines.push('last passes:', ...recent.map((line) => `  ${line}`));
  lines.push('/ideas-watch off turns it off.');
  return lines.join('\n');
}
