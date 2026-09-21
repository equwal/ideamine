// UserPromptSubmit hook: answers /idea, /ideas, and the local /ideas-* commands (ls, cat, rm, done,
// reopen, watch) and blocks the prompt, so the model is never called. That makes capture free,
// instant, and possible even when the session is out of usage. Every other prompt passes through
// untouched, including /ideas-go, /ideas-all, /ideas-sort, and questions, which their skills answer.
// After each prompt, the hook lets the watcher start a background pass when there is work.

import { renderAdded, renderBoard, renderIdea } from './render.js';
import { addIdeas, FILTERS, findIdea, lane, load, removeIdeas, updateIdea } from './store.js';
import { clip, splitIdeas } from './text.js';
import * as watch from './watch.js';

// `/idea ...`, `/ideas ...`, `/ideas-<verb> ...`, and the plugin-qualified `/ideamine:...` forms.
// Each verb is a separate skill with a dash, so that the slash menu shows it.
const COMMAND = /^\s*\/(?:ideamine:)?(idea|ideas(?:-[a-z]+)?)(?=\s|$)([\s\S]*)$/i;
const STATUS_COMMANDS = { 'ideas-done': 'done', 'ideas-reopen': 'reopen' };
const ID = /^#?\d+$/;

const USAGE = `Usage: /idea <text>                add an idea (a bulleted list adds one idea per bullet)
       /ideas [question]            show the queue, or ask about your ideas
       /ideas-ls [lane|-a] [here]   list. Lanes: inbox do maybe skip doing done dropped
       /ideas-cat N...              show ideas in full
       /ideas-rm N...               delete ideas for good
       /ideas-done N [note] · /ideas-reopen N
These call the model:
       /ideas-go [N]                build the next idea, or #N, on its model. New ideas are triaged first.
       /ideas-all                   do every idea that fits this chat. The others stay in the queue.
       /ideas-sort                  triage the inbox now and show the queue
       /ideas-watch [off]           Haiku triages new ideas and pairs them with projects, in the background`;

const noIdea = (ids) => `No idea ${ids.map((id) => `#${String(id).replace(/^#/, '')}`).join(', ')}.`;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Handle one prompt. Returns the text to show the user, or null to let the prompt through. */
export function handlePrompt(prompt, { cwd = process.cwd(), session = null } = {}) {
  const m = COMMAND.exec(prompt || '');
  if (!m) return null;
  const command = m[1].toLowerCase();
  const arg = m[2].trim();

  if (command === 'idea') {
    if (!arg) return USAGE;
    const results = addIdeas(splitIdeas(arg), { source: 'hook', project: cwd, session });
    return renderAdded(results, load());
  }

  if (command === 'ideas-watch') {
    if (!arg) watch.turnOn();
    else if (/^off$/i.test(arg)) watch.turnOff();
    else return null;
    return watch.status(); // runHook starts the first pass after this
  }

  const words = arg.split(/\s+/).filter(Boolean);
  const ids = words.length > 0 && words.every((w) => ID.test(w)) ? words : null;
  const db = load();

  if (command === 'ideas' && !words.length) return renderBoard(db, { cwd, hints: true });

  if (command === 'ideas-ls') {
    const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
    const filters = lower.filter((w) => FILTERS.includes(w));
    const here = lower.includes('here');
    if (filters.length + (here ? 1 : 0) === lower.length && filters.length <= 1) {
      return renderBoard(db, { filter: filters[0] || 'open', project: here ? cwd : null, cwd, hints: true });
    }
  }

  if ((command === 'ideas-cat' || command === 'ideas-rm') && ids) {
    const missing = ids.filter((id) => !findIdea(db, id));
    if (missing.length) return noIdea(missing);
    if (command === 'ideas-cat') return ids.map((id) => renderIdea(findIdea(db, id))).join('\n\n');
    return removeIdeas(ids).map((i) => `✗ Removed #${i.id} · ${clip(i.title, 60)}`).join('\n');
  }

  const status = STATUS_COMMANDS[command];
  if (status && words[0] && ID.test(words[0])) {
    if (!findIdea(db, words[0])) return noIdea([words[0]]);
    const note = words.slice(1).join(' ');
    const idea = updateIdea(words[0], { status, note: note || undefined });
    return `✓ #${idea.id} ${clip(idea.title, 60)} → ${lane(idea)}${note ? ' (note added)' : ''}`;
  }

  return null; // a question, /ideas-go, -all, -sort, or other words: the skill answers with the model
}

export async function runHook() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not a hook payload; stay out of the way
  }
  let message = null;
  try {
    message = handlePrompt(typeof input?.prompt === 'string' ? input.prompt : '', {
      cwd: input.cwd || process.cwd(),
      session: input.session_id || null,
    });
  } catch (e) {
    // Never swallow the user's text: let the prompt through so the /idea skill can save it via MCP.
    process.stderr.write(`ideamine: ${e.message}\n`);
  }
  if (message != null) {
    // Blocking ends the turn before any API request. suppressOriginalPrompt keeps Claude Code from
    // echoing the command back under our message.
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: message,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    }));
  }
  // Each prompt lets the watcher catch up, so it keeps going while it is on.
  try {
    watch.kick();
  } catch {
    // The watcher must never stop a prompt.
  }
}
