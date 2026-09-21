import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handlePrompt } from '../src/hook.js';
import * as store from '../src/store.js';
import { startFakeServer } from './fixtures/fake-server.js';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));

beforeEach(() => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-hook-'));
  // A pass of the watcher must never reach the real claude or the projects of this machine.
  process.env.IDEAMINE_CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
  process.env.CLAUDE_CONFIG_DIR = process.env.IDEAMINE_HOME;
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

test('ordinary prompts, model commands, and questions pass straight through', () => {
  const prompts = [
    'fix the tests',
    '/ideasx',
    '/idea-go 3', // a name from before 0.3.0: no command now
    'an /idea in the middle',
    '/ideas-go',
    '/ideamine:ideas-go 3',
    '/ideas-all',
    '/ideas-sort',
    '/ideas-cat',
    '/ideas-ls ideas about scrolling', // not lanes: the skill searches with these words
    '/ideas-rm the vague one',
    '/ideas all', // with a space it is a question for the model, never a command
    '/ideas what should I build today?',
  ];
  for (const p of prompts) assert.equal(runHook(p), null, p);
  assert.equal(store.load().ideas.length, 0);
});

test('/ideas and the dashed commands list, show, and edit ideas', () => {
  store.addIdeas(['alpha', 'beta'], { project: '/work/app' });
  assert.match(runHook('/ideas').reason, /2 open[\s\S]*#2 {3}beta[\s\S]*#1 {3}alpha/);
  assert.equal(runHook('/ideas-ls').reason, runHook('/ideas').reason);
  assert.match(runHook('/ideas-cat #1').reason, /^#1 alpha/);
  assert.match(runHook('/ideas-cat 1 2').reason, /^#1 alpha\n[\s\S]*\n\n#2 beta\n/);
  assert.match(runHook('/ideas-done 1 shipped it').reason, /#1 alpha → done \(note added\)/);
  assert.match(runHook('/ideas-ls done').reason, /DONE[\s\S]*#1/);
  assert.match(runHook('/ideas-ls -a').reason, /\[showing: all\][\s\S]*#2[\s\S]*#1/);
  assert.match(runHook('/ideamine:ideas-reopen 1').reason, /#1 alpha → inbox/);
  assert.equal(runHook('/ideas-cat 9').reason, 'No idea #9.');
  assert.equal(runHook('/ideas-cat 1 8 9').reason, 'No idea #8, #9.');
  assert.equal(runHook('/ideas-done 9').reason, 'No idea #9.');
  assert.match(runHook('/idea').reason, /^Usage[\s\S]*\/ideas-rm N/);
});

test('/ideas-rm deletes ideas for good, without a model call', () => {
  store.addIdeas(['alpha', 'beta', 'gamma', 'delta']);
  const out = runHook('/ideas-rm 1 #3');
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Removed #1 · alpha\n.*Removed #3 · gamma$/);
  assert.equal(runHook('/ideas-rm 2 9').reason, 'No idea #9.'); // an unknown id deletes nothing
  assert.match(runHook('/ideamine:ideas-rm 4').reason, /Removed #4 · delta/);
  assert.deepEqual(store.load().ideas.map((i) => i.text), ['beta']);
});

test('the board names the dashed commands, and does not send you to a triage', () => {
  store.addIdeas(['alpha']);
  const board = runHook('/ideas').reason;
  for (const tip of [/\/ideas-go/, /\/ideas-all/, /\/ideas-rm N/]) assert.match(board, tip);
  assert.doesNotMatch(board, /\/idea-triage|\/ideas-sort/);
});

test('/ideas-watch turns the watcher on and off, with no model call', () => {
  const on = runHook('/ideas-watch');
  assert.equal(on.decision, 'block');
  assert.match(on.reason, /^ideamine watch: on since /);
  assert.match(runHook('/ideas-watch').reason, /^ideamine watch: on since /);
  assert.match(runHook('/ideamine:ideas-watch off').reason, /^ideamine watch: off/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.home(), 'watch.json'), 'utf8')).on, false);
});

test('while the watcher is on, a saved idea is triaged in the background', async () => {
  runHook('/ideas-watch');
  runHook('/idea make the scroller faster');
  // The hook returns at once. A separate process triages the idea with the stand-in claude.
  const deadline = Date.now() + 20000;
  while (store.load().ideas[0].status === 'inbox' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.equal(store.findIdea(store.load(), 1).triage?.by, 'haiku (headless)');
});

test('handlePrompt filters by project with "here"', async () => {
  store.addIdeas(['mine'], { project: '/a' });
  store.addIdeas(['theirs'], { project: '/b' });
  const board = await handlePrompt('/ideas-ls here', { cwd: '/a' });
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

test('/ideas-find searches by meaning and /ideas-groups groups by meaning, with no model call', async () => {
  const server = await startFakeServer();
  process.env.IDEAMINE_EMBED_URL = `${server.url}/v1`;
  process.env.IDEAMINE_GROUP_THRESHOLD = '0.5';
  try {
    store.addIdeas(['subtitles for audiobooks', 'subtitles for audiobooks on android', 'a tor exit relay']);
    const found = await handlePrompt('/ideas-find audiobooks with subtitles');
    assert.match(found, /^ideas like "audiobooks with subtitles", by meaning\n.*#1 .*\n.*#2 /);
    assert.doesNotMatch(found, /tor exit/);
    const groups = await handlePrompt('/ideas-groups');
    assert.match(groups, /^ideamine groups: 1 group of open ideas/);
    assert.match(groups, /IN NO GROUP\n.*#3 /);
    assert.equal(await handlePrompt('/ideas-groups what is this'), null); // a question: the skill answers
  } finally {
    await server.close();
    delete process.env.IDEAMINE_EMBED_URL;
    delete process.env.IDEAMINE_GROUP_THRESHOLD;
  }
});

test('/ideas-find falls back to words when the embedding server is away', async () => {
  const closed = await startFakeServer();
  await closed.close(); // nothing listens on its port now
  process.env.IDEAMINE_EMBED_URL = `${closed.url}/v1`;
  try {
    store.addIdeas(['subtitles for audiobooks', 'dark mode']);
    const out = runHook('/ideas-find subtitles');
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /by words, because search by meaning is not available \(cannot reach/);
    assert.match(out.reason, /#1 /);
    assert.doesNotMatch(out.reason, /#2 /);
  } finally {
    delete process.env.IDEAMINE_EMBED_URL;
  }
});
