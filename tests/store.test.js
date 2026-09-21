import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as store from '../src/store.js';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));

beforeEach(() => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-test-'));
});

test('add, triage, and list ideas by lane and priority', () => {
  store.addIdeas(['small win', 'big but slow', 'meh', 'later'], { project: '/p' });
  store.applyTriage([
    { id: 1, verdict: 'do', impact: 3, size: 'xs', model: 'haiku', title: 'Small win', why: 'cheap', brief: 'b' },
    { id: 2, verdict: 'do', impact: 5, size: 'xl', model: 'claude-opus-5', title: 'Big', why: 'w', brief: 'b' },
    { id: 3, verdict: 'skip', impact: 1, size: 'm', model: 'sonnet', title: 'Meh', why: 'no', brief: 'ignored' },
  ]);
  const db = store.load();
  assert.deepEqual(store.listIdeas(db).map((i) => i.id), [1, 2, 4]); // do by value/effort, then inbox
  assert.deepEqual(store.listIdeas(db, { filter: 'skip' }).map((i) => i.id), [3]);
  assert.equal(store.findIdea(db, 2).triage.model, 'opus'); // full model ids normalize to aliases
  assert.equal(store.findIdea(db, 3).triage.brief, ''); // skip verdicts carry no brief
  assert.equal(store.pickNext(db, { project: '/p' }).id, 1);
  assert.deepEqual(store.counts(db), { inbox: 1, do: 2, maybe: 0, skip: 1, doing: 0, done: 0, dropped: 0, open: 3 });
});

test('pickNext takes the best "do" idea, else the best "maybe", and never an idea from another lane', () => {
  // Every combination of lanes, so that no lane can get into or out of the queue unseen.
  const LANES = ['do', 'maybe', 'skip', 'inbox', 'doing', 'done', 'dropped'];
  const VERDICTS = ['do', 'maybe', 'skip'];
  const make = (lane, id) => ({
    id,
    title: lane,
    status: VERDICTS.includes(lane) ? 'triaged' : lane,
    triage: lane === 'inbox' ? null : { verdict: VERDICTS.includes(lane) ? lane : 'do', impact: 3, size: 'm', model: 'sonnet' },
  });
  for (let mask = 0; mask < 1 << LANES.length; mask++) {
    const present = LANES.filter((_, bit) => mask & (1 << bit));
    const db = { ideas: present.map((lane, i) => make(lane, i + 1)) };
    const want = present.includes('do') ? 'do' : present.includes('maybe') ? 'maybe' : null;
    assert.equal(store.pickNext(db)?.title ?? null, want, `lanes: ${present.join(', ')}`);
  }

  // The verdict counts before the project: a "do" idea elsewhere beats a "maybe" idea here.
  const db = {
    ideas: [
      { id: 1, status: 'triaged', project: '/here', triage: { verdict: 'maybe', impact: 5, size: 'xs', model: 'haiku' } },
      { id: 2, status: 'triaged', project: '/there', triage: { verdict: 'do', impact: 1, size: 'xl', model: 'opus' } },
    ],
  };
  assert.equal(store.pickNext(db, { project: '/here' }).id, 2);
});

test('regression: after a triage of "0 do · 1 maybe · 1 skip", /ideas go still has an idea to build', () => {
  store.addIdeas(['tes', 'redesign the AssistKey UI for a premium e-ink feel']);
  store.applyTriage([
    { id: 1, verdict: 'skip', impact: 1, size: 'xs', model: 'haiku', title: "Clarify vague 'tes' idea", why: 'w', brief: '' },
    { id: 2, verdict: 'maybe', impact: 3, size: 'l', model: 'opus', title: 'Redesign AssistKey UI', why: 'w', brief: 'b' },
  ]);
  assert.equal(store.pickNext(store.load()).id, 2);
});

test('removeIdeas deletes ideas for good, all or nothing, and never reuses an id', () => {
  store.addIdeas(['one', 'two', 'three']);
  assert.throws(() => store.removeIdeas([1, 99]), /no idea #99/);
  assert.equal(store.load().ideas.length, 3); // an unknown id deletes nothing
  assert.deepEqual(store.removeIdeas(['#2', 3, '3']).map((i) => i.id), [2, 3]);
  assert.deepEqual(store.load().ideas.map((i) => i.id), [1]);
  assert.equal(store.addIdeas(['four'])[0].idea.id, 4);
});

test('bad verdicts are reported per item, not fatal', () => {
  store.addIdeas(['one']);
  const res = store.applyTriage([{ id: 1, verdict: 'yes' }, { id: 99, verdict: 'do' }]);
  assert.match(res[0].error, /verdict/);
  assert.equal(res[1].error, 'no such idea');
  assert.equal(store.findIdea(store.load(), 1).status, 'inbox');
});

test('status changes, notes, model override, and reopen', () => {
  store.addIdeas(['thing']);
  store.updateIdea(1, { status: 'start', note: 'on it' });
  let idea = store.updateIdea('#1', { status: 'done', note: 'shipped' });
  assert.equal(idea.status, 'done');
  assert.ok(idea.closed);
  assert.deepEqual(idea.notes.map((n) => n.text), ['on it', 'shipped']);
  idea = store.updateIdea(1, { status: 'reopen', model: 'opus' });
  assert.equal(idea.status, 'triaged');
  assert.equal(idea.triage.model, 'opus');
  assert.equal(idea.closed, undefined);
  assert.throws(() => store.updateIdea(1, { status: 'nope' }), /status must be/);
  assert.throws(() => store.updateIdea(42, { note: 'x' }), /no idea #42/);
});

test('the start time is recorded when work starts, for the dashboard timeline', async () => {
  store.addIdeas(['thing']);
  assert.equal(store.findIdea(store.load(), 1).started, undefined);
  const first = store.updateIdea(1, { status: 'doing' }).started;
  assert.ok(first);
  assert.equal(store.updateIdea(1, { status: 'doing', note: 'still on it' }).started, first); // no new start
  assert.equal(store.updateIdea(1, { status: 'done' }).started, first);
  store.updateIdea(1, { status: 'reopen' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(store.updateIdea(1, { status: 'start' }).started > first); // the latest start
});

test('a corrupt archive is never overwritten', () => {
  fs.mkdirSync(store.home(), { recursive: true });
  fs.writeFileSync(store.dbPath(), '{"ideas": [oops');
  assert.throws(() => store.addIdeas(['x']), /not valid JSON/);
  assert.equal(fs.readFileSync(store.dbPath(), 'utf8'), '{"ideas": [oops');
});

test('a stale lock from a crashed writer is recovered', () => {
  fs.mkdirSync(path.join(store.home(), '.lock'), { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(store.home(), '.lock'), old, old);
  assert.equal(store.addIdeas(['after crash'])[0].idea.id, 1);
});

test('concurrent writers from many processes never lose an idea', async () => {
  const procs = 8;
  const each = 6;
  const run = (n) =>
    new Promise((resolve, reject) => {
      // Each process appends its ideas through the CLI, all racing for the same archive.
      const script = `for (let i = 0; i < ${each}; i++) require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'add', 'proc ${n} idea ' + i]);`;
      const child = spawn(process.execPath, ['-e', script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all(Array.from({ length: procs }, (_, n) => run(n)));
  const ids = store.load().ideas.map((i) => i.id).sort((a, b) => a - b);
  assert.equal(ids.length, procs * each);
  assert.deepEqual(ids, Array.from({ length: procs * each }, (_, i) => i + 1));
});
