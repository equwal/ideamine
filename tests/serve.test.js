import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { handlePrompt } from '../src/hook.js';
import * as serve from '../src/serve.js';
import * as store from '../src/store.js';
import { startFakeServer } from './fixtures/fake-server.js';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));

let server; // the server under test
let url;
let embedServer;
let opened; // the windows that /api/go asked for
let changes; // how often a command asked for a new upload of the dashboard

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-serve-'));
  // The triage and the questions must never reach the real claude or the projects of this machine.
  process.env.IDEAMINE_CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
  process.env.CLAUDE_CONFIG_DIR = process.env.IDEAMINE_HOME;
  embedServer = await startFakeServer();
  process.env.IDEAMINE_EMBED_URL = `${embedServer.url}/v1`;
  opened = [];
  changes = 0;
  ({ server, url } = await serve.start({
    port: 0,
    open: async (args, cwd) => opened.push({ args, cwd }),
    afterChange: () => changes++,
  }));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await embedServer.close();
  delete process.env.IDEAMINE_EMBED_URL;
});

/** POST to the server under test the way the page does. */
async function api(action, body = {}, headers = {}) {
  const res = await fetch(new URL(`api/${action}`, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

/** A raw request, so a test can send any Host header. */
function raw(method, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, url), { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('only this page may use the server: a property over hosts, origins, and content types', () => {
  const port = 4332;
  const post = (h) => ({ method: 'POST', type: 'application/json', ...h });
  fc.assert(
    fc.property(fc.string(), (host) => {
      const own = ['127.0.0.1:4332', 'localhost:4332'].includes(host.toLowerCase());
      assert.equal(serve.allowed({ method: 'GET', host }, port), own);
      assert.equal(serve.allowed(post({ host }), port), own);
    }),
  );
  const origins = fc.oneof(fc.string(), fc.webUrl(), fc.constantFrom('null', 'http://127.0.0.1:4333', 'https://127.0.0.1:4332', 'http://localhost:4332/'));
  fc.assert(
    fc.property(origins, (origin) => {
      fc.pre(origin !== 'http://127.0.0.1:4332');
      assert.equal(serve.allowed(post({ host: '127.0.0.1:4332', origin }), port), false);
    }),
  );
  fc.assert(
    fc.property(fc.string(), (type) => {
      fc.pre(!/^\s*application\/json\s*(;|$)/i.test(type));
      assert.equal(serve.allowed(post({ host: '127.0.0.1:4332', type }), port), false);
    }),
  );
  assert.equal(serve.allowed(post({ host: '127.0.0.1:4332', origin: 'http://127.0.0.1:4332', type: 'application/json; charset=utf-8' }), port), true);
  assert.equal(serve.allowed(post({ host: '127.0.0.1:4332' }), port), true); // no Origin: a program on this PC
  for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) assert.equal(serve.allowed({ method, host: '127.0.0.1:4332' }, port), false);
});

test('requests from other pages change nothing', async () => {
  const text = await fetch(new URL('api/add', url), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"text":"x"}' });
  assert.equal(text.status, 403); // a form or a no-cors fetch of another page
  assert.equal((await api('add', { text: 'x' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw('GET', '/data.json', { host: `evil.example:${server.address().port}` })).statusCode, 403); // DNS rebinding
  const preflight = await raw('OPTIONS', '/api/add', { origin: 'http://evil.example', 'access-control-request-method': 'POST' });
  assert.equal(preflight.statusCode, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal(store.load().ideas.length, 0);
  assert.equal(changes, 0);
  assert.equal((await api('nope')).status, 404);
  assert.equal((await api('add', 'not json')).error, 'the request is not valid JSON');
});

test('the page comes with live data, and no other page can frame it', async () => {
  store.addIdeas(['alpha']);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /id="actions"/);
  const data = await (await fetch(new URL('data.json', url))).json();
  assert.equal(data.version, 1);
  assert.equal(data.ideas[0].key, 'IDEA-1');
  assert.deepEqual(data.live, { note: '', window: process.platform === 'win32', watch: { on: false, status: data.live.watch.status } });
  assert.match(data.live.watch.status, /^ideamine watch: off/);
});

test('add, update, and rm do what /idea, /ideas-done, /ideas-reopen, and /ideas-rm do', async () => {
  const added = await api('add', { text: '- alpha #web\n- beta' });
  assert.match(added.message, /Saved 2 ideas: #1, #2/);
  const [alpha] = store.load().ideas;
  assert.deepEqual([alpha.source, alpha.tags, alpha.project], ['web', ['web'], null]);

  assert.equal((await api('update', { id: 1, status: 'done', note: 'shipped' })).message, '✓ #1 alpha → done · note added');
  assert.deepEqual(store.findIdea(store.load(), 1).notes.map((n) => n.text), ['shipped']);
  assert.equal((await api('update', { id: 1, status: 'reopen' })).message, '✓ #1 alpha → inbox');
  assert.equal((await api('update', { id: 2, status: 'doing' })).message, '✓ #2 beta → doing');
  assert.ok(store.findIdea(store.load(), 2).started);
  assert.equal((await api('update', { id: 2, model: 'opus' })).message, '✓ #2 beta → doing · model opus');
  assert.equal((await api('update', { id: 2, status: 'dropped' })).message, '✓ #2 beta → dropped');
  assert.equal((await api('update', { id: 2 })).error, 'nothing to change');

  const missing = await api('rm', { ids: [1, 9] });
  assert.deepEqual([missing.status, missing.error], [400, 'no idea #9']);
  assert.equal(store.load().ideas.length, 2); // an unknown id deletes nothing
  assert.equal((await api('rm', { ids: [1] })).message, 'Removed #1 · alpha');
  assert.deepEqual(store.load().ideas.map((i) => i.id), [2]);
  assert.equal(changes, 7); // each command that changed the archive, and no failed one
});

test('sort triages the inbox with one headless call, like /ideas-sort', async () => {
  await api('add', { text: '- alpha\n- beta' });
  const out = await api('sort');
  assert.match(out.message, /^Saved 2 verdicts: 2 do · 0 maybe · 0 skip/);
  assert.ok(store.load().ideas.every((i) => i.status === 'triaged'));
  assert.equal((await api('sort')).message, 'Nothing to triage: the inbox is empty.');
});

test('go triages a new idea, then opens a window that runs `ideamine go N` in the project', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-project-'));
  store.addIdeas(['alpha'], { project });
  store.addIdeas(['beta'], { project: path.join(project, 'gone') });
  const out = await api('go', { id: 1 });
  assert.match(out.message, /^Saved 1 verdict: 1 do[\s\S]*\n\nOpened Claude Code \(sonnet\) in .* for #1 · Idea 1$/);
  assert.deepEqual(opened, [{ args: [BIN, 'go', '1'], cwd: project }]);
  assert.equal(store.findIdea(store.load(), 1).status, 'doing');

  // A folder that is gone: the build starts in the home folder. Without an id: the first in the queue.
  await api('go');
  assert.deepEqual(opened[1], { args: [BIN, 'go', '2'], cwd: os.homedir() });
  const none = await api('go');
  assert.deepEqual([none.status, none.error], [400, 'Nothing is ready to build. Triage the inbox first.']);
});

test('a window that cannot open changes nothing', async () => {
  await new Promise((resolve) => server.close(resolve));
  ({ server, url } = await serve.start({ port: 0, open: async () => { throw new Error('no terminal'); }, afterChange: () => changes++ }));
  store.addIdeas(['alpha']);
  store.applyTriage([{ id: 1, verdict: 'do', impact: 3, size: 's', model: 'haiku', brief: 'b' }]);
  const out = await api('go', { id: 1 });
  assert.deepEqual([out.status, out.error], [400, 'no terminal']);
  assert.equal(store.findIdea(store.load(), 1).status, 'triaged');
});

test('ask answers a question about the ideas with one headless call, like /ideas <question>', async () => {
  await api('add', { text: 'alpha' });
  const before = changes;
  assert.equal((await api('ask', { question: 'which first?' })).message, '#1 fits "which first?".');
  assert.equal((await api('ask', { question: ' ' })).error, 'ask a question');
  assert.equal(changes, before); // a question changes nothing
});

test('watch turns the watcher on and off, like /ideas-watch', async () => {
  assert.match((await api('watch', { on: true })).message, /^ideamine watch: on since /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.home(), 'watch.json'), 'utf8')).on, true);
  assert.match((await api('watch', { on: false })).message, /^ideamine watch: off/);
});

test('search by meaning on the page goes through the server to the embedding server', async () => {
  const res = await fetch(new URL('v1/embeddings', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: ['search_query: subtitles'] }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data[0].embedding.length, 64);
  assert.deepEqual(embedServer.inputs, ['search_query: subtitles']);
});

test('serve_port must be a port number', () => {
  process.env.IDEAMINE_SERVE_PORT = 'abc';
  try {
    assert.throws(() => serve.port(), /serve_port must be a whole number from 1 to 65535/);
  } finally {
    delete process.env.IDEAMINE_SERVE_PORT;
  }
  assert.equal(serve.port(), 4332);
});

/** A port that nothing listens on. */
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

test('/ideas-web starts the server in the background, and /ideas-web off stops it', async () => {
  process.env.IDEAMINE_SERVE_PORT = String(await freePort());
  const address = `http://127.0.0.1:${process.env.IDEAMINE_SERVE_PORT}/`;
  try {
    // Several rounds, because a stopped server once went on to answer on a kept-alive connection:
    // the next /ideas-web then said "running" and started nothing.
    for (let round = 0; round < 3; round++) {
      assert.equal(await handlePrompt('/ideas-web'), `ideamine web: ${address} (started)`);
      assert.equal(await handlePrompt('/ideamine:ideas-web'), `ideamine web: ${address}`);
      assert.equal((await fetch(new URL('data.json', address))).status, 200);
      assert.equal(await handlePrompt('/ideas-web off'), 'ideamine web: stopped.');
      assert.equal(await handlePrompt('/ideas-web off'), 'ideamine web: not running.');
    }
    assert.match(fs.readFileSync(path.join(store.home(), 'serve.log'), 'utf8'), /the dashboard with buttons runs at /);
    assert.equal(await handlePrompt('/ideas-web something else'), null); // not a command: the skill answers
  } finally {
    await serve.stopRunning(); // never leave a server behind
    delete process.env.IDEAMINE_SERVE_PORT;
  }
});

test('/ideas-web says why the server did not start', async () => {
  process.env.IDEAMINE_SERVE_PORT = String(await freePort());
  const node = process.execPath;
  process.execPath = path.join(store.home(), 'no-such-node');
  try {
    assert.match(await serve.ensureRunning({ waitMs: 300 }), /^ideamine web did not start at .*\. The reason is in .*serve\.log\.$/);
  } finally {
    process.execPath = node;
    delete process.env.IDEAMINE_SERVE_PORT;
  }
  assert.match(fs.readFileSync(path.join(store.home(), 'serve.log'), 'utf8'), /cannot start: .*ENOENT/);
});

test('a window that failed waits for a key only when a person can press one', () => {
  // IDEAMINE_WINDOW comes from the window of the page. Without a terminal, the error must not wait.
  const r = spawnSync(process.execPath, [BIN, 'cat', '9'], { encoding: 'utf8', env: { ...process.env, IDEAMINE_WINDOW: '1' }, timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no idea #9/);
});
