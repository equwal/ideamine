// The folders that an idea can belong to. The triage pairs each idea with one of them, because the
// folder where the user saved an idea is often the scratch folder of an unrelated chat.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_PROJECTS = 40;

/** True when two paths name the same folder: case-insensitive on Windows, trailing slashes ignored. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** A folder that can hold a project: it exists, and it is not a drive root, the home, or a scratch folder. */
function isProjectDir(dir) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return false;
  }
  const full = path.resolve(dir);
  // The Claude desktop app makes a scratch folder for each chat that has no project folder.
  return stat.isDirectory() && path.dirname(full) !== full && !samePath(full, os.homedir()) && !/[\\/]scratch-workspaces[\\/]/i.test(full);
}

/** The first line of the README, else the package.json description: enough for the triage to match. */
function describe(dir) {
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
      const first = lines.map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
      if (first) return first.slice(0, 100);
    } catch {
      // No README with this name.
    }
  }
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description || '').slice(0, 100);
  } catch {
    return '';
  }
}

/**
 * Project folders on this machine: the folders of the ideas, then the projects that Claude Code
 * knows (the keys of "projects" in .claude.json). Each has a unique `name` (the folder name, with a
 * number when two folders have the same name), the `dir`, and a one-line `about`.
 */
export function knownProjects(db, { configDir = process.env.CLAUDE_CONFIG_DIR || os.homedir() } = {}) {
  const dirs = [];
  const add = (dir) => {
    if (dir && isProjectDir(dir) && !dirs.some((d) => samePath(d, dir))) dirs.push(path.resolve(dir));
  };
  for (const idea of db.ideas) add(idea.project);
  try {
    const config = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
    for (const dir of Object.keys(config.projects || {})) add(dir);
  } catch {
    // No Claude Code config: the folders of the ideas are the only candidates.
  }
  const taken = new Set();
  return dirs.slice(0, MAX_PROJECTS).map((dir) => {
    const base = path.basename(dir);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    taken.add(name.toLowerCase());
    return { name, dir, about: describe(dir) };
  });
}

/** The project that a triage answer names: by its name (as the prompt shows it) or by its full path. */
export function findProject(projects, answer) {
  if (!answer) return null;
  const key = String(answer).trim().toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === key) || projects.find((p) => samePath(p.dir, answer)) || null;
}
