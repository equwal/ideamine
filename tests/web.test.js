// The plugin's /ideas-web verb and CLI error path, on top of ideamine-web.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as serve from 'ideamine-web/serve';
import * as store from 'ideahook/store';
import { handlePrompt } from '../src/hook.js';
import { freePort } from './fixtures/server-process.js';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-web-'));
for (const name of ['IDEAMINE_SYNC_URL', 'IDEAMINE_SERVE_HOSTS']) delete process.env[name];

test('/ideas-web starts the server in the background, and /ideas-web off stops it', async () => {
  process.env.IDEAMINE_SERVE_PORT = String(await freePort());
  const address = `http://127.0.0.1:${process.env.IDEAMINE_SERVE_PORT}/`;
  try {
    // Several rounds, because a stopped server once went on to answer on a kept-alive connection:
    // the next /ideas-web then said "running" and started nothing.
    for (let round = 0; round < 3; round++) {
      assert.equal(await handlePrompt('/ideas-web'), `ideamine web: ${address} (started)`);
      assert.equal(await handlePrompt('/ideamine:ideas-web'), `ideamine web: ${address}`);
      assert.equal((await fetch(new URL('data.json', address))).status, 200);
      assert.equal(await handlePrompt('/ideas-web off'), 'ideamine web: stopped.');
      assert.equal(await handlePrompt('/ideas-web off'), 'ideamine web: not running.');
    }
    assert.match(fs.readFileSync(path.join(store.home(), 'serve.log'), 'utf8'), /the dashboard with buttons runs at /);
    assert.equal(await handlePrompt('/ideas-web something else'), null); // not a command: the skill answers
  } finally {
    await serve.stopRunning(); // never leave a server behind
    delete process.env.IDEAMINE_SERVE_PORT;
  }
});

test('a window that failed waits for a key only when a person can press one', () => {
  // IDEAMINE_WINDOW comes from the window of the page. Without a terminal, the error must not wait.
  const r = spawnSync(process.execPath, [BIN, 'cat', '9'], { encoding: 'utf8', env: { ...process.env, IDEAMINE_WINDOW: '1' }, timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no idea #9/);
});
