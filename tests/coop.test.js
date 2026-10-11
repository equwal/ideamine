import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import fc from 'fast-check';
import * as config from 'ideahook/config';
import * as coop from '../src/coop.js';
import * as store from 'ideahook/store';

const TOKEN = 'test-operator-token';
let hub; // a fake coop hub: { url, sent, answers, messages, close }
let logs;

/** A coop hub with the two operator routes that ideamine uses. `answers` are the replies to the next sends. */
function startHub() {
  const h = { sent: [], answers: [], messages: [], auth: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      h.auth.push(req.headers.authorization);
      const reply = (status, json) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      const u = new URL(req.url, 'http://hub');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthorized' });
      if (req.method === 'POST' && u.pathname === '/v1/admin/sessions/workers/messages') {
        h.sent.push(JSON.parse(Buffer.concat(chunks).toString()));
        const [status, json] = h.answers.shift() || [404, { error: 'not_found', message: 'no peer in this session can take work now' }];
        return reply(status, json);
      }
      if (req.method === 'GET' && u.pathname === '/v1/admin/sessions/workers/messages') {
        const after = Number(u.searchParams.get('after'));
        return reply(200, { messages: h.messages.filter((m) => Number(m.id) > after).slice(0, Number(u.searchParams.get('limit'))) });
      }
      reply(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ ...h, h, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })),
  );
}

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-coop-'));
  hub = await startHub();
  process.env.IDEAMINE_COOP_URL = hub.url;
  process.env.IDEAMINE_COOP_TOKEN = TOKEN;
  logs = [];
});

afterEach(async () => {
  await hub.close();
  delete process.env.IDEAMINE_COOP_URL;
  delete process.env.IDEAMINE_COOP_TOKEN;
});

const round = () => coop.round(coop.settings(), { log: (line) => logs.push(line) });
const idea = (id) => store.findIdea(store.load(), id);
const lastNote = (id) => idea(id).notes.at(-1).text;

/** An idea that the user dropped in Doing on a board with coop, through the page's own dropCommand. */
function dropInDoing(text = 'build the thing') {
  const [{ idea: added }] = store.addIdeas(text);
  store.applyTriage([{ id: added.id, verdict: 'do', brief: 'the plan', model: 'sonnet' }]);
  const page = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const dropCommand = new Function('state', `${/function dropCommand[\s\S]*?\n}\n/.exec(page)[0]}; return dropCommand;`)({ data: { live: { coop: true } } });
  const command = dropCommand({ ...added, lane: 'do' }, 'doing');
  assert.deepEqual(command, { action: 'update', body: { id: added.id, status: 'doing', agent: 'any' } });
  const { id, ...patch } = command.body;
  store.updateIdea(id, patch);
  return id;
}

test('coop is off without a hub url or without a token, the token is never a setting, and only Doing waits for an agent', () => {
  assert.ok(coop.settings());
  assert.ok(!Object.keys(config.SETTINGS).some((key) => key.includes('token')));
  delete process.env.IDEAMINE_COOP_TOKEN;
  assert.equal(coop.settings(), null);
  process.env.IDEAMINE_COOP_TOKEN = TOKEN;
  delete process.env.IDEAMINE_COOP_URL;
  assert.equal(coop.settings(), null);
  const [{ idea: i }] = store.addIdeas('x');
  assert.throws(() => store.updateIdea(i.id, { agent: 'any' }), /only an idea in Doing can wait for an agent/);
  assert.throws(() => store.updateIdea(i.id, { status: 'doing', agent: 'claude@g' }), /agent must be "any"/);
});

