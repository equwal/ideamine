// UserPromptSubmit hook: answers /idea and /ideas locally and blocks the prompt, so the model is
// never called. That makes capture free, instant, and possible even when the session is out of
// usage. Every other prompt passes through untouched.

import { renderAdded, renderBoard, renderIdea } from './render.js';
import { addIdeas, FILTERS, findIdea, lane, load, updateIdea } from './store.js';
import { clip, splitIdeas } from './text.js';

// `/idea ...`, `/ideas ...`, and the plugin-qualified `/ideamine:idea ...` forms.
const COMMAND = /^\s*\/(?:ideamine:)?(ideas?)(?=\s|$)([\s\S]*)$/i;
const EDIT_VERBS = { done: 'done', finish: 'done', drop: 'dropped', doing: 'doing', start: 'doing', reopen: 'reopen' };

const USAGE =
  'Usage: /idea <your idea>   saves it without calling the model (a bulleted list saves one idea per bullet)\n' +
  '       /ideas [open|inbox|do|maybe|skip|doing|done|dropped|all|here] · /ideas #12 · /ideas done|drop|start|reopen 12 [note]';

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

  // /ideas
  const words = arg.split(/\s+/).filter(Boolean);
  const db = load();

  if (!words.length) return renderBoard(db, { cwd, hints: true });

  if (words.length === 1 && /^#?\d+$/.test(words[0])) {
    const idea = findIdea(db, words[0]);
    return idea ? renderIdea(idea) : `No idea ${words[0].startsWith('#') ? words[0] : '#' + words[0]}.`;
  }

  const verb = EDIT_VERBS[words[0]?.toLowerCase()];
  if (verb && words[1] && /^#?\d+$/.test(words[1])) {
    const note = words.slice(2).join(' ');
    const idea = updateIdea(words[1], { status: verb, note: note || undefined });
    return `✓ #${idea.id} ${clip(idea.title, 60)} → ${lane(idea)}${note ? ' (note added)' : ''}`;
  }

  const lower = words.map((w) => w.toLowerCase());
  const filters = lower.filter((w) => FILTERS.includes(w));
  const here = lower.includes('here');
  if (filters.length + (here ? 1 : 0) === lower.length && filters.length <= 1) {
    return renderBoard(db, { filter: filters[0] || 'open', project: here ? cwd : null, cwd, hints: true });
  }
  if (lower[0] === 'help') return USAGE;

  return null; // a question about the ideas: let the model answer it (via the /ideas skill)
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
