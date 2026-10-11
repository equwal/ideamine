#!/usr/bin/env node
// SessionStart hook: Claude Code plugins do not run npm, so install the dependencies here.
// Skips when node_modules is newer than package-lock.json (no network, no output).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
// npm rewrites node_modules/.package-lock.json on every install.
const have = mtime(path.join(root, 'node_modules', '.package-lock.json'));
const want = mtime(path.join(root, 'package-lock.json'));
const hook = fs.existsSync(path.join(root, 'node_modules', 'ideahook'));
if (hook && have >= want) process.exit(0);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (r.status !== 0) {
  process.stderr.write(`ideamine: npm ci failed\n${r.stdout || ''}${r.stderr || ''}`);
  process.exit(1);
}
