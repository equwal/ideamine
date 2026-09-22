// Running the Claude Code CLI from ideamine: headless triage and questions, and launching a session
// to build an idea.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fresh, triage } from './archive.js';
import { knownProjects } from './projects.js';
import { renderMarkdown } from './render.js';
import { BATCH_SCHEMA, pendingIdeas, triagePrompt } from './rubric.js';
import { counts, findIdea, normalizeModel } from './store.js';

/** Claude Code executable: explicit override, else the one running us (desktop app), else PATH. */
export function claudeBin() {
  return process.env.IDEAMINE_CLAUDE_BIN || process.env.CLAUDE_CODE_EXECPATH || 'claude';
}

function command(args) {
  const bin = claudeBin();
  // A .js file is run with node, which keeps a stand-in CLI portable (used by the tests).
  return /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

/**
 * Environment for a separate, independent Claude Code process: drop the variables that tie a
 * child to the session that started us (nesting guard, host messaging, the parent's effort), and
 * IDEAMINE_WINDOW, so that an ideamine command in that session never waits for a key.
 */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'CLAUDECODE' ||
      key === 'IDEAMINE_WINDOW' ||
      key === 'CLAUDE_PID' ||
      key === 'CLAUDE_EFFORT' ||
      key === 'AI_AGENT' ||
      /^CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|HOST_SESSION_ID|SESSION_ID|SESSION_ATTENDED|MESSAGING_.*|SDK_.*|EXECPATH)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

let claudeFound = null;

/** True when the Claude Code CLI starts on this machine. The answer is kept for the life of the process. */
export function hasClaude() {
  if (claudeFound === null) {
    const [bin, argv] = command(['--version']);
    claudeFound = spawnSync(bin, argv, { stdio: 'ignore', windowsHide: true, timeout: 20000, env: childEnv() }).status === 0;
  }
  return claudeFound;
}

