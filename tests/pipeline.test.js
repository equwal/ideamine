// Checks that /ideas-pipeline and the seven pipeline agents fit together. The pipeline itself runs in a
// Claude Code session, so these tests do not run it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const plugin = JSON.parse(read('.claude-plugin/plugin.json')).name;
const skill = read('skills/ideas-pipeline/SKILL.md');
const agentFiles = fs.readdirSync(new URL('../agents', import.meta.url)).filter((f) => f.endsWith('.md'));
const frontmatter = (text) =>
  Object.fromEntries([...text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)[1].matchAll(/^([\w-]+): (.*?)\r?$/gm)].map((m) => [m[1], m[2]]));

test('the pipeline skill names each agent of the plugin, and each name is an agent', () => {
  const named = new Set([...skill.matchAll(new RegExp(`\`${plugin}:([\\w-]+)\``, 'g'))].map((m) => m[1]));
  const agents = agentFiles.map((f) => frontmatter(read(`agents/${f}`)).name);
  assert.equal(agents.length, 7);
  assert.deepEqual([...named].sort(), agents.sort());
});

test('each agent has a name that matches its file, a description, and a model', () => {
  for (const f of agentFiles) {
    const fm = frontmatter(read(`agents/${f}`));
    assert.equal(fm.name, f.replace(/\.md$/, ''), f);
    assert.ok(fm.description && fm.model, f);
  }
});

test('the pipeline skill may call each ideamine tool that it tells Claude to call', () => {
  const allowed = skill.match(/^allowed-tools: (.*?)\r?$/m)[1].split(/,\s*/);
  const told = new Set([...skill.matchAll(/`(idea_[a-z]+)`/g)].map((m) => m[1]));
  assert.ok(told.size >= 3);
  for (const tool of told) assert.ok(allowed.includes(`mcp__plugin_${plugin}_${plugin}__${tool}`), tool);
});

test('the package ships the agents', () => {
  assert.ok(JSON.parse(read('package.json')).files.includes('agents'));
});
