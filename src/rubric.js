// How ideas are judged and which model builds them. Both triage paths (the MCP tool used by
// /ideas go and /ideas sort, and the headless `ideamine sort`) read this file.

import path from 'node:path';
import { lane, listIdeas } from './store.js';
import { clip } from './text.js';

// Aliases are what Claude Code accepts (`claude --model sonnet`, Agent tool `model: "sonnet"`),
// so a recommendation stays valid when a new generation ships under the same alias.
// Prices: USD per million input/output tokens.
export const MODELS = [
  {
    alias: 'haiku',
    name: 'Claude Haiku 4.5',
    price: '$1/$5',
    use: 'mechanical, fully specified, local work: typos, renames, config tweaks, boilerplate, small scripts, lookups',
  },
  {
    alias: 'sonnet',
    name: 'Claude Sonnet 5',
    price: '$2/$10',
    use: 'the default: ordinary features, bug fixes with a clear repro, tests, docs, contained refactors',
  },
  {
    alias: 'opus',
    name: 'Claude Opus 5',
    price: '$5/$25',
    use: 'ambiguous or cross-cutting work: architecture, hard debugging, performance, security, unfamiliar domains',
  },
  {
    alias: 'fable',
    name: 'Claude Fable 5.1',
    price: '$10/$50',
    use: 'only the hardest long-horizon or research-grade problems, where Opus would likely fail',
  },
];

export const RUBRIC = `Triage each idea. Be decisive: the user wants a short list worth building, not encouragement.

For every idea return:
- verdict: "do" (clear value, worth building soon) | "maybe" (unclear value, blocked, or needs a decision from the user) | "skip" (low value, already exists, or costs far more than it returns)
- impact: 1-5, how much it would matter to the user or project if it shipped
- size: xs (<15 min) | s (<1 h) | m (a few hours) | l (1-2 days) | xl (multi-day, should be split)
- model: the CHEAPEST model likely to finish it in one pass. A failed attempt on a weaker model plus a retry costs more than the right model once.
${MODELS.map((m) => `    ${m.alias.padEnd(6)} ${m.price.padEnd(7)} ${m.use}`).join('\n')}
    (prices in USD per million input/output tokens)
- title: imperative, at most 60 characters ("Add ...", "Fix ...")
- why: one sentence with the deciding reason
- brief: 1-4 sentences an agent can act on without this conversation: goal, scope, and "done when". Leave empty for skip.
- dup_of: id of an existing idea this one duplicates (use verdict "skip"), if any`;

/** JSON Schema for a batch of verdicts; used for `claude -p --json-schema` and the MCP tool. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    verdict: { type: 'string', enum: ['do', 'maybe', 'skip'] },
    impact: { type: 'integer', minimum: 1, maximum: 5 },
    size: { type: 'string', enum: ['xs', 's', 'm', 'l', 'xl'] },
    model: { type: 'string', enum: MODELS.map((m) => m.alias) },
    title: { type: 'string' },
    why: { type: 'string' },
    brief: { type: 'string' },
    dup_of: { type: 'integer' },
  },
  required: ['id', 'verdict', 'impact', 'size', 'model', 'title', 'why', 'brief'],
};

export const BATCH_SCHEMA = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: VERDICT_SCHEMA } },
  required: ['verdicts'],
};

/** Ideas waiting for a verdict: the inbox, or the given ids (re-triage). */
export function pendingIdeas(db, { ids = null, limit = 30 } = {}) {
  if (Array.isArray(ids) && ids.length) {
    const wanted = new Set(ids.map(Number));
    return db.ideas.filter((i) => wanted.has(i.id));
  }
  return listIdeas(db, { filter: 'inbox' }).reverse().slice(0, limit); // oldest first
}

/** The rubric plus the ideas to judge, as one prompt. */
export function triagePrompt(db, pending) {
  const pendingIds = new Set(pending.map((i) => i.id));
  const existing = db.ideas
    .filter((i) => !pendingIds.has(i.id) && ['do', 'maybe', 'doing', 'done'].includes(lane(i)))
    .slice(-60)
    .map((i) => `#${i.id} ${clip(i.title, 70)} (${lane(i)})`);
  const lines = [RUBRIC, ''];
  if (existing.length) lines.push('Existing ideas, for duplicate checks:', ...existing, '');
  lines.push(`Ideas to triage (${pending.length}):`);
  for (const i of pending) {
    const ctx = [i.project && `project: ${path.basename(i.project)}`, i.tags?.length && `tags: ${i.tags.join(', ')}`]
      .filter(Boolean)
      .join('; ');
    lines.push(`#${i.id}${ctx ? ` [${ctx}]` : ''}: ${i.text.replace(/\r?\n/g, ' / ')}`);
  }
  return lines.join('\n');
}
