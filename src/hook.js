// UserPromptSubmit hook: answers /idea and the local /ideas commands (ls, cat, rm, done, ...) and
// blocks the prompt, so the model is never called. That makes capture free, instant, and possible
// even when the session is out of usage. Every other prompt passes through untouched, including
// /ideas go, all, sort, and questions, which the /ideas skill answers.

import { renderAdded, renderBoard, renderIdea } from './render.js';
import { addIdeas, FILTERS, findIdea, lane, load, removeIdeas, updateIdea } from './store.js';
import { clip, splitIdeas } from './text.js';

// `/idea ...`, `/ideas ...`, and the plugin-qualified `/ideamine:idea ...` forms.
const COMMAND = /^\s*\/(?:ideamine:)?(ideas?)(?=\s|$)([\s\S]*)$/i;
const EDIT_VERBS = { done: 'done', finish: 'done', drop: 'dropped', doing: 'doing', start: 'doing', reopen: 'reopen' };
const ID = /^#?\d+$/;

const USAGE = `Usage: /idea <text>                  add an idea (a bulleted list adds one idea per bullet)
       /ideas [ls [lane|-a] [here]]   list the queue. Lanes: inbox do maybe skip doing done dropped
       /ideas cat N...                show ideas in full
       /ideas rm N...                 delete ideas for good
       /ideas done|start|reopen|drop N [note]
These call the model:
       /ideas go [N]                  build the next idea, or #N, on its model. New ideas are triaged first.
       /ideas all                     do every idea that fits this chat. The others stay in the queue.
       /ideas sort                    triage the inbox now and show the queue`;

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

  // /ideas <verb> [args]. The verb comes first, as in a shell, so "all" is never a view.
  const [first = 'ls', ...rest] = arg.split(/\s+/).filter(Boolean);
  const verb = first.toLowerCase();
  const ids = ID.test(first) ? [first, ...rest] : rest;
  const allIds = ids.length > 0 && ids.every((w) => ID.test(w));
  const db = load();

  if (verb === 'ls') {
    const lower = rest.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
    const filters = lower.filter((w) => FILTERS.includes(w));
    const here = lower.includes('here');
    if (filters.length + (here ? 1 : 0) === lower.length && filters.length <= 1) {
      return renderBoard(db, { filter: filters[0] || 'open', project: here ? cwd : null, cwd, hints: true });
    }
  }

  if ((verb === 'cat' || ID.test(first)) && allIds) {
    const missing = ids.filter((id) => !findIdea(db, id));
    return missing.length ? noIdea(missing) : ids.map((id) => renderIdea(findIdea(db, id))).join('\n\n');
  }

  if (verb === 'rm' && allIds) {
    const missing = ids.filter((id) => !findIdea(db, id));
    if (missing.length) return noIdea(missing);
    return removeIdeas(ids).map((i) => `✗ Removed #${i.id} · ${clip(i.title, 60)}`).join('\n');
  }

  const status = EDIT_VERBS[verb];
  if (status && rest[0] && ID.test(rest[0])) {
    const note = rest.slice(1).join(' ');
    const idea = updateIdea(rest[0], { status, note: note || undefined });
    return `✓ #${idea.id} ${clip(idea.title, 60)} → ${lane(idea)}${note ? ' (note added)' : ''}`;
  }

  if (verb === 'help') return USAGE;

  return null; // go, all, sort, or a question: the /ideas skill answers it with the model
}

export async function runHook() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not a hook payload; stay out of the way
  }
  let message;
  try {
    message = handlePrompt(typeof input?.prompt === 'string' ? input.prompt : '', {
      cwd: input.cwd || process.cwd(),
      session: input.session_id || null,
    });
  } catch (e) {
    // Never swallow the user's text: let the prompt through so the /idea skill can save it via MCP.
    process.stderr.write(`ideamine: ${e.message}\n`);
    return;
  }
  if (message == null) return;
  // Blocking ends the turn before any API request. suppressOriginalPrompt keeps Claude Code from
  // echoing the command back under our message.
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: message,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
  }));
}
