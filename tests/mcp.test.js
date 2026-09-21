import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-proj-'));
let server;
let nextId = 1;
const pending = new Map();

function request(method, params = {}) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

async function call(name, args = {}) {
  const res = await request('tools/call', { name, arguments: args });
  return { text: res.result.content[0].text, isError: !!res.result.isError };
}

before(async () => {
  const env = {
    ...process.env,
    IDEAMINE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-mcp-')),
    IDEAMINE_CLAUDE_BIN: fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url)),
  };
  server = spawn(process.execPath, [BIN, 'mcp'], { cwd: project, env, stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line); // stdout must carry nothing but JSON-RPC
    pending.get(msg.id)?.(msg);
  });
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ideamine');
  assert.ok(init.result.capabilities.tools);
  assert.ok(init.result.capabilities.prompts);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(() => server.kill());

test('lists the five tools with schemas', async () => {
  const res = await request('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name), ['idea_add', 'idea_list', 'idea_triage', 'idea_update', 'idea_next']);
  for (const t of res.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('full loop: add, triage, next, update', async () => {
  const added = await call('idea_add', { text: '- cache the API responses\n- rename helpers.js to utils.js' });
  assert.match(added.text, /Saved 2 ideas: #1, #2/);

  const work = await call('idea_triage');
  assert.match(work.text, /Ideas to triage \(2\)/);
  assert.match(work.text, /haiku/);
  assert.match(work.text, new RegExp(`project: ${path.basename(project)}`));

  const saved = await call('idea_triage', {
    by: 'test-model',
    verdicts: [
      { id: 1, verdict: 'do', impact: 4, size: 'm', model: 'sonnet', title: 'Cache API responses', why: 'slow pages', brief: 'Add an LRU cache.' },
      { id: 2, verdict: 'do', impact: 2, size: 'xs', model: 'haiku', title: 'Rename helpers.js', why: 'trivial', brief: 'Rename and fix imports.' },
    ],
  });
  assert.match(saved.text, /Saved 2 verdicts: 2 do · 0 maybe · 0 skip/);

  const next = await call('idea_next');
  assert.match(next.text, /^#2 Rename helpers\.js/); // 2/1 value per effort beats 4/3
  assert.match(next.text, /recommended model: haiku/);

  const upd = await call('idea_update', { id: 2, status: 'done', note: 'renamed' });
  assert.match(upd.text, /Updated #2 Rename helpers\.js · done · note added/);

  const board = await call('idea_list');
  assert.match(board.text, /1 open \(1 do\) · 1 done/);
  const one = await call('idea_list', { id: 1 });
  assert.match(one.text, /brief {4}Add an LRU cache\./);
  assert.match(one.text, /triaged .* by test-model/);
});

test('headless triage through the tool, while other requests stay responsive', async () => {
  await call('idea_add', { text: '- idea x\n- idea y' });
  const [triaged, pong] = await Promise.all([call('idea_triage', { headless: true }), request('ping')]);
  assert.deepEqual(pong.result, {});
  assert.match(triaged.text, /Saved 2 verdicts: 2 do · 0 maybe · 0 skip \(sonnet, 321 in \/ 45 out tokens\)/);
  assert.match((await call('idea_triage', { headless: true })).text, /inbox is empty/);
});

test('tool errors come back as isError results, not protocol errors', async () => {
  const res = await call('idea_update', { id: 999, status: 'done' });
  assert.equal(res.isError, true);
  assert.match(res.text, /no idea #999/);
  const unknown = await request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const method = await request('does/not/exist');
  assert.equal(method.error.code, -32601);
});

test('prompts mirror the skills', async () => {
  const list = await request('prompts/list');
  assert.deepEqual(list.result.prompts.map((p) => p.name), ['idea', 'ideas', 'idea-triage', 'idea-go']);
  const got = await request('prompts/get', { name: 'idea', arguments: { text: 'teleport the cat' } });
  const text = got.result.messages[0].content.text;
  assert.match(text, /teleport the cat/);
  assert.doesNotMatch(text, /^---/);
  assert.match(text, /idea_add/);
});
