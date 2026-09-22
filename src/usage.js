// Token use and price for each project. Claude Code writes one JSONL transcript for each session in
// ~/.claude/projects. Each answer of the model carries its model name and its token counts, and each
// line carries the folder of the session. This module adds those numbers up for each day, project,
// and model, and it puts a price on them.
//
// The scan is incremental: usage-scan.json keeps the size of each transcript that it read, so a new
// scan reads only the new bytes. `ideamine usage` prints the table, and the dashboard shows it.
//
// The price is the price of the API. A Claude subscription does not bill for each token, so for a
// subscription the number is what the same work would cost through the API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';

/**
 * Price in dollars for each million tokens (2026-09-22). `read` is the price of a cache read.
 * A cache write costs 1.25 times the input price with the 5-minute lifetime, and 2 times with the
 * 1-hour lifetime.
 */
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, read: 1 },
  'claude-mythos-5': { input: 10, output: 50, read: 1 },
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, read: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1 },
};

const MILLION = 1e6;
const WRITE_5M = 1.25; // times the input price
const WRITE_1H = 2;

const statePath = () => path.join(store.home(), 'usage-scan.json');

/** The name of the model without the date at its end, for example claude-haiku-4-5-20251001. */
export function modelName(raw) {
  return String(raw || '')
    .trim()
    .replace(/-\d{8}$/, '');
}

/** The price of one row in dollars. An unknown model costs 0, and `priced` says so. */
export function cost(row) {
  const p = PRICES[modelName(row.model)];
  if (!p) return 0;
  const write = (row.write5m || 0) * p.input * WRITE_5M + (row.write1h || 0) * p.input * WRITE_1H;
  return ((row.input || 0) * p.input + (row.output || 0) * p.output + (row.read || 0) * p.read + write) / MILLION;
}

/** True when the price list knows this model. */
export const priced = (model) => Boolean(PRICES[modelName(model)]);

const rowKey = (r) => `${r.day}|${r.project}|${r.model}`;
const emptyRow = (day, project, model) => ({ day, project, model, messages: 0, input: 0, output: 0, read: 0, write5m: 0, write1h: 0 });

/**
 * Add the numbers of one transcript line to `rows`. A line without token counts, or from a model
 * that answered nothing, changes nothing.
 */
export function addLine(rows, entry, seen) {
  const usage = entry?.message?.usage;
  if (!usage || entry.type !== 'assistant') return false;
  const model = modelName(entry.message.model);
  if (!model || model === '<synthetic>') return false;
  const id = entry.message.id;
  if (id && seen) {
    if (seen.has(id)) return false; // the same answer twice in one file
    seen.add(id);
  }
  const day = String(entry.timestamp || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const project = entry.cwd || 'unknown';
  const key = `${day}|${project}|${model}`;
  const row = rows.get(key) || emptyRow(day, project, model);
  const created = usage.cache_creation || {};
  row.messages += 1;
  row.input += usage.input_tokens || 0;
  row.output += usage.output_tokens || 0;
  row.read += usage.cache_read_input_tokens || 0;
  // Older transcripts have only the total of the cache writes. Those count as the 5-minute price.
  const w1h = created.ephemeral_1h_input_tokens || 0;
  const w5m = created.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens || 0) - w1h);
  row.write5m += w5m;
  row.write1h += w1h;
  rows.set(key, row);
  return true;
}

/** Read one transcript from byte `from` to its end, and add its lines to `rows`. */
function readFile(file, from, rows) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return size;
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    // A read that starts inside a line drops that half line, and the next scan gets the whole file.
    const seen = new Set();
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        addLine(rows, JSON.parse(line), seen);
      } catch {
        // A line that a crash cut in half, or a line that is not JSON.
      }
    }
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (state && state.version === 1) return state;
  } catch {
    // No scan yet, or a file that another version wrote.
  }
  return { version: 1, files: {}, rows: [] };
}

function writeState(state) {
  fs.mkdirSync(store.home(), { recursive: true });
  store.writeAtomic(statePath(), `${JSON.stringify(state)}\n`);
}

/** The folder with the transcripts of Claude Code, the same one that the prompt log reads. */
export const transcriptsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

/**
 * Read the new bytes of each transcript, add them to the numbers from before, and save the state.
 * Resolves to { rows, files, read }: the rows for each day, project, and model, how many transcripts
 * there are, and how many of them had new bytes.
 */
export function scan({ dir = transcriptsDir() } = {}) {
  const state = readState();
  const rows = new Map(state.rows.map((r) => [rowKey(r), r]));
  let files = [];
  try {
    files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
  } catch {
    return { rows: [...rows.values()], files: 0, read: 0 };
  }
  let read = 0;
  for (const name of files) {
    const file = path.join(dir, String(name));
    const from = state.files[String(name)] || 0;
    let size;
    try {
      size = readFile(file, from, rows);
    } catch {
      continue; // a file that another process writes, or that is gone
    }
    if (size !== from) read += 1;
    state.files[String(name)] = size;
  }
  state.rows = [...rows.values()];
  writeState(state);
  return { rows: state.rows, files: files.length, read };
}

/** The rows of the last `days` days, newest day first. 0 days means every day. */
export function since(rows, days) {
  if (!days) return rows;
  const day = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return rows.filter((r) => r.day >= day);
}

/** One row for each project: the tokens, the price, and the price for each model. */
export function byProject(rows) {
  const out = new Map();
  for (const r of rows) {
    const p = out.get(r.project) || { project: r.project, messages: 0, input: 0, output: 0, read: 0, write5m: 0, write1h: 0, cost: 0, models: {} };
    for (const k of ['messages', 'input', 'output', 'read', 'write5m', 'write1h']) p[k] += r[k] || 0;
    const m = p.models[r.model] || { model: r.model, messages: 0, input: 0, output: 0, read: 0, write5m: 0, write1h: 0, cost: 0 };
    for (const k of ['messages', 'input', 'output', 'read', 'write5m', 'write1h']) m[k] += r[k] || 0;
    m.cost += cost(r);
    p.models[r.model] = m;
    p.cost += cost(r);
    out.set(r.project, p);
  }
  return [...out.values()].sort((a, b) => b.cost - a.cost);
}
