// The agents of a coop session build the ideas that wait in Doing. On the ideamine server, a loop
// takes one waiting idea at a time and sends it to `any` in the coop session: the coop hub gives
// it to a free agent. The idea shows that agent. The answer of the agent closes the idea (DONE)
// or puts it back in Do with the answer as a note.
//
// idea.agent: { name: 'any' } waits; { name: 'coop' } is being sent; { name, msg } is with the
// agent `name` (agent@machine), and msg is the id of the coop message with the task.

import * as config from './config.js';
import * as store from './store.js';
import { clip } from './text.js';

const ROUND_MS = 15000;
const SEND_MS = 60000; // a card that stays "being sent" longer than this waits again (the server stopped mid-send)
// ponytail: one limit for every card. A limit per size of the idea if real builds need more.
const ANSWER_MS = 3 * 3600000;
const PAGE = 200;

const now = () => new Date().toISOString();

/** The hub, the session, and the token, or null when coop is off. The token is only in the environment. */
export function settings() {
  const url = config.get('coop_url');
  const token = process.env.IDEAMINE_COOP_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), session: config.get('coop_session'), token } : null;
}

async function hub(s, method, route, body) {
  const res = await fetch(`${s.url}/v1/admin/sessions/${encodeURIComponent(s.session)}/${route}`, {
    method,
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const waiting = (i, t) => i.status === 'doing' && (i.agent?.name === 'any' || (i.agent?.name === 'coop' && t - Date.parse(i.agent.at) > SEND_MS));

/**
 * Take the idea that waits longest for an agent. The archive lock makes the take atomic: two
 * rounds, or two servers, never take the same idea. Null when no idea waits.
 */
export function claim() {
  if (!store.load().ideas.some((i) => waiting(i, Date.now()))) return null; // no write when nothing waits
  return store.mutate((db) => {
    const t = Date.now();
    const idea = db.ideas.filter((i) => waiting(i, t)).sort((a, b) => a.agent.at.localeCompare(b.agent.at))[0];
    if (!idea) return null;
    idea.agent = { name: 'coop', at: now() };
    return structuredClone(idea);
  });
}

/** Change the idea only if it still has the agent state `was` (the user can move a card at any time). */
function ifStill(id, was, fn) {
  return store.mutate((db) => {
    const idea = store.findIdea(db, id);
    if (!idea || idea.status !== 'doing' || idea.agent?.name !== was.name || idea.agent?.msg !== was.msg) return false;
    fn(idea);
    idea.updated = now();
    return true;
  });
}

/** The message that the agent gets. */
export function task(idea) {
  const t = idea.triage || {};
  const facts = [
    t.brief && `Plan from the triage: ${t.brief}`,
    idea.project && `Project folder on jose's PC: ${idea.project}`,
    t.model && `Suggested model: ${t.model}`,
  ].filter(Boolean);
  return [
    `Card IDEA-${idea.id} of jose's ideamine board: ${idea.title}`,
    idea.text,
    facts.join('\n'),
    'Answer with DONE: and one line that says what you did and where (commit, branch, file), or with FAILED: and the reason.\n' +
      'DONE moves the card to Done. Any other answer puts it back in Do with your answer as a note.',
  ].filter(Boolean).join('\n\n');
}

/** Send one waiting idea to a free agent. */
async function dispatch(s, log) {
  const idea = claim();
  if (!idea) return;
  const sending = { name: 'coop' };
  const back = (why) => {
    ifStill(idea.id, sending, (i) => (i.agent = { name: 'any', at: now() }));
    if (why) log(`coop: IDEA-${idea.id} waits again: ${why}`);
  };
  let res;
  try {
    res = await hub(s, 'POST', 'messages', { to: 'any', text: task(idea) });
  } catch (e) {
    return back(`cannot reach the hub (${e.message})`);
  }
  // 404: no agent is free now. A worker is offline for a moment between its rounds, so try again later.
  if (res.status === 404) return back(null);
  if (res.status !== 200 || !res.json.id || !res.json.to) return back(`the hub answered ${res.status} ${res.json.error || ''}`.trim());
  const { id: msg, to } = res.json;
  ifStill(idea.id, sending, (i) => {
    i.agent = { name: to, msg: String(msg), at: now() };
    (i.notes ||= []).push({ at: now(), text: `coop gave it to ${to}` });
  });
  log(`coop: IDEA-${idea.id} went to ${to} (message ${msg})`);
}

/** Read the answers of the agents. DONE closes the idea; any other answer, or none in time, puts it back in Do. */
async function collect(s, log) {
  const out = store.load().ideas.filter((i) => i.status === 'doing' && i.agent?.msg);
  if (!out.length) return;
  const replies = new Map();
  for (let after = Math.min(...out.map((i) => Number(i.agent.msg))); ; ) {
    const res = await hub(s, 'GET', `messages?after=${after}&limit=${PAGE}`);
    if (res.status !== 200) throw new Error(`the hub answered ${res.status} to a read of the messages`);
    const messages = res.json.messages || [];
    for (const m of messages) if (m.reply_to) replies.set(String(m.reply_to), m);
    if (messages.length < PAGE) break;
    after = messages[messages.length - 1].id;
  }
  for (const idea of out) {
    const reply = replies.get(idea.agent.msg);
    const late = !reply && Date.now() - Date.parse(idea.agent.at) > ANSWER_MS;
    if (!reply && !late) continue;
    const done = !!reply && /^\s*DONE\b/i.test(reply.text);
    const note = reply ? `${reply.from}: ${clip(reply.text, 500)}` : `no answer from ${idea.agent.name} in ${ANSWER_MS / 3600000} h`;
    ifStill(idea.id, idea.agent, (i) => {
      i.status = done ? 'done' : i.triage ? 'triaged' : 'inbox';
      if (done) i.closed = now();
      delete i.agent;
      (i.notes ||= []).push({ at: now(), text: note });
    });
    log(`coop: IDEA-${idea.id} ${done ? 'done' : 'back in the queue'}: ${note}`);
  }
}

/** One round: read the answers, then send one waiting idea. */
export async function round(s, { log = () => {} } = {}) {
  try {
    await collect(s, log);
  } catch (e) {
    log(`coop: ${e.message}`);
  }
  await dispatch(s, log);
}

/** Run a round every 15 s on the ideamine server. Returns a function that stops it, or null when coop is off. */
export function start({ log = () => {} } = {}) {
  const s = settings();
  if (!s) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await round(s, { log });
    } catch (e) {
      log(`coop: ${e.message}`);
    } finally {
      running = false;
    }
  }, ROUND_MS);
  log(`coop: the agents of session ${s.session} at ${s.url} build the ideas dropped in Doing`);
  return () => clearInterval(timer);
}