function parseLooseJson(text) {
  const s = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function run(args, input, timeoutMs, env = {}) {
  const [bin, argv] = command(args);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { env: { ...childEnv(), ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`Claude Code CLI not found ("${bin}"). Install it or set IDEAMINE_CLAUDE_BIN.`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/**
 * Arguments for a one-shot `claude -p` call: no tools, no MCP servers, no settings, JSON output.
 * Skipping settings drops hooks, plugins, and skill listings: ~4k fewer input tokens per call.
 * Set IDEAMINE_SETTING_SOURCES=user if your login depends on settings.json (apiKeyHelper, env).
 */
function headlessArgs({ model, budget, system, extra = [] }) {
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    ...extra,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', process.env.IDEAMINE_SETTING_SOURCES ?? '',
    '--no-session-persistence',
    '--max-budget-usd', String(budget),
    '--system-prompt', system,
  ];
  // Haiku takes no effort setting.
  if (model !== 'haiku') args.push('--effort', 'low');
  return args;
}

/** Run a headless call. Returns the JSON result of the CLI, or throws with the reason. */
async function runHeadless(args, prompt, { timeoutMs, env = {} }) {
  const res = await run(args, prompt, timeoutMs, env);
  let out;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n');
    throw new Error(`claude exited with code ${res.code}: ${detail || 'no output'}`);
  }
  if (out.is_error) throw new Error(`claude: ${out.result || out.subtype || 'error'}`);
  return out;
}

/** Input tokens (with the cache) and output tokens of a headless call. */
function tokensOf(out) {
  const u = out.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return { input, output: u.output_tokens || 0 };
}

/**
 * Triage the inbox with a one-shot `claude -p` call: no tools, no MCP servers, no settings, a
 * two-line system prompt, and JSON-schema output. Runs on the user's normal Claude Code login and
 * costs about 400 tokens per idea, whatever model the calling session uses. `ids` triages those
 * ideas instead of the inbox. The triage also pairs each idea with a project folder of this machine.
 */
export async function headlessTriage({ model = process.env.IDEAMINE_TRIAGE_MODEL || 'sonnet', ids = null, limit = 20, dryRun = false, budget = 1 } = {}) {
  const alias = normalizeModel(model) || model;
  const db = await fresh();
  const pending = pendingIdeas(db, { ids, limit });
  if (!pending.length) return { message: 'Nothing to triage: the inbox is empty.' };

  const projects = knownProjects(db);
  const prompt = `${triagePrompt(db, pending, projects)}\n\nReturn one verdict for every idea listed above.`;
  const args = headlessArgs({
    model: alias,
    budget,
    system: 'You triage a developer\'s backlog of ideas. Follow the rubric exactly and answer only with the requested JSON.',
    extra: ['--json-schema', JSON.stringify(BATCH_SCHEMA)],
  });
  // Haiku's thinking was about 70% of its output tokens and did not change the verdicts, so it gets
  // no thinking.
  const env = alias === 'haiku' ? { MAX_THINKING_TOKENS: '0' } : {};
  if (dryRun) {
    const shown = args.map((a) => (/[\s"{]/.test(a) || !a ? JSON.stringify(a) : a)).join(' ');
    const vars = Object.entries(env).map(([k, v]) => `${k}=${v} `).join('');
    return { message: `${vars}${claudeBin()} ${shown}\n\n${prompt}` };
  }

  const out = await runHeadless(args, prompt, { timeoutMs: 5 * 60 * 1000, env });
  const data = out.structured_output ?? parseLooseJson(out.result);
  if (!Array.isArray(data?.verdicts)) throw new Error('claude answered without verdicts');
  const results = await triage(data.verdicts, { by: `${alias} (headless)`, projects });
  if (results.queued) return { message: `The verdicts wait for the ideamine server: ${results.reason}` };
  return { results, model: alias, cost: out.total_cost_usd, tokens: tokensOf(out) };
}

/**
 * Answer a question about the archive, like `/ideas <question>`, with one headless call. The
 * prompt is the Markdown export: every idea with its lane, verdict, model, and brief.
 */
export async function askAboutIdeas(question, { model = 'sonnet', budget = 0.5 } = {}) {
  const alias = normalizeModel(model) || model;
  const args = headlessArgs({
    model: alias,
    budget,
    system: 'You answer questions about a developer\'s backlog of ideas. Answer in a few short lines of plain text. Name each idea by its number, like #12.',
  });
  const out = await runHeadless(args, `${renderMarkdown(await fresh())}\nQuestion: ${question}`, { timeoutMs: 2 * 60 * 1000 });
  return { answer: String(out.result || '').trim(), model: alias, cost: out.total_cost_usd, tokens: tokensOf(out) };
}

/**
 * The triage that /ideas-go needs before it picks: the idea `id` when it has no verdict, else the
 * whole inbox. Returns the headlessTriage result, or null when every candidate has a verdict already.
 */
export async function triageFirst({ id = null, model } = {}) {
  const db = await fresh();
  if (id != null) {
    const idea = findIdea(db, id);
    return idea && !idea.triage ? headlessTriage({ model, ids: [idea.id] }) : null;
  }
  return counts(db).inbox ? headlessTriage({ model }) : null;
}

/** The opening prompt for a fresh session that builds one idea. */
export function buildPrompt(idea) {
  const t = idea.triage;
  const lines = [`Build idea #${idea.id} from my ideamine archive: ${idea.title}`, ''];
  if (t?.brief) lines.push(t.brief, '');
  lines.push('My original note:', idea.text, '');
  lines.push(
    `When you finish, record the outcome with the ideamine idea_update tool (id ${idea.id}, status "done", a one-line note), ` +
      `or run: ideamine done ${idea.id} "<one-line outcome>"`,
  );
  return lines.join('\n');
}

/**
 * How `ideamine go` builds an idea: on its recommended model, in its project folder when that
 * folder still exists, else in `fallback`.
 */
export function goPlan(idea, fallback) {
  return {
    model: idea.triage?.model || 'sonnet',
    dir: idea.project && fs.existsSync(idea.project) ? idea.project : fallback,
    prompt: buildPrompt(idea),
  };
}

/** Start an interactive Claude Code session on the recommended model. */
export function launchSession({ model, prompt, cwd }) {
  const [bin, argv] = command(['--model', model, prompt]);
  const res = spawnSync(bin, argv, { cwd, stdio: 'inherit', env: childEnv() });
  if (res.error) throw res.error;
  return res.status ?? 0;
}
