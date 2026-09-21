import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveTitle, extractTags, isSimilar, splitIdeas, wordSet } from '../src/text.js';

test('deriveTitle uses the first line, drops bullets and tags, and cuts at a word', () => {
  assert.equal(deriveTitle('  Add dark mode #ui\nmore detail'), 'Add dark mode');
  assert.equal(deriveTitle('- a bullet idea'), 'a bullet idea');
  const long = 'Build a thing that does many things '.repeat(5);
  const t = deriveTitle(long, 40);
  assert.ok(t.length <= 40, t);
  assert.ok(t.endsWith('…'));
  assert.ok(!t.includes('  '));
});

test('extractTags finds #words but not #numbers or C#', () => {
  assert.deepEqual(extractTags('ship it #UI #perf-fix, see #12 and C# code'), ['ui', 'perf-fix']);
});

test('splitIdeas splits a bulleted list and keeps continuation lines', () => {
  assert.deepEqual(splitIdeas('- one\n- two\n  more about two\n* three'), ['one', 'two\nmore about two', 'three']);
  assert.deepEqual(splitIdeas('1. first\n2) second'), ['first', 'second']);
});

test('splitIdeas keeps prose (or a single bullet) as one idea', () => {
  assert.deepEqual(splitIdeas('An idea\n- with a bullet inside'), ['An idea\n- with a bullet inside']);
  assert.deepEqual(splitIdeas('- only one'), ['- only one']);
  assert.deepEqual(splitIdeas('   '), []);
});

test('isSimilar flags near-duplicates and not mere topic overlap', () => {
  const a = wordSet('Add dark mode toggle to the popup');
  assert.ok(isSimilar(a, wordSet('add a dark mode toggle in settings')));
  assert.ok(!isSimilar(wordSet('fix login bug'), wordSet('fix signup bug')));
  assert.ok(!isSimilar(a, wordSet('export ideas to notion')));
});
