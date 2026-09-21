import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handlePrompt } from '../src/hook.js';
import * as store from '../src/store.js';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));

beforeEach(() => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-hook-'));
});

/** Run the real hook process the way Claude Code does: JSON on stdin, decision on stdout. */
function runHook(prompt, cwd = '/work/app') {
  const input = JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd, prompt });
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('/idea saves the idea and blocks the prompt so no model call happens', () => {
  const out = runHook('/idea add a read-aloud mode #a11y');
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Saved #1 · add a read-aloud mode/);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true });
  const [idea] = store.load().ideas;
  assert.equal(idea.source, 'hook');
  assert.equal(idea.session, 's1');
  assert.deepEqual(idea.tags, ['a11y']);
  assert.equal(idea.project, path.resolve('/work/app'));
});

test('plugin-qualified and multi-line forms work', () => {
  assert.match(runHook('/ideamine:idea first').reason, /Saved #1/);
  assert.match(runHook('/idea - two\n- three').reason, /Saved 2 ideas: #2, #3/);
});

test('ordinary prompts, other commands, and questions pass straight through', () => {
  for (const p of ['fix the tests', '/idea-triage', '/idea-go 3', '/ideasx', 'an /idea in the middle', '/ideas what should I build today?']) {
    assert.equal(runHook(p), null, p);
  }
  assert.equal(store.load().ideas.length, 0);
});

test('/ideas shows the board, details, and applies quick edits', () => {
  store.addIdeas(['alpha', 'beta'], { project: '/work/app' });
  assert.match(runHook('/ideas').reason, /2 open[\s\S]*#2 {3}beta[\s\S]*#1 {3}alpha/);
  assert.match(runHook('/ideas #1').reason, /^#1 alpha/);
  assert.match(runHook('/ideas done 1 shipped it').reason, /#1 alpha → done/);
  assert.match(runHook('/ideas done').reason, /DONE[\s\S]*#1/);
  assert.match(runHook('/ideas 9').reason, /No idea #9/);
  assert.match(runHook('/idea').reason, /^Usage/);
});

test('handlePrompt filters by project with "here"', () => {
  store.addIdeas(['mine'], { project: '/a' });
  store.addIdeas(['theirs'], { project: '/b' });
  const board = handlePrompt('/ideas here', { cwd: '/a' });
  assert.match(board, /mine/);
  assert.doesNotMatch(board, /theirs/);
});

test('when the archive is unreadable the prompt goes through instead of being lost', () => {
  fs.mkdirSync(store.home(), { recursive: true });
  fs.writeFileSync(store.dbPath(), 'not json');
  const r = spawnSync(process.execPath, [BIN, 'hook'], {
    input: JSON.stringify({ prompt: '/idea keep me', cwd: '/x' }),
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /not valid JSON/);
});
