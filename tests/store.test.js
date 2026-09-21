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
