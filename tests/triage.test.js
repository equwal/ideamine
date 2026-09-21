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
  process.env.CLAUDE_CONFIG_DIR = dir; // no .claude.json: the projects of this machine stay out of the tests
  process.env.FAKE_CLAUDE_LOG = log = path.join(dir, 'call.json');
});

test('the triage pairs each idea with the project that it is about', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-pair-'));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  const chat = path.join(root, 'scratch-workspaces', 'chat1'); // where the user saved the ideas
  for (const d of [alpha, beta, chat]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(alpha, 'README.md'), '# Alpha: a scroller extension\n');
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ projects: { [alpha]: {}, [beta]: {} } }));
  process.env.CLAUDE_CONFIG_DIR = root;

  store.addIdeas(['make alpha scroll faster', 'beta needs a logo', 'a brand new app'], { project: chat });
  await headlessTriage({ model: 'haiku' });
  const db = store.load();
  assert.equal(store.findIdea(db, 1).project, alpha);
  assert.equal(store.findIdea(db, 2).project, beta);
  assert.equal(store.findIdea(db, 3).project, chat); // no project fits: the idea stays where it was saved
  assert.match(store.findIdea(db, 1).notes[0].text, /^paired with .*alpha \(was .*chat1\)$/);
  assert.ok(db.ideas.every((i) => i.triage.paired));
  const { input } = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.match(input, /- project: /);
  assert.ok(input.includes(`Projects on this machine:\nalpha: ${alpha} — Alpha: a scroller extension\nbeta: ${beta}\n\n`));
});

test('regression: the triage answers with the name of the folder, and the idea is still paired', async () => {
  // Haiku answered "simple-autoscroll-free", not the path, and ideamine 0.4.0 before this fix did not pair.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-name-'));
  const extension = path.join(root, 'simple-autoscroll-free');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ projects: { [extension]: {} } }));
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.FAKE_CLAUDE_ANSWER = 'name';
  store.addIdeas(['add a speed slider to simple-autoscroll-free']);
  await headlessTriage({ model: 'haiku' });
  delete process.env.FAKE_CLAUDE_ANSWER;
  assert.equal(store.findIdea(store.load(), 1).project, extension);
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
  assert.deepEqual(call.env, {
    CLAUDECODE: null,
    CLAUDE_EFFORT: null,
    CLAUDE_CODE_MESSAGING_SOCKET: null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? null, // low effort already limits Sonnet
  });
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
  // Haiku has no effort setting. Its thinking was 70% of the output tokens and did not change the verdicts.
  assert.equal(call.env.MAX_THINKING_TOKENS, '0');
});

test('headless triage of given ids judges only those ideas', async () => {
  store.addIdeas(['one', 'two', 'three']);
  const out = await headlessTriage({ ids: [3] });
  assert.deepEqual(out.results.map((r) => r.id), [3]);
  assert.deepEqual(store.load().ideas.map((i) => i.status), ['inbox', 'inbox', 'triaged']);
  assert.match(JSON.parse(fs.readFileSync(log, 'utf8')).input, /Ideas to triage \(1\):\n#3: three\n/);
});

test('a missing CLI gives a clear error', async () => {
  store.addIdeas(['one']);
  process.env.IDEAMINE_CLAUDE_BIN = path.join(os.tmpdir(), 'definitely-not-claude-xyz');
  await assert.rejects(headlessTriage(), /Claude Code CLI not found/);
  assert.equal(store.load().ideas[0].status, 'inbox');
});
