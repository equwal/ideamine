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

// Run npm's own script with this node: no PATH lookup, so it works where npm is not on PATH (Guix on g).
const bin = path.dirname(process.execPath);
const cli = [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
const args = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];
const r = cli
  ? spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
  : spawnSync('npm ' + args.join(' '), { cwd: root, encoding: 'utf8', shell: true });
if (r.status !== 0) {
  process.stderr.write(`ideamine: npm ci failed\n${r.stdout || ''}${r.stderr || ''}`);
  process.exit(1);
}
