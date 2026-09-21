import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));

beforeEach(() => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-cli-'));
});

function cli(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: process.env });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

test('the CLI uses the same unix verbs as /ideas: ls, cat, rm, sort', () => {
  for (const idea of ['alpha', 'beta', 'gamma']) assert.equal(cli('add', idea).code, 0);
  assert.match(cli('cat', '1', '#3').out, /^#1 alpha\n[\s\S]*\n\n#3 gamma\n/);
  assert.equal(cli('rm', '2').out, 'Removed #2 beta\n');

  const missing = cli('rm', '1', '9');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no idea #9/); // and #1 is still there

  const all = cli('ls', '-a').out;
  assert.match(all, /\[showing: all\][\s\S]*#3[\s\S]*#1/);
  assert.doesNotMatch(all, /#2 /);
  assert.match(cli('sort', '--dry-run').out, / -p --model sonnet [\s\S]*Ideas to triage \(2\)/);
});
