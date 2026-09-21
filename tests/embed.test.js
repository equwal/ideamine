import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import fc from 'fast-check';
import * as embed from '../src/embed.js';
import * as store from '../src/store.js';
import { startFakeServer } from './fixtures/fake-server.js';

let server;

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-embed-'));
  server = await startFakeServer();
  process.env.IDEAMINE_EMBED_URL = `${server.url}/v1`;
  delete process.env.IDEAMINE_EMBED_MODEL;
});

afterEach(() => server.close());

const unitVector = (dim) =>
  fc
    .array(fc.float({ min: -1, max: 1, noNaN: true }), { minLength: dim, maxLength: dim })
    .filter((v) => v.some((x) => Math.abs(x) > 1e-3))
    .map((v) => embed.unit(v));

test('property: a vector survives encode and decode unchanged', () => {
  fc.assert(
    fc.property(fc.float32Array(), (vec) => {
      const back = embed.decodeVec(embed.encodeVec(vec));
      assert.equal(back.length, vec.length);
      for (let i = 0; i < vec.length; i++) assert.ok(Object.is(back[i], vec[i]), `index ${i}: ${back[i]} != ${vec[i]}`);
    }),
  );
});

test('property: cosine of unit vectors is symmetric, at most 1, and 1 for the same vector', () => {
  fc.assert(
    fc.property(unitVector(8), unitVector(8), (a, b) => {
      assert.ok(Math.abs(embed.cosine(a, b) - embed.cosine(b, a)) < 1e-6);
      assert.ok(Math.abs(embed.cosine(a, b)) <= 1 + 1e-5);
      assert.ok(Math.abs(embed.cosine(a, a) - 1) < 1e-5);
    }),
  );
});

test('property: groups are disjoint, follow the average-linkage rule, and do not depend on the input order', () => {
  const cases = fc
    .uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 0, maxLength: 12 })
    .chain((ids) => fc.tuple(fc.constant(ids), fc.array(unitVector(4), { minLength: ids.length, maxLength: ids.length }), fc.double({ min: -1, max: 1, noNaN: true })));
  fc.assert(
    fc.property(cases, ([ids, vecs, threshold]) => {
      const vectors = new Map(ids.map((id, i) => [id, vecs[i]]));
      const groups = embed.groupIds(ids, vectors, threshold);
      const seen = groups.flat();
      assert.equal(new Set(seen).size, seen.length);
      assert.ok(seen.every((id) => ids.includes(id)));
      assert.ok(groups.every((g) => g.length >= 2));
      assert.deepEqual(embed.groupIds([...ids].reverse(), vectors, threshold), groups);
      // Average linkage: the mean similarity inside a group is at least the threshold, and the mean
      // similarity across any two clusters that stayed apart (single ideas too) is below it.
      const mean = (a, b) => {
        let sum = 0;
        for (const x of a) for (const y of b) sum += embed.cosine(vectors.get(x), vectors.get(y));
        return sum / (a.length * b.length);
      };
      for (const g of groups) {
        let sum = 0;
        let pairs = 0;
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++, pairs++) sum += embed.cosine(vectors.get(g[i]), vectors.get(g[j]));
        assert.ok(sum / pairs >= threshold - 1e-6, `group ${g} has mean ${sum / pairs} < ${threshold}`);
      }
      const clusters = [...groups, ...ids.filter((id) => !seen.includes(id)).map((id) => [id])];
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) assert.ok(mean(clusters[i], clusters[j]) < threshold + 1e-6);
      }
    }),
  );
});

test('property: a higher threshold only splits groups, it never joins ideas from two groups', () => {
  const cases = fc
    .uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 2, maxLength: 10 })
    .chain((ids) => fc.tuple(fc.constant(ids), fc.array(unitVector(4), { minLength: ids.length, maxLength: ids.length }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })));
  fc.assert(
    fc.property(cases, ([ids, vecs, low, step]) => {
      const vectors = new Map(ids.map((id, i) => [id, vecs[i]]));
      const coarse = embed.groupIds(ids, vectors, low);
      for (const g of embed.groupIds(ids, vectors, low + step)) {
        assert.ok(coarse.some((c) => g.every((id) => c.includes(id))), `${g} is not inside one group of ${JSON.stringify(coarse)}`);
      }
    }),
  );
});

