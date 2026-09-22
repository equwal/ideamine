import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import fc from 'fast-check';
import * as archive from '../src/archive.js';
import * as store from '../src/store.js';
import * as sync from '../src/sync.js';
import { freePort, startServerProcess } from './fixtures/server-process.js';

let server;
let deadUrl; // an address where nothing answers: the tunnel of a machine is down

before(async () => {
  server = await startServerProcess();
  deadUrl = `http://127.0.0.1:${await freePort()}/`;
});

after(() => server.stop());

/** An empty archive on the server: its archive and its record of applied changes go. */
function resetServer() {
  for (const name of ['ideas.json', 'ideas.json.bak', 'applied.json', 'prompts.jsonl']) fs.rmSync(path.join(server.home, name), { force: true });
}

const newHome = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ideamine-${name}-`));

/** Act as one machine: its own archive copy and outbox, and the server at `url`. */
function machine(home, url = server.url) {
  process.env.IDEAMINE_HOME = home;
  process.env.IDEAMINE_SYNC_URL = url;
}

beforeEach(() => {
  resetServer();
  delete process.env.IDEAMINE_PROMPT_LOG;
  machine(newHome('pc'));
});

const serverDb = async () => (await (await fetch(`${server.url}api/db`)).json()).db;

test('a change goes to the server, and the copy here follows the server', async () => {
  const [{ idea }] = await archive.add(['alpha #web'], { source: 'test', project: '/work/app' });
  assert.equal(idea.id, 1);
  assert.equal(idea.host, os.hostname());
  const onServer = await serverDb();
  assert.deepEqual(onServer.ideas.map((i) => [i.id, i.title, i.tags[0]]), [[1, 'alpha', 'web']]);
  assert.deepEqual(store.load().ideas, onServer.ideas);
  assert.equal(sync.waiting(), 0);
  const done = await archive.update(1, { status: 'done', note: 'shipped' });
  assert.deepEqual([done.status, done.notes.map((n) => n.text)], ['done', ['shipped']]);
  assert.deepEqual((await archive.remove([1])).map((i) => i.id), [1]);
  assert.deepEqual((await serverDb()).ideas, []);
});

test('when the server does not answer, a change waits in the outbox and goes with the next sync', async () => {
  const home = store.home();
  machine(home, deadUrl);
  const out = await archive.add(['written on a train']);
  assert.equal(out.queued, true);
  assert.match(out.reason, /cannot reach/);
  assert.equal(sync.waiting(), 1);
  assert.equal((await serverDb()).ideas.length, 0);
  assert.match(sync.status(), /1 change waits for the server[\s\S]*The last sync failed/);

  machine(home); // the tunnel is back
  await sync.pull();
  assert.equal(sync.waiting(), 0);
  assert.deepEqual((await serverDb()).ideas.map((i) => i.text), ['written on a train']);
  assert.deepEqual(store.load().ideas.map((i) => i.text), ['written on a train']);
});

test('the server applies a change only once, also when it comes twice', async () => {
  const op = { op: 'add', texts: ['once'], oid: 'same-oid' };
  const post = async () => (await fetch(`${server.url}api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [op, { op: 'update', id: 1, patch: { note: 'n' }, oid: 'note-oid' }] }) })).json();
  const first = await post();
  const second = await post(); // the answer to the first got lost, and the machine sent it again
  assert.deepEqual(second.results, first.results);
  assert.equal(second.db.ideas.length, 1);
  assert.deepEqual(second.db.ideas[0].notes.map((n) => n.text), ['n']);
  const bad = await (await fetch(`${server.url}api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'nope', oid: 'x' }, { op: 'remove', ids: [9], oid: 'y' }] }) })).json();
  assert.deepEqual(bad.results, [{ ok: false, error: 'unknown change "nope"' }, { ok: false, error: 'no idea #9' }]);
});

test('a slow answer with an older archive does not undo a newer copy', async () => {
  await archive.add(['one']);
  await archive.add(['two']);
  const newer = store.load();
  const stateNow = sync.readState();
  // The answer to an earlier request arrives last: revision 1 of the same archive.
  const old = { ...newer, rev: 1, ideas: newer.ideas.slice(0, 1) };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, db: old }), { status: 200 });
  try {
    await sync.pull();
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(store.load().ideas.map((i) => i.text), ['one', 'two']);
  assert.equal(sync.readState().rev, stateNow.rev);
});

test('kick() starts a background sync when work waits or the copy is old, and waits after a failure', async () => {
  let started = 0;
  const kick = (now = Date.now()) => sync.kick({ start: () => started++, now });
  assert.equal(kick(), true); // never synced
  await sync.pull();
  assert.equal(kick(), false); // fresh, nothing waits
  assert.equal(kick(Date.now() + 61000), true); // the copy is old
  sync.logPrompt({ prompt: 'hello', session: 's1', cwd: '/w' });
  assert.equal(kick(), false); // a prompt waits, but the last sync was a moment ago
  assert.equal(kick(Date.now() + 21000), true); // a prompt waits, and the last sync is 21 s old
  machine(store.home(), deadUrl);
  await archive.add(['queued']);
  assert.equal(kick(), false); // the sync failed a moment ago
  delete process.env.IDEAMINE_SYNC_URL;
  assert.equal(kick(Date.now() + 3600000), false); // sync is off
  assert.equal(started, 3);
});

test('turning sync on keeps the archive that was here in a backup file', async () => {
  delete process.env.IDEAMINE_SYNC_URL;
  store.addIdeas(['local only']);
  const backup = sync.setServer(server.url);
  assert.match(path.basename(backup), /^ideas\.before-sync-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).ideas[0].text, 'local only');
  await archive.fresh();
  assert.deepEqual(store.load().ideas, []); // the server's archive, which is empty
  assert.throws(() => sync.setServer('ftp://x'), /not an http/);
  sync.setServer('');
});

test('the prompt log sends prompts once, cuts a huge paste, and imports older transcripts', async () => {
  process.env.IDEAMINE_PROMPT_LOG = 'on';
  const transcripts = path.join(store.home(), 'claude', 'projects', 'C--work-app');
  fs.mkdirSync(transcripts, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = path.join(store.home(), 'claude');
  const line = (o) => JSON.stringify({ sessionId: 's0', cwd: 'C:\\work\\app', ...o });
  fs.writeFileSync(path.join(transcripts, 's0.jsonl'), [
    line({ type: 'user', timestamp: '2026-01-05T10:00:00.000Z', message: { role: 'user', content: '<system-reminder>\nNotes of the app.\n</system-reminder>\nfix the tests' } }),
    line({ type: 'user', timestamp: '2026-01-05T09:59:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>only a note</system-reminder>' }] } }),
    line({ type: 'user', timestamp: '2026-01-05T10:01:00.000Z', message: { role: 'user', content: '<command-name>/ideas</command-name>\n<command-args>go 3</command-args>' } }),
    line({ type: 'user', timestamp: '2026-01-05T10:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, toolUseResult: {} }),
    line({ type: 'user', timestamp: '2026-01-05T10:03:00.000Z', isMeta: true, message: { role: 'user', content: 'Caveat: a note of Claude Code' } }),
    line({ type: 'user', timestamp: '2026-01-05T10:04:00.000Z', isSidechain: true, message: { role: 'user', content: 'a prompt of a subagent' } }),
    line({ type: 'user', timestamp: '2026-01-05T10:05:00.000Z', message: { role: 'user', content: '[Request interrupted by user]' } }),
    line({ type: 'assistant', timestamp: '2026-01-05T10:06:00.000Z', message: { role: 'assistant', content: 'hi' } }),
    line({ type: 'user', timestamp: '2026-02-01T10:00:00.000Z', message: { role: 'user', content: 'after the live log started' } }),
    'not json',
  ].join('\n'));
  sync.logPrompt({ prompt: 'x'.repeat(150000), session: 's1', cwd: '/w', at: '2026-01-10T00:00:00.000Z' });
  assert.equal(sync.importPrompts(), 2); // older than the first live prompt only
  assert.equal(sync.importPrompts(), 2); // the same ids again: the server skips them
  await sync.pull({ prompts: true });
  const { prompts } = await (await fetch(`${server.url}api/prompts`)).json();
  assert.deepEqual(prompts.map((p) => p.prompt.slice(0, 20)), ['fix the tests', '/ideas go 3', 'x'.repeat(20)]);
  assert.match(prompts[2].prompt, /… \(cut: 50000 more characters\)$/);
  assert.equal(prompts[0].cwd, 'C:\\work\\app');
  assert.deepEqual((await (await fetch(`${server.url}api/prompts?days=1`)).json()).prompts, []); // all older than a day
  delete process.env.CLAUDE_CONFIG_DIR;
});

// A model of two machines that share the server, with outages. Each idea text is unique, so the
// test can follow an idea without its id.
const command = fc.oneof(
  fc.record({ c: fc.constant('add'), who: fc.constantFrom('A', 'B') }),
  fc.record({ c: fc.constantFrom('done', 'note', 'rm'), who: fc.constantFrom('A', 'B'), pick: fc.nat(20) }),
  fc.record({ c: fc.constantFrom('down', 'up', 'pull'), who: fc.constantFrom('A', 'B') }),
);

test('two machines with outages end with one archive: no idea lost, none twice, no note twice', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(command, { maxLength: 18 }), async (commands) => {
      resetServer();
      const homes = { A: newHome('a'), B: newHome('b') };
      const up = { A: true, B: true };
      const added = [];
      const removed = new Set();
      let n = 0;
      const use = (who) => machine(homes[who], up[who] ? server.url : deadUrl);
      for (const cmd of commands) {
        if (cmd.c === 'down' || cmd.c === 'up') {
          up[cmd.who] = cmd.c === 'up';
          continue;
        }
        use(cmd.who);
        if (cmd.c === 'pull') {
          await sync.pull().catch((e) => assert.ok(e instanceof sync.SyncError, e));
          continue;
        }
        if (cmd.c === 'add') {
          const text = `idea ${++n}`;
          added.push(text);
          await archive.add([text]);
          continue;
        }
        const ideas = store.load().ideas;
        if (!ideas.length) continue;
        const idea = ideas[cmd.pick % ideas.length];
        if (cmd.c === 'rm') removed.add(idea.text);
        const run = cmd.c === 'rm' ? archive.remove([idea.id]) : archive.update(idea.id, cmd.c === 'done' ? { status: 'done' } : { note: `note ${++n}` });
        // The other machine may have deleted the idea already: then the server refuses the change.
        await run.catch((e) => assert.match(e.message, /^no idea #\d+$/));
      }
      for (const who of ['A', 'B', 'A']) {
        machine(homes[who]);
        await sync.pull();
      }
      const onServer = await serverDb();
      const texts = onServer.ideas.map((i) => i.text).sort();
      assert.deepEqual(texts, added.filter((t) => !removed.has(t)).sort());
      for (const idea of onServer.ideas) {
        const notes = idea.notes.map((x) => x.text);
        assert.equal(new Set(notes).size, notes.length, `a note came twice on #${idea.id}`);
      }
      for (const who of ['A', 'B']) {
        machine(homes[who]);
        assert.deepEqual(store.load().ideas, onServer.ideas);
        assert.equal(sync.waiting(), 0);
      }
    }),
    { numRuns: 40 },
  );
});

test('a Windows path from a machine stays as it is on a POSIX server, and names show on any machine', () => {
  assert.equal(store.absolute('C:\\Users\\me\\app', 'linux'), 'C:\\Users\\me\\app');
  assert.equal(store.absolute('\\\\nas\\share\\app', 'linux'), '\\\\nas\\share\\app');
  assert.equal(store.absolute('/home/me/app', 'linux'), path.resolve('/home/me/app'));
  assert.equal(store.baseName('C:\\Users\\me\\app\\'), 'app');
  assert.equal(store.baseName('/home/me/app'), 'app');
});
