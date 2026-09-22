import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import fc from 'fast-check';
import * as usage from '../src/usage.js';

let dir; // the folder with the transcripts of the test

beforeEach(() => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-usage-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-transcripts-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One answer of the model, as Claude Code writes it into a transcript. */
function answer({ id = 'msg_1', model = 'claude-opus-5', cwd = 'C:\\work', at = '2026-09-22T10:00:00.000Z', input = 0, output = 0, read = 0, w5m = 0, w1h = 0 } = {}) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    sessionId: 's1',
    timestamp: at,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: w5m + w1h,
        cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h },
      },
    },
  });
}

const write = (name, lines) => fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);

test('the price of a row follows the price list', () => {
  // 1M input, 1M output, 1M cache read, 1M cache write with the 5-minute lifetime, on Opus 5.
  const row = { model: 'claude-opus-5', input: 1e6, output: 1e6, read: 1e6, write5m: 1e6, write1h: 0 };
  assert.equal(usage.cost(row), 5 + 25 + 0.5 + 5 * 1.25);
  // The 1-hour lifetime costs 2 times the input price.
  assert.equal(usage.cost({ model: 'claude-opus-5', write1h: 1e6 }), 10);
  // A date at the end of the name names the same model.
  assert.equal(usage.cost({ model: 'claude-haiku-4-5-20251001', output: 1e6 }), 5);
  // An unknown model costs nothing, and the page can say so.
  assert.equal(usage.cost({ model: 'gpt-9', output: 1e6 }), 0);
  assert.equal(usage.priced('gpt-9'), false);
  assert.equal(usage.priced('claude-opus-5'), true);
});

test('the price of a sum is the sum of the prices, for every model', () => {
  const models = fc.constantFrom(...Object.keys(usage.PRICES));
  const count = fc.integer({ min: 0, max: 5_000_000 });
  fc.assert(
    fc.property(models, count, count, count, count, count, (model, input, output, read, write5m, write1h) => {
      const one = { model, input, output, read, write5m, write1h };
      const parts = [
        { model, input, output: 0, read: 0, write5m: 0, write1h: 0 },
        { model, input: 0, output, read: 0, write5m: 0, write1h: 0 },
        { model, input: 0, output: 0, read, write5m: 0, write1h: 0 },
        { model, input: 0, output: 0, read: 0, write5m, write1h },
      ];
      const sum = parts.reduce((n, p) => n + usage.cost(p), 0);
      assert.ok(Math.abs(usage.cost(one) - sum) < 1e-9);
    }),
  );
});

test('a scan adds the tokens up for each day, project, and model', () => {
  write('a.jsonl', [
    answer({ id: 'm1', output: 100, read: 1000 }),
    answer({ id: 'm1', output: 100, read: 1000 }), // the same answer twice: it counts once
    answer({ id: 'm2', model: 'claude-sonnet-5', output: 50 }),
    answer({ id: 'm3', at: '2026-09-21T10:00:00.000Z', output: 7 }),
    answer({ id: 'm4', cwd: 'C:\\other', output: 3 }),
    '{"type":"user","message":{"content":"no tokens here"}}',
    'half a line that a crash cut',
  ]);
  const { rows, files, read } = usage.scan({ dir });
  assert.deepEqual([files, read], [1, 1]);
  const find = (day, project, model) => rows.find((r) => r.day === day && r.project === project && r.model === model);
  assert.deepEqual(
    [find('2026-09-22', 'C:\\work', 'claude-opus-5').output, find('2026-09-22', 'C:\\work', 'claude-opus-5').messages],
    [100, 1],
  );
  assert.equal(find('2026-09-22', 'C:\\work', 'claude-sonnet-5').output, 50);
  assert.equal(find('2026-09-21', 'C:\\work', 'claude-opus-5').output, 7);
  assert.equal(find('2026-09-22', 'C:\\other', 'claude-opus-5').output, 3);
  assert.equal(rows.length, 4);
});

test('the next scan reads only the new lines', () => {
  write('a.jsonl', [answer({ id: 'm1', output: 10 })]);
  usage.scan({ dir });
  assert.equal(usage.scan({ dir }).read, 0); // nothing new: no file is read again
  fs.appendFileSync(path.join(dir, 'a.jsonl'), `${answer({ id: 'm2', output: 5 })}\n`);
  const second = usage.scan({ dir });
  assert.equal(second.read, 1);
  const row = second.rows.find((r) => r.model === 'claude-opus-5');
  assert.deepEqual([row.output, row.messages], [15, 2]); // the tokens of both scans
});

test('byProject and since group the rows the way the page shows them', () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const rows = [
    { day: today, project: 'p1', model: 'claude-opus-5', output: 1e6, messages: 2, input: 0, read: 0, write5m: 0, write1h: 0 },
    { day: today, project: 'p1', model: 'claude-sonnet-5', output: 1e6, messages: 1, input: 0, read: 0, write5m: 0, write1h: 0 },
    { day: old, project: 'p2', model: 'claude-opus-5', output: 2e6, messages: 5, input: 0, read: 0, write5m: 0, write1h: 0 },
  ];
  assert.equal(usage.since(rows, 30).length, 2);
  assert.equal(usage.since(rows, 0).length, 3);
  const [first, second] = usage.byProject(rows);
  assert.deepEqual([first.project, first.cost], ['p2', 50]); // the most expensive project first
  assert.deepEqual([second.project, second.cost, second.messages], ['p1', 35, 3]);
  assert.deepEqual(Object.keys(second.models).sort(), ['claude-opus-5', 'claude-sonnet-5']);
});