test('a card dropped in Doing goes to a free agent, shows its name, and DONE closes it', async () => {
  const id = dropInDoing();
  assert.equal(lastNote(id), 'waits for a free coop agent');
  hub.h.answers.push([200, { id: '101', to: 'claude@gentoo', sent_at: 'now' }]);
  await round();
  assert.equal(hub.h.sent.length, 1);
  assert.equal(hub.h.sent[0].to, 'any');
  assert.match(hub.h.sent[0].text, /^Card IDEA-1 of jose's ideamine board: build the thing\n\nbuild the thing\n\nPlan from the triage: the plan\n/);
  assert.deepEqual([idea(id).status, idea(id).agent.name, idea(id).agent.msg], ['doing', 'claude@gentoo', '101']);
  assert.equal(lastNote(id), 'coop gave it to claude@gentoo');

  await round(); // no answer yet: nothing changes, and nothing else is sent
  assert.equal(idea(id).agent.name, 'claude@gentoo');
  assert.equal(hub.h.sent.length, 1);

  hub.h.messages.push({ id: '102', from: 'claude@gentoo', to: 'operator', reply_to: '101', text: 'DONE: pushed abc123 to main' });
  await round();
  assert.equal(store.lane(idea(id)), 'done');
  assert.equal(idea(id).agent, undefined);
  assert.equal(lastNote(id), 'claude@gentoo: DONE: pushed abc123 to main');
  assert.ok(hub.h.auth.every((a) => a === `Bearer ${TOKEN}`));
  assert.ok(logs.every((line) => !line.includes(TOKEN)), 'the token stays out of the log');
});

test('an answer without DONE puts the card back in Do, with the answer as a note', async () => {
  const id = dropInDoing();
  hub.h.answers.push([200, { id: '7', to: 'codex@gentoo' }]);
  await round();
  hub.h.messages.push({ id: '8', from: 'codex@gentoo', reply_to: '7', text: 'FAILED: the project is not on this machine' });
  await round();
  assert.equal(store.lane(idea(id)), 'do');
  assert.equal(lastNote(id), 'codex@gentoo: FAILED: the project is not on this machine');
});

test('when no agent is free, the card waits and goes in a later round', async () => {
  const id = dropInDoing();
  await round(); // the hub answers 404
  assert.equal(idea(id).agent.name, 'any');
  assert.equal(logs.length, 0, 'a busy pool is normal, not an error');
  hub.h.answers.push([200, { id: '5', to: 'claude@subread' }]);
  await round();
  assert.equal(idea(id).agent.name, 'claude@subread');
});

test('a card that the user moves out of Doing is free of its agent, and a late answer changes nothing', async () => {
  const id = dropInDoing();
  hub.h.answers.push([200, { id: '3', to: 'claude@honjimaku' }]);
  await round();
  store.updateIdea(id, { status: 'reopen' });
  assert.equal(idea(id).agent, undefined);
  hub.h.messages.push({ id: '4', from: 'claude@honjimaku', reply_to: '3', text: 'DONE: late' });
  await round();
  assert.equal(store.lane(idea(id)), 'do');
  assert.notEqual(lastNote(id), 'claude@honjimaku: DONE: late');
});

test('a card without an answer for 3 hours goes back in Do', async () => {
  const id = dropInDoing();
  hub.h.answers.push([200, { id: '9', to: 'claude@gentoo' }]);
  await round();
  store.mutate((db) => (store.findIdea(db, id).agent.at = new Date(Date.now() - 4 * 3600000).toISOString()));
  await round();
  assert.equal(store.lane(idea(id)), 'do');
  assert.equal(lastNote(id), 'no answer from claude@gentoo in 3 h');
});

test('claim takes each waiting card once, oldest first, and never another card: a property', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom('waits', 'doing', 'do', 'inbox', 'done'), { maxLength: 12 }), (kinds) => {
      process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-claim-'));
      const waits = [];
      kinds.forEach((kind, n) => {
        const [{ idea: i }] = store.addIdeas(`idea ${n}`);
        if (kind === 'do') store.applyTriage([{ id: i.id, verdict: 'do' }]);
        if (['waits', 'doing', 'done'].includes(kind)) store.updateIdea(i.id, { status: kind === 'done' ? 'done' : 'doing' });
        if (kind === 'waits') {
          store.updateIdea(i.id, { agent: 'any' });
          store.mutate((db) => (store.findIdea(db, i.id).agent.at = new Date(Date.UTC(2026, 0, 1, 0, 0, 59 - n)).toISOString()));
          waits.push(i.id);
        }
      });
      const taken = [];
      for (let c; (c = coop.claim()); ) taken.push(c.id);
      assert.deepEqual(taken, waits.reverse()); // the later idea waits longer here
      assert.ok(store.load().ideas.every((i) => (waits.includes(i.id) ? i.agent.name === 'coop' : !i.agent)));
    }),
    { numRuns: 60 },
  );
});

test('claims from many processes at once never give one card twice', async () => {
  const cards = 24;
  for (let n = 0; n < cards; n++) {
    const [{ idea: i }] = store.addIdeas(`card ${n}`);
    store.updateIdea(i.id, { status: 'doing', agent: 'any' });
  }
  const mod = new URL('../src/coop.js', import.meta.url).href;
  const run = () =>
    new Promise((resolve, reject) => {
      const script = `const c = await import(${JSON.stringify(mod)}); const got = []; for (let x; (x = c.claim()); ) got.push(x.id); console.log(JSON.stringify(got));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    });
  const all = (await Promise.all(Array.from({ length: 6 }, run))).flat();
  assert.equal(all.length, cards);
  assert.equal(new Set(all).size, cards);
});