test('nomic prefixes: documents and queries get their own task prefix; other models get raw text', async () => {
  store.addIdeas(['read subtitles aloud']);
  await embed.find(store.load(), 'subtitles');
  assert.deepEqual(server.inputs, ['search_document: read subtitles aloud', 'search_query: subtitles']);
  process.env.IDEAMINE_EMBED_MODEL = 'mxbai-embed-large';
  await embed.find(store.load(), 'subtitles');
  assert.deepEqual(server.inputs.slice(2), ['read subtitles aloud', 'subtitles']);
});

test('the cache embeds each idea once, again after a change, and drops deleted ideas', async () => {
  store.addIdeas(['sync subtitles with audiobooks', 'dark mode for the popup']);
  await embed.vectorsFor(store.load().ideas);
  assert.equal(server.inputs.length, 2);
  await embed.vectorsFor(store.load().ideas);
  assert.equal(server.inputs.length, 2); // from the cache
  store.updateIdea(2, { text: 'dark mode for the settings page' });
  await embed.vectorsFor(store.load().ideas);
  assert.deepEqual(server.inputs.slice(2), ['search_document: dark mode for the settings page']);
  store.removeIdeas([1]);
  store.addIdeas(['a third idea']);
  await embed.vectorsFor(store.load().ideas);
  const cached = JSON.parse(fs.readFileSync(path.join(store.home(), 'vectors.json'), 'utf8'));
  assert.deepEqual(Object.keys(cached.items).sort(), ['2', '3']);
});

test('a text that is too long is halved until the server takes it', async () => {
  server.options.maxChars = 400;
  store.addIdeas([`${'subtitle '.repeat(100)}end`, 'short idea']);
  const vectors = await embed.vectorsFor(store.load().ideas);
  assert.equal(vectors.size, 2);
  const tries = server.inputs.filter((x) => x.startsWith('search_document: subtitle')).map((x) => x.length);
  assert.deepEqual(tries, [920, 920, 468, 242]); // the batch, then one at a time, halved twice
});

test('find ranks by meaning and keeps results above the threshold', async () => {
  store.addIdeas(['subtitles for audiobooks in the reader', 'a tor exit relay on the server', 'subtitles in the video player']);
  const found = await embed.find(store.load(), 'subtitles audiobooks reader', { threshold: 0.3 });
  assert.equal(found.mode, 'meaning');
  assert.deepEqual(found.results.map((r) => r.idea.id), [1, 3]);
  assert.ok(found.results[0].score > found.results[1].score);
});

test('find falls back to word search and says why when the server does not answer', async () => {
  store.addIdeas(['subtitles for audiobooks', 'dark mode']);
  server.options.down = true;
  const found = await embed.find(store.load(), 'audiobooks subtitles');
  assert.equal(found.mode, 'words');
  assert.match(found.note, /503/);
  assert.deepEqual(found.results.map((r) => r.idea.id), [1]);
  const closed = await startFakeServer();
  await closed.close(); // now nothing listens on its port
  process.env.IDEAMINE_EMBED_URL = `${closed.url}/v1`;
  const offline = await embed.find(store.load(), 'dark', { timeoutMs: 5000 });
  assert.equal(offline.mode, 'words');
  assert.match(offline.note, /cannot reach http:\/\/127\.0\.0\.1:\d+\/v1\/embeddings \((ECONNREFUSED|no answer)/);
});

test('group labels use the distinctive shared words, not "add full support"', () => {
  store.addIdeas([
    'Add full support for subread to hoshireader',
    'Add full support for subread and whispersync to chimahon',
    'Add full support for whispersync to koreader',
    'Add a back button to the key screen',
  ]);
  const ideas = store.load().ideas;
  assert.equal(embed.groupLabel(ideas.slice(0, 3), ideas), 'subread · whispersync');
});
