// The ideamine MCP server: the capture tools of ideahook, plus triage and next-idea, plus the
// slash-command prompts that mirror the skills.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as archive from 'ideahook/archive';
import { currentProject, handlers as captureHandlers, INSTRUCTIONS, serve as serveIdeahook, tools as captureTools } from 'ideahook/mcp';
import { knownProjects } from 'ideahook/projects';
import { renderBoard, renderIdea } from 'ideahook/render';
import { counts, findIdea, lane, load, pickNext } from 'ideahook/store';
import { clip } from 'ideahook/text';
import { headlessTriage, triageFirst } from './claude.js';
import { BATCH_SCHEMA, MODELS, pendingIdeas, triagePrompt } from './rubric.js';

const ROOT = new URL('..', import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(new URL('package.json', ROOT), 'utf8')).version;
const MODEL_ENUM = MODELS.map((m) => m.alias);

const triageTool = {
    name: 'idea_triage',
    description:
      'Triage ideas: decide which are worth doing and the cheapest model that can build each. headless=true ' +
      'does it in a separate minimal Claude Code call (cheapest; your context is not used). Otherwise call with ' +
      'no verdicts to get the rubric and the untriaged ideas, then call once more with all verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Triage the inbox in a separate low-cost `claude -p` call.' },
        model: { type: 'string', enum: MODEL_ENUM, description: 'Model for headless triage (default sonnet).' },
        verdicts: BATCH_SCHEMA.properties.verdicts,
        ids: { type: 'array', items: { type: 'integer' }, description: 'Re-triage these ideas instead of the inbox.' },
        limit: { type: 'integer', description: 'Max ideas (default 20 headless, 30 otherwise).' },
        by: { type: 'string', description: 'Your model name, recorded with the verdicts.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Triage ideas', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const nextTool = {
    name: 'idea_next',
    description:
      'Pick the idea to build next (verdict "do" before "maybe", current project first, then best value per ' +
      'effort), or fetch one by id. Returns its brief, project, and the model recommended to build it. Without ' +
      'id, it also returns the whole queue. triage=true first triages the untriaged candidates (the inbox, or ' +
      'the given id) in one headless call.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        here: { type: 'boolean', description: 'Only consider ideas from the current project.' },
        triage: { type: 'boolean', description: 'Triage untriaged candidates first, so the pick and the model are current.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Next idea', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const byName = (name) => captureTools.find((t) => t.name === name);

// The order that clients see.
const TOOLS = [byName('idea_add'), byName('idea_list'), triageTool, byName('idea_update'), nextTool, byName('idea_remove')];

// Slash commands for clients that load this server without the plugin (the plugin ships skills instead).
// The prompt text is the matching SKILL.md body, so both stay in sync.
const PROMPTS = [
  { name: 'idea', description: 'Save an idea for later', arguments: [{ name: 'text', required: true }] },
  { name: 'ideas', description: 'Show the queue, or ask about your ideas', arguments: [{ name: 'question', required: false }] },
  { name: 'ideas-ls', description: 'List the queue, one lane, or every lane (-a)', arguments: [{ name: 'lane', required: false }] },
  { name: 'ideas-cat', description: 'Show ideas in full', arguments: [{ name: 'ids', required: true }] },
  { name: 'ideas-rm', description: 'Delete ideas for good', arguments: [{ name: 'ids', required: true }] },
  { name: 'ideas-find', description: 'Search ideas by meaning', arguments: [{ name: 'words', required: true }] },
  { name: 'ideas-groups', description: 'Show ideas grouped by meaning', arguments: [{ name: 'lane', required: false }] },
  { name: 'ideas-done', description: 'Mark an idea done', arguments: [{ name: 'id', required: true }, { name: 'note', required: false }] },
  { name: 'ideas-reopen', description: 'Put an idea back in the queue', arguments: [{ name: 'id', required: true }] },
  { name: 'ideas-go', description: 'Build the next idea on its recommended model', arguments: [{ name: 'id', required: false }] },
  { name: 'ideas-pipeline', description: 'Build the next idea through the agent pipeline', arguments: [{ name: 'id', required: false }] },
  { name: 'ideas-all', description: 'Do every idea that fits this chat', arguments: [] },
  { name: 'ideas-sort', description: 'Triage the inbox now and show the queue', arguments: [] },
  { name: 'ideas-watch', description: 'Turn the background watcher on or off', arguments: [{ name: 'off', required: false }] },
  { name: 'ideas-web', description: 'Start or stop the dashboard with buttons on this PC', arguments: [{ name: 'off', required: false }] },
  { name: 'ideas-sync', description: 'Share one archive between your machines through an ideamine server', arguments: [{ name: 'url', required: false }] },
  { name: 'pipeline', description: 'Run the agent pipeline for a feature request: research, storyboard, plan, engineers, test, validate', arguments: [{ name: 'request', required: true }] },
];

function skillBody(name, args) {
  const file = new URL(`skills/${name}/SKILL.md`, ROOT);
  const text = fs.readFileSync(fileURLToPath(file), 'utf8').replace(/^---[\s\S]*?\n---\s*\n/, '');
  return text.replaceAll('$ARGUMENTS', args || '').trim();
}

function summarizeTriage(results, how = '') {
  const ok = results.filter((r) => !r.error);
  const tally = ['do', 'maybe', 'skip'].map((v) => `${ok.filter((r) => r.verdict === v).length} ${v}`).join(' · ');
  const lines = [`Saved ${ok.length} verdict${ok.length === 1 ? '' : 's'}: ${tally}${how ? ` (${how})` : ''}`];
  for (const r of ok) {
    const meta = r.verdict === 'skip' ? '' : ` · ${r.model} · ${r.size.toUpperCase()}`;
    lines.push(`  #${r.id} ${r.verdict}${meta}  ${clip(r.title, 60)}${r.moved ? `  → ${path.basename(r.moved)}` : ''}`);
  }
  for (const r of results.filter((x) => x.error)) lines.push(`  #${r.id} not saved: ${r.error}`);
  const left = counts(load()).inbox;
  if (left) lines.push(`${left} still in inbox.`);
  return lines.join('\n');
}

export function headlessSummary(out) {
  return out.message || summarizeTriage(out.results, `${out.model}, ${out.tokens.input} in / ${out.tokens.output} out tokens`);
}

/** The board after a triage, so the user sees every idea in its new place. */
function withBoard(text) {
  return `${text}\n\n${renderBoard(load(), { cwd: currentProject(), hints: true })}`;
}

// Tool handlers return plain text for the model.
const handlers = {
  ...captureHandlers,
  async idea_triage({ verdicts, ids, limit, by, headless = false, model }) {
    if (headless) {
      return withBoard(headlessSummary(await headlessTriage({ model, limit: limit || 20 })));
    }
    if (Array.isArray(verdicts) && verdicts.length) {
      const projects = knownProjects(await archive.fresh());
      const results = await archive.triage(verdicts, { by: by ? clip(by, 40) : 'claude', projects });
      return results.queued ? archive.queuedText(results) : withBoard(summarizeTriage(results));
    }
    limit ||= 30;
    const db = await archive.fresh();
    const pending = pendingIdeas(db, { ids, limit });
    if (!pending.length) return 'Nothing to triage: the inbox is empty.';
    return (
      triagePrompt(db, pending, knownProjects(db)) +
      '\n\nSave every verdict in ONE idea_triage call: ' +
      '{"verdicts":[{"id":1,"verdict":"do","impact":3,"size":"s","model":"sonnet","title":"...","why":"...","brief":"...","project":"..."}]}'
    );
  },

  async idea_next({ id, here = false, triage = false }) {
    const out = [];
    if (triage) {
      try {
        const res = await triageFirst({ id });
        if (res) out.push(headlessSummary(res));
      } catch (e) {
        out.push(`Triage failed: ${e.message}`);
      }
    }
    const db = await archive.fresh();
    let idea;
    if (id != null) {
      idea = findIdea(db, id);
      if (!idea) throw new Error(`no idea #${id}`);
    } else {
      idea = pickNext(db, { project: currentProject(), only: here });
    }
    if (!idea) {
      const c = counts(db);
      out.push(
        c.inbox
          ? `No idea is ready: ${c.inbox} untriaged in the inbox.${triage ? '' : ' Pass triage: true to triage them first.'}`
          : `The queue is empty${here ? ' for this project' : ''}.`,
      );
      return out.join('\n\n');
    }
    const t = idea.triage;
    const lines = [renderIdea(idea), ''];
    if (!t) lines.push('recommended model: none yet (untriaged)');
    else lines.push(`recommended model: ${t.model}`);
    // Ideas are saved from any session, so the recorded folder can be a scratch folder that is gone.
    const dir = idea.project;
    lines.push(`project dir: ${dir ? `${dir} (${fs.existsSync(dir) ? 'exists' : 'does not exist'})` : '(none recorded)'}`);
    out.push(lines.join('\n'));
    // The whole queue, so the caller can choose an idea that fits its chat better than the first one.
    if (id == null) out.push(`The queue:\n${renderBoard(db, { cwd: currentProject() })}`);
    return out.join('\n\n');
  },

};

/** Serve MCP on stdin/stdout. `prompts: false` when running as a plugin (skills cover slash commands). */
export function serve({ prompts = true } = {}) {
  return serveIdeahook({
    name: 'ideamine',
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    handlers,
    prompts: prompts ? PROMPTS : [],
    promptBody: skillBody,
  });
}
