// The dashboard with buttons. `ideamine serve` runs a web server on this PC. It serves the page of
// `ideamine publish`, a live data.json, and an API for the slash commands: add, delete, done,
// reopen, start, drop, note, model, triage, build, ask, and the watcher. The archive and the Claude
// Code login are on this PC, so the commands run here. The server listens on 127.0.0.1 only, and
// it takes commands only from its own page.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';
import * as publish from './publish.js';
import { renderAdded, stamp } from './render.js';
import * as store from './store.js';
import { clip, splitIdeas } from './text.js';
import * as watch from './watch.js';

const PAGE = new URL('../dashboard/index.html', import.meta.url);
const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
const MAX_BODY = 1024 * 1024;
const EMBED_TIMEOUT_MS = 5000; // data.json must not wait long for an embedding server that is away
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const logPath = () => path.join(store.home(), 'serve.log');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The port from the setting serve_port. */
export function port() {
  const value = config.get('serve_port');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`serve_port must be a whole number from 1 to 65535, not "${value}"`);
  return n;
}

export const address = (p = port()) => `http://127.0.0.1:${p}/`;

/**
 * True when the server may answer a request. The Host header must name this server, which stops a
 * DNS rebinding page. A POST must send JSON, and its Origin, if any, must be this server. A page of
 * another site cannot send JSON here without a CORS preflight, and this server allows none.
 */
export function allowed({ method, host, origin, type }, port) {
  const h = String(host ?? '').toLowerCase();
  if (h !== `127.0.0.1:${port}` && h !== `localhost:${port}`) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method !== 'POST' || !/^application\/json\s*(;|$)/i.test(String(type ?? '').trim())) return false;
  return origin == null || origin === `http://${h}`;
}

/**
 * Run `node <args>` in a new console window, so that Claude Code gets a terminal. Windows only.
 * `start` opens the window. A Windows path cannot hold a quote, so quotes around each argument
 * keep cmd.exe from reading a & or | in a path. IDEAMINE_WINDOW keeps the window open after an error.
 */
export function openWindow(args, cwd) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error(`the page can open a terminal only on Windows. Run in a terminal: ideamine ${args.slice(1).join(' ')}`));
  }
  const line = ['start', '""', ...[process.execPath, ...args].map((a) => `"${a}"`)].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', line], {
      cwd,
      env: { ...process.env, IDEAMINE_WINDOW: '1' },
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function send(res, status, json, headers = {}) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(json));
}

