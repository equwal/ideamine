import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as config from '../src/config.js';
import * as embed from '../src/embed.js';
import * as publish from '../src/publish.js';
import * as store from '../src/store.js';
import { startFakeServer } from './fixtures/fake-server.js';

let server;

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-publish-'));
  server = await startFakeServer();
  process.env.IDEAMINE_EMBED_URL = `${server.url}/v1`;
  for (const name of ['IDEAMINE_PUBLISH_URL', 'IDEAMINE_EMBED_MODEL', 'IDEAMINE_GROUP_THRESHOLD', 'IDEAMINE_SEARCH_THRESHOLD']) delete process.env[name];
});

afterEach(() => server.close());

const T = (h) => `2026-09-21T${String(h).padStart(2, '0')}:00:00.000Z`;

test('timeline phases follow the inbox, the queue, and the work', () => {
  const base = { id: 1, created: T(1), status: 'inbox' };
  assert.deepEqual(publish.phases(base), [{ phase: 'inbox', from: T(1), to: null }]);
  const queued = { ...base, status: 'triaged', triage: { at: T(2) } };
  assert.deepEqual(publish.phases(queued), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'queued', from: T(2), to: null },
  ]);
  const done = { ...queued, status: 'done', started: T(3), closed: T(5) };
  assert.deepEqual(publish.phases(done), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'queued', from: T(2), to: T(3) },
    { phase: 'doing', from: T(3), to: T(5) },
  ]);
  // Done before start times were recorded: the work bar is a guess, and says so.
  assert.deepEqual(publish.phases({ ...queued, status: 'done', closed: T(5) }), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'doing', from: T(2), to: T(5), estimated: true },
  ]);
  assert.deepEqual(publish.phases({ ...base, status: 'dropped', closed: T(4) }), [{ phase: 'inbox', from: T(1), to: T(4) }]);
});

test('the snapshot has a ticket for each idea, groups, related ideas, and the vectors', async () => {
  process.env.IDEAMINE_GROUP_THRESHOLD = '0.5';
  store.addIdeas(['subtitles for audiobooks', 'subtitles for audiobooks on android', 'a tor exit relay'], { project: '/work/app' });
  store.applyTriage([{ id: 3, verdict: 'do', impact: 4, size: 's', model: 'haiku', title: 'Tor relay', why: 'w', brief: 'b' }]);
  store.updateIdea(3, { status: 'doing' });
  const { data, note } = await publish.build(store.load());
  assert.equal(note, '');
  assert.equal(data.version, 1);
  assert.equal(data.embed.available, true);
  assert.equal(data.embed.query_prefix, 'search_query: ');
  assert.equal(data.counts.doing, 1);
  const [one, two, three] = data.ideas;
  assert.deepEqual([one.key, one.lane, one.project, three.lane, three.model], ['IDEA-1', 'inbox', 'app', 'doing', 'haiku']);
  assert.deepEqual(data.ideas.map((i) => i.rank), [2, 1, 0]); // doing first, then the inbox, newest first
  assert.deepEqual(data.groups, [{ id: 0, label: data.groups[0].label, ids: [1, 2] }]);
  assert.deepEqual([one.group, two.group, three.group], [0, 0, null]);
  assert.equal(one.related[0].id, 2);
  assert.ok(three.phases.some((p) => p.phase === 'doing' && p.from === three.started));
  const vectors = await embed.vectorsFor(store.load().ideas);
  assert.deepEqual([...embed.decodeVec(one.vec)], [...vectors.get(1)]);
});

test('without the embedding server, the snapshot has no groups or vectors, and says why', async () => {
  store.addIdeas(['one idea']);
  server.options.down = true;
  const { data, note } = await publish.build(store.load());
  assert.match(note, /without search by meaning or groups: .*503/);
  assert.equal(data.embed.available, false);
  assert.deepEqual([data.groups, data.ideas[0].vec, data.ideas[0].related], [[], null, []]);
});

test('publish uploads data.json and index.html with PUT, and kick() starts again only after a change', async () => {
  store.addIdeas(['one idea']);
  let started = 0;
  const kick = () => publish.kick({ start: () => started++ });
  assert.equal(kick(), false); // no dashboard server set
  config.set('publish_url', `${server.url}/dash`);
  assert.equal(kick(), true); // never published
  const out = await publish.publish();
  assert.deepEqual([out.where, out.ideas], [`${server.url}/dash`, 1]);
  assert.deepEqual([...server.files.keys()], ['/dash/data.json', '/dash/index.html']);
  assert.equal(JSON.parse(server.files.get('/dash/data.json')).ideas[0].title, 'one idea');
  assert.match(server.files.get('/dash/index.html'), /<html/i);
  assert.equal(kick(), false); // nothing changed
  await new Promise((resolve) => setTimeout(resolve, 20)); // a later modification time
  store.addIdeas(['two']);
  assert.equal(kick(), true);
  assert.equal(started, 2);
});

test('a failed background publish is recorded, and kick() waits before the next try', async () => {
  store.addIdeas(['one idea']);
  const closed = await startFakeServer();
  await closed.close();
  config.set('publish_url', `${closed.url}/`);
  assert.equal(await publish.backgroundPublish(), 'error');
  assert.match(publish.readState().error, /cannot reach/);
  assert.equal(publish.kick({ start: () => assert.fail('must wait') }), false);
  assert.match(publish.status(), /failed/);
});

test('a background publish that cannot start is recorded, and the caller goes on', async () => {
  store.addIdeas(['one idea']);
  config.set('publish_url', `${server.url}/`);
  const node = process.execPath;
  process.execPath = path.join(store.home(), 'no-such-node');
  try {
    assert.equal(publish.kick(), true);
    await new Promise((resolve) => setTimeout(resolve, 300)); // the spawn error comes later
  } finally {
    process.execPath = node;
  }
  assert.match(publish.readState().error, /^cannot start a publish: .*ENOENT/);
  assert.equal(publish.kick({ start: () => assert.fail('must wait after the error') }), false);
});

test('publish --dir writes both files to a folder', async () => {
  store.addIdeas(['one idea']);
  const dir = path.join(store.home(), 'out');
  const out = await publish.publish({ dir });
  assert.equal(out.where, dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['data.json', 'index.html']);
});

test('config: the environment wins over the file, and an empty value restores the default', () => {
  assert.equal(config.get('search_threshold'), 0.5);
  assert.equal(config.set('search_threshold', '0.42'), 0.42);
  process.env.IDEAMINE_SEARCH_THRESHOLD = '0.9';
  assert.equal(config.get('search_threshold'), 0.9);
  delete process.env.IDEAMINE_SEARCH_THRESHOLD;
  assert.equal(config.set('search_threshold', ''), 0.5);
  assert.throws(() => config.set('search_threshold', '2'), /from 0 to 1/);
  assert.throws(() => config.get('nope'), /unknown setting/);
  assert.match(config.describe(), /^embed_url\s+http:\/\/127\.0\.0\.1:\d+\/v1\s+IDEAMINE_EMBED_URL/);
});
