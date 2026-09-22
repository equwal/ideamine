// UserPromptSubmit hook: answers /idea, /ideas, and the local /ideas-* commands (ls, cat, rm, done,
// reopen, find, groups, watch, web, sync) and blocks the prompt, so the model is never called. That
// makes capture free, instant, and possible even when the session is out of usage. Every other
// prompt passes through untouched, including /ideas-go, /ideas-all, /ideas-sort, and questions,
// which their skills answer. With the prompt log on, each prompt goes into the prompt outbox. After
// each prompt, the hook lets the watcher, the dashboard, and the sync catch up.

import * as archive from './archive.js';
import * as embed from './embed.js';
import * as publish from './publish.js';
import { renderAdded, renderBoard, renderFound, renderGroups, renderIdea, stamp } from './render.js';
import { FILTERS, findIdea, lane, listIdeas, load } from './store.js';
import * as sync from './sync.js';
import { clip, deriveTitle, splitIdeas } from './text.js';
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
       /ideas-find <words>          search by meaning (all lanes)
       /ideas-groups [lane|-a]      ideas grouped by meaning
       /ideas-web [off]             the dashboard with a button for each command, on this PC
       /ideas-sync [url|off]        share the archive of every machine through an ideamine server
These call the model:
       /ideas-go [N]                build the next idea, or #N, on its model. New ideas are triaged first.
       /ideas-pipeline [N|text]     build an idea through the agent pipeline. You approve the storyboard and the plan.
       /ideas-all                   do every idea that fits this chat. The others stay in the queue.
       /ideas-sort                  triage the inbox now and show the queue
       /ideas-watch [off]           Haiku triages new ideas and pairs them with projects, in the background`;

const noIdea = (ids) => `No idea ${ids.map((id) => `#${String(id).replace(/^#/, '')}`).join(', ')}.`;

// A read that the server could not answer shows the copy on this machine, and says so.
function offline(text) {
  const reason = archive.offlineReason();
  if (!reason) return text;
  const pulled = sync.readState().pulled;
  return `(The ideamine server does not answer. This is the copy from ${pulled ? stamp(pulled) : 'no sync yet'}.)\n${text}`;
}

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

// A search by meaning must not hold the prompt for long when the embedding server is away.
const SEARCH_TIMEOUT_MS = 4000;

/** Handle one prompt. Resolves to the text to show the user, or null to let the prompt through. */
export async function handlePrompt(prompt, { cwd = process.cwd(), session = null } = {}) {
  const m = COMMAND.exec(prompt || '');
  if (!m) return null;
  const command = m[1].toLowerCase();
  const arg = m[2].trim();

  if (command === 'idea') {
    if (!arg) return USAGE;
    const texts = splitIdeas(arg);
    const results = await archive.add(texts, { source: 'hook', project: cwd, session });
    if (results.queued) {
      const what = texts.length === 1 ? clip(deriveTitle(texts[0]), 70) : `${texts.length} ideas`;
      return `💡 Saved here: ${what}. The ideamine server does not answer, so it gets the idea later (${sync.waiting()} waiting).`;
    }
    return renderAdded(results, load()); // the copy here is current: the server answered
  }

  if (command === 'ideas-sync') {
    if (/^off$/i.test(arg)) sync.setServer('');
    else if (arg) {
      let backup;
      try {
        backup = sync.setServer(arg);
      } catch (e) {
        return `ideamine sync: ${e.message}. Usage: /ideas-sync http://10.66.0.1/ · /ideas-sync off`;
      }
      await archive.fresh({ timeoutMs: 5000 });
      if (backup) return `${sync.status()}\nThe archive that was here is in ${backup}.`;
    }
    return sync.status();
  }

  if (command === 'ideas-watch') {
    if (!arg) watch.turnOn();
    else if (/^off$/i.test(arg)) watch.turnOff();
    else return null;
    return watch.status(); // runHook starts the first pass after this
  }

  if (command === 'ideas-web') {
    // Loaded here, not at the top: the hook runs for each prompt.
    const serve = await import('./serve.js');
    if (!arg) return serve.ensureRunning();
    if (/^off$/i.test(arg)) return serve.stopRunning();
    return null;
  }

  const words = arg.split(/\s+/).filter(Boolean);
  const ids = words.length > 0 && words.every((w) => ID.test(w)) ? words : null;
  const db = await archive.fresh();

  if (command === 'ideas' && !words.length) return offline(renderBoard(db, { cwd, hints: true }));

  if (command === 'ideas-find') {
    if (!arg) return USAGE;
    return offline(renderFound(await embed.find(db, arg, { timeoutMs: SEARCH_TIMEOUT_MS }), arg, { cwd }));
  }

  if (command === 'ideas-groups') {
    const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
    if (lower.length <= 1 && lower.every((w) => FILTERS.includes(w))) {
      const filter = lower[0] || 'open';
      const ideas = listIdeas(db, { filter });
      try {
        const groups = await embed.groupIdeas(ideas, { timeoutMs: SEARCH_TIMEOUT_MS });
        return offline(renderGroups(groups, ideas, { cwd, scope: filter }));
      } catch (e) {
        if (!(e instanceof embed.EmbedError)) throw e;
        return `Groups need the embedding server, which does not answer: ${e.message}`;
      }
    }
  }

  if (command === 'ideas-ls') {
    const lower = words.map((w) => (w === '-a' ? 'all' : w.toLowerCase()));
    const filters = lower.filter((w) => FILTERS.includes(w));
    const here = lower.includes('here');
    if (filters.length + (here ? 1 : 0) === lower.length && filters.length <= 1) {
      return offline(renderBoard(db, { filter: filters[0] || 'open', project: here ? cwd : null, cwd, hints: true }));
    }
  }

  if ((command === 'ideas-cat' || command === 'ideas-rm') && ids) {
    const missing = ids.filter((id) => !findIdea(db, id));
    if (missing.length) return noIdea(missing);
    if (command === 'ideas-cat') return offline(ids.map((id) => renderIdea(findIdea(db, id))).join('\n\n'));
    const gone = await archive.remove(ids);
    if (gone.queued) return archive.queuedText(gone);
    return gone.map((i) => `✗ Removed #${i.id} · ${clip(i.title, 60)}`).join('\n');
  }

  const status = STATUS_COMMANDS[command];
  if (status && words[0] && ID.test(words[0])) {
    if (!findIdea(db, words[0])) return noIdea([words[0]]);
    const note = words.slice(1).join(' ');
    const idea = await archive.update(words[0], { status, note: note || undefined });
    if (idea.queued) return archive.queuedText(idea);
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
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const cwd = input.cwd || process.cwd();
  const session = input.session_id || null;
  try {
    if (sync.logsPrompts()) sync.logPrompt({ prompt, session, cwd });
  } catch (e) {
    // The prompt log must never stop a prompt.
    process.stderr.write(`ideamine: the prompt log failed: ${e.message}\n`);
  }
  let message = null;
  try {
    message = await handlePrompt(prompt, { cwd, session });
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
  // Each prompt lets the watcher, the dashboard, and the sync catch up, so they keep going.
  for (const kick of [watch.kick, publish.kick, sync.kick]) {
    try {
      kick();
    } catch {
      // The watcher, the dashboard, and the sync must never stop a prompt.
    }
  }
}
