import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { headlessTriage } from '../src/claude.js';
import * as store from '../src/store.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
let log;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-triage-'));
  process.env.IDEAMINE_HOME = dir;
  process.env.IDEAMINE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_LOG = log = path.join(dir, 'call.json');
});

test('headless triage runs one minimal claude -p call and saves every verdict', async () => {
  store.addIdeas(['cache responses', 'rename helpers', 'nft thing'], { project: '/p' });
  // Pretend we are inside a desktop-app session at max effort.
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_EFFORT = 'max';
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = '\\\\.\\pipe\\x';
  const out = await headlessTriage();
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;

  assert.equal(out.results.length, 3);
  assert.deepEqual(out.tokens, { input: 321, output: 45 });
  const db = store.load();
  assert.deepEqual(db.ideas.map((i) => store.lane(i)), ['do', 'do', 'skip']);
  assert.equal(store.findIdea(db, 2).triage.model, 'haiku');
  assert.equal(store.findIdea(db, 1).triage.by, 'sonnet (headless)');

  const call = JSON.parse(fs.readFileSync(log, 'utf8'));
  const flag = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(call.args[0], '-p');
  assert.equal(flag('--model'), 'sonnet');
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--effort'), 'low');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.ok(JSON.parse(flag('--json-schema')).properties.verdicts);
  // The child is an independent session: no nesting marker, no inherited effort or host socket.
  assert.deepEqual(call.env, { CLAUDECODE: null, CLAUDE_EFFORT: null, CLAUDE_CODE_MESSAGING_SOCKET: null, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null });
  assert.match(call.input, /Ideas to triage \(3\)/);
});

test('haiku gets no effort flag, and an empty inbox makes no call', async () => {
  assert.equal((await headlessTriage()).message, 'Nothing to triage: the inbox is empty.');
  assert.ok(!fs.existsSync(log));
  store.addIdeas(['one']);
  await headlessTriage({ model: 'claude-haiku-4-5' });
  const call = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'haiku');
  assert.ok(!call.args.includes('--effort'));
});

test('a missing CLI gives a clear error', async () => {
  store.addIdeas(['one']);
  process.env.IDEAMINE_CLAUDE_BIN = path.join(os.tmpdir(), 'definitely-not-claude-xyz');
  await assert.rejects(headlessTriage(), /Claude Code CLI not found/);
  assert.equal(store.load().ideas[0].status, 'inbox');
});
