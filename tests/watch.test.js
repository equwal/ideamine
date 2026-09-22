import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as store from '../src/store.js';
import * as watch from '../src/watch.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
let log;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-watch-'));
  process.env.IDEAMINE_HOME = dir;
  process.env.IDEAMINE_CLAUDE_BIN = FAKE;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.FAKE_CLAUDE_LOG = log = path.join(dir, 'call.json');
});

const lock = () => path.join(store.home(), '.watch');

test('the watcher starts a pass only when it is on, there is work, and no pass runs', () => {
  let started = 0;
  const kick = () => watch.kick({ startPass: () => started++ });
  assert.equal(kick(), false); // off
  watch.turnOn();
  assert.equal(kick(), false); // no ideas
  store.addIdeas(['one']);
  assert.equal(kick(), true);
  fs.mkdirSync(lock()); // a pass runs
  assert.equal(kick(), false);
  fs.rmSync(lock(), { recursive: true });
  watch.turnOff();
  assert.equal(kick(), false);
  assert.equal(started, 1);
});

test('a pass that cannot start is recorded, and the caller goes on', async () => {
  // The dashboard server calls kick() and must live on. Once, a failed start stopped that server.
  watch.turnOn();
  store.addIdeas(['one']);
  const node = process.execPath;
  process.execPath = path.join(store.home(), 'no-such-node');
  try {
    assert.equal(watch.kick(), true);
    await new Promise((resolve) => setTimeout(resolve, 300)); // the spawn error comes later
  } finally {
    process.execPath = node;
  }
  assert.match(watch.readState().error, /^cannot start a pass: .*ENOENT/);
  assert.equal(watch.kick({ startPass: () => assert.fail('must wait after the error') }), false);
});

test('a pass triages the inbox and the ideas from before pairing, with Haiku, and logs it', async () => {
  store.addIdeas(['old idea', 'new idea']);
  store.applyTriage([{ id: 1, verdict: 'do', impact: 3, size: 's', model: 'sonnet', title: 'Old', why: 'w', brief: 'b' }]);
  watch.turnOn();
  assert.deepEqual(watch.pendingWork(store.load()), [1, 2]);
  await watch.pass();
  const db = store.load();
  assert.deepEqual(watch.pendingWork(db), []);
  assert.deepEqual(db.ideas.map((i) => i.triage.by), ['haiku (headless)', 'haiku (headless)']);
  assert.match(JSON.parse(fs.readFileSync(log, 'utf8')).args.join(' '), /--model haiku/);
  assert.match(fs.readFileSync(path.join(store.home(), 'watch.log'), 'utf8'), /triaged #1 #2 \(haiku, 321 in \/ 45 out tokens\)/);
  assert.ok(watch.readState().lastPass);
  assert.ok(!fs.existsSync(lock()));
});

test('a failed pass is logged, and the watcher waits before it tries again', async () => {
  store.addIdeas(['one']);
  watch.turnOn();
  process.env.IDEAMINE_CLAUDE_BIN = path.join(os.tmpdir(), 'definitely-not-claude-xyz');
  await watch.pass({ retries: 0 });
  assert.match(watch.readState().error, /Claude Code CLI not found/);
  assert.match(fs.readFileSync(path.join(store.home(), 'watch.log'), 'utf8'), /error: Claude Code CLI not found/);
  assert.equal(watch.kick({ startPass: () => assert.fail('it must wait after an error') }), false);
  assert.equal(watch.kick({ startPass: () => {}, now: Date.now() + 11 * 60 * 1000 }), true);
});

test('only one pass runs at a time', async () => {
  store.addIdeas(['one']);
  watch.turnOn();
  fs.mkdirSync(lock());
  assert.equal(await watch.pass(), 'busy');
  assert.ok(!fs.existsSync(log)); // no call to claude
  assert.equal(store.load().ideas[0].status, 'inbox');
});

test('the status tells if the watcher is on, what waits, and what it did last', async () => {
  assert.match(watch.status(), /^ideamine watch: off/);
  store.addIdeas(['one']);
  watch.turnOn();
  assert.match(watch.status(), /^ideamine watch: on since .*\n1 idea waits for the watcher/);
  await watch.pass();
  assert.match(watch.status(), /\nlast passes:\n {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}triaged #1 /);
});
