import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findProject, knownProjects } from '../src/projects.js';

test('knownProjects lists real project folders once, each with a short description', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-known-'));
  const dir = (...parts) => {
    const d = path.join(root, ...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const alpha = dir('alpha');
  const beta = dir('beta');
  const bare = dir('bare');
  const otherAlpha = dir('work', 'alpha'); // the same folder name as the first alpha
  const scratch = dir('Claude', 'scratch-workspaces', 'abc', 'scratch-2026-09-21-1a2b3c');
  fs.writeFileSync(path.join(alpha, 'README.md'), '\n# Alpha: a scroller extension\n\nMore text.\n');
  fs.writeFileSync(path.join(beta, 'package.json'), JSON.stringify({ description: 'Beta, a logo maker' }));
  const config = dir('config');
  const claudeProjects = {
    [alpha.replaceAll('\\', '/')]: {}, // Claude Code keeps some paths with forward slashes
    [scratch]: {},
    [path.join(root, 'gone')]: {},
    [os.homedir()]: {},
    [bare]: {},
    [otherAlpha]: {},
  };
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: claudeProjects }));

  const db = { ideas: [{ project: beta }, { project: alpha }, { project: scratch }, { project: null }] };
  const found = knownProjects(db, { configDir: config });
  // The folders of the ideas come first, then the other Claude Code projects. Each name is unique.
  assert.deepEqual(found, [
    { name: 'beta', dir: beta, about: 'Beta, a logo maker' },
    { name: 'alpha', dir: alpha, about: 'Alpha: a scroller extension' },
    { name: 'bare', dir: bare, about: '' },
    { name: 'alpha-2', dir: otherAlpha, about: '' },
  ]);
  assert.deepEqual(knownProjects(db, { configDir: path.join(root, 'no-config') }).map((p) => p.dir), [beta, alpha]);
});

test('findProject matches the name that the triage gives, or the full path', () => {
  const projects = [
    { name: 'alpha', dir: path.resolve('/p/alpha'), about: '' },
    { name: 'alpha-2', dir: path.resolve('/q/alpha'), about: '' },
  ];
  assert.equal(findProject(projects, 'alpha').dir, path.resolve('/p/alpha'));
  assert.equal(findProject(projects, 'ALPHA-2').dir, path.resolve('/q/alpha'));
  assert.equal(findProject(projects, path.resolve('/q/alpha')).name, 'alpha-2');
  assert.equal(findProject(projects, ''), null);
  assert.equal(findProject(projects, 'gamma'), null);
  assert.equal(findProject(projects, undefined), null);
});