function sendPage(res) {
  res.writeHead(200, {
    ...HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "frame-ancestors 'none'", // no other page can frame the buttons
  });
  res.end(fs.readFileSync(PAGE));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('the request is too big'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = (await readBody(req)).toString('utf8');
  let body;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error('the request is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('the request must be a JSON object');
  return body;
}

/** The snapshot of `ideamine publish`, and `live`: what only this server can tell the page. */
async function liveData() {
  const { data, note } = await publish.build(store.load(), { timeoutMs: EMBED_TIMEOUT_MS });
  const w = watch.readState();
  return { ...data, live: { note, window: process.platform === 'win32', watch: { on: !!w.on, status: watch.status() } } };
}

/** Search by meaning on the page: the page sends its query to the embedding server through here. */
async function proxyEmbeddings(req, res) {
  const endpoint = `${config.get('embed_url').replace(/\/+$/, '')}/embeddings`;
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await readBody(req),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return send(res, 502, { ok: false, error: `cannot reach ${endpoint}` });
  }
  res.writeHead(upstream.status, { ...HEADERS, 'content-type': upstream.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

// The slash commands. Each one takes the JSON body and returns the text to show on the page.
const ACTIONS = {
  /** /idea. A bulleted list adds one idea per bullet. */
  add({ text }) {
    const results = store.addIdeas(splitIdeas(String(text ?? '')), { source: 'web' });
    return renderAdded(results, store.load());
  },

  /** /ideas-rm. An unknown id deletes nothing. */
  rm({ ids }) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('name the ideas to delete');
    return store.removeIdeas(ids).map((i) => `Removed #${i.id} · ${clip(i.title, 60)}`).join('\n');
  },

  /** /ideas-done, /ideas-reopen, and the verbs start, drop, note, and model of the CLI. */
  update({ id, status, note, model }) {
    if (!status && !note && !model) throw new Error('nothing to change');
    const idea = store.updateIdea(id, { status, note, model });
    const bits = [`#${idea.id} ${clip(idea.title, 60)} → ${store.lane(idea)}`];
    if (model) bits.push(`model ${idea.triage.model}`);
    if (note) bits.push('note added');
    return `✓ ${bits.join(' · ')}`;
  },

  /** /ideas-sort */
  async sort() {
    const { headlessTriage } = await import('./claude.js');
    const { headlessSummary } = await import('./mcp.js');
    return headlessSummary(await headlessTriage());
  },

  /**
   * /ideas-go [N]. New ideas are triaged first. Then a new window runs `ideamine go N`: Claude Code
   * on the recommended model, in the project of the idea.
   */
  async go({ id }, { open }) {
    const { goPlan, triageFirst } = await import('./claude.js');
    const { headlessSummary } = await import('./mcp.js');
    const lines = [];
    try {
      const triaged = await triageFirst({ id: id ?? null });
      if (triaged) lines.push(headlessSummary(triaged));
    } catch (e) {
      lines.push(`Triage failed: ${e.message}`);
    }
    const db = store.load();
    const idea = id != null ? store.findIdea(db, id) : store.pickNext(db);
    if (!idea) throw new Error(id != null ? `no idea #${id}` : 'Nothing is ready to build. Triage the inbox first.');
    const { model, dir } = goPlan(idea, os.homedir());
    await open([BIN, 'go', String(idea.id)], dir);
    store.updateIdea(idea.id, { status: 'doing' });
    lines.push(`Opened Claude Code (${model}) in ${dir} for #${idea.id} · ${clip(idea.title, 60)}`);
    return lines.join('\n\n');
  },

  /** /ideas <question> */
  async ask({ question }) {
    const q = String(question ?? '').trim();
    if (!q) throw new Error('ask a question');
    const { askAboutIdeas } = await import('./claude.js');
    return (await askAboutIdeas(q)).answer || 'Claude gave no answer.';
  },

  /** /ideas-watch [off] */
  watch({ on }) {
    if (on) {
      watch.turnOn();
      watch.kick();
    } else watch.turnOff();
    return watch.status();
  },
};

// These actions do not change the archive, so the dashboard server needs no new upload.
const READ_ONLY = new Set(['ask', 'watch']);

async function handle(req, res, ctx) {
  if (!allowed({ method: req.method, host: req.headers.host, origin: req.headers.origin, type: req.headers['content-type'] }, ctx.port)) {
    return send(res, 403, { ok: false, error: 'forbidden' });
  }
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = `${req.method === 'HEAD' ? 'GET' : req.method} ${pathname}`;
  if (route === 'GET /' || route === 'GET /index.html') return sendPage(res);
  if (route === 'GET /data.json') return send(res, 200, await liveData());
  // A ping gets a new connection each time, so it never reaches a server that stops on an old one.
  if (route === 'GET /api/ping') return send(res, 200, { ok: true, app: 'ideamine' }, { connection: 'close' });
  if (route === 'POST /v1/embeddings') return proxyEmbeddings(req, res);
  if (route === 'POST /api/stop') {
    // After "stopped", no kept-alive connection may answer a request.
    res.on('finish', () => ctx.server.closeAllConnections?.());
    send(res, 200, { ok: true, message: 'stopped' }, { connection: 'close' });
    ctx.server.close();
    return;
  }
  const action = route.startsWith('POST /api/') ? route.slice('POST /api/'.length) : '';
  if (!Object.hasOwn(ACTIONS, action)) return send(res, 404, { ok: false, error: 'not found' });
  try {
    const message = await ACTIONS[action](await readJson(req), ctx);
    ctx.log(`${action}: ok`);
    if (!READ_ONLY.has(action)) {
      try {
        ctx.afterChange();
      } catch {
        // The upload to the dashboard server must never fail a command.
      }
    }
    return send(res, 200, { ok: true, message });
  } catch (e) {
    ctx.log(`${action}: ${e.message}`);
    return send(res, 400, { ok: false, error: e.message });
  }
}

/**
 * The server, not listening yet. `open` opens the window for a build, `afterChange` runs after a
 * command changes the archive (by default it uploads the dashboard again), and `log` gets a line
 * for each command.
 */
export function createServer({ open = openWindow, afterChange = publish.kick, log = () => {} } = {}) {
  const ctx = { open, afterChange, log, port: null };
  ctx.server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    });
  });
  ctx.server.on('listening', () => (ctx.port = ctx.server.address().port));
  return ctx.server;
}

/** Listen on 127.0.0.1. Resolves to { server, url }. */
export function start({ port: p = port(), ...options } = {}) {
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => resolve({ server, url: address(server.address().port) }));
  });
}

/** True when an ideamine server answers at `url`. */
async function ping(url) {
  try {
    const res = await fetch(new URL('api/ping', url), { signal: AbortSignal.timeout(1000) });
    return res.ok && (await res.json()).app === 'ideamine';
  } catch {
    return false;
  }
}

/** Start `ideamine serve` in the background. Its output goes to serve.log, and so does a failed start. */
function startProcess() {
  fs.mkdirSync(store.home(), { recursive: true });
  const log = fs.openSync(logPath(), 'a');
  try {
    const child = spawn(process.execPath, [BIN, 'serve'], { cwd: store.home(), detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', (e) => fs.appendFileSync(logPath(), `${logLine(`cannot start: ${e.message}`)}\n`));
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

/** /ideas-web: start the server when it does not run. Resolves to the text for the user. */
export async function ensureRunning({ startServer = startProcess, waitMs = 5000 } = {}) {
  const url = address();
  if (await ping(url)) return `ideamine web: ${url}`;
  startServer();
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
    await sleep(150);
    if (await ping(url)) return `ideamine web: ${url} (started)`;
  }
  return `ideamine web did not start at ${url}. The reason is in ${logPath()}.`;
}

/** /ideas-web off */
export async function stopRunning() {
  const url = address();
  if (!(await ping(url))) return 'ideamine web: not running.';
  try {
    await fetch(new URL('api/stop', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  } catch {
    // The server can close the connection before its answer arrives. The ping below tells the result.
  }
  return (await ping(url)) ? `ideamine web: still running at ${url}` : 'ideamine web: stopped.';
}

/** A line for serve.log: the time and the text. */
export const logLine = (text) => `${stamp(new Date().toISOString())}  ${text}`;
