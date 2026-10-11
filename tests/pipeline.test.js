import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('the pipeline ships with its seven agents, and the skill names each of them', () => {
  const root = new URL('../', import.meta.url);
  const files = fs.readdirSync(new URL('agents/', root)).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, ['e2e-tester.md', 'engineer.md', 'integrator.md', 'project-manager.md', 'researcher.md', 'story-writer.md', 'validator.md']);
  const skill = fs.readFileSync(new URL('skills/pipeline/SKILL.md', root), 'utf8');
  for (const file of files) {
    const name = file.slice(0, -3);
    const text = fs.readFileSync(new URL(`agents/${file}`, root), 'utf8');
    assert.match(text, new RegExp(`^name: ${name}$`, 'm'), `${file} names itself`);
    assert.match(skill, new RegExp(`\\b${name}\\b`), `the pipeline skill names ${name}`);
  }
});
