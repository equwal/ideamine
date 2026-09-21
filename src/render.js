// Plain-text views. Kept compact on purpose: every character here may end up in a model's context.

import path from 'node:path';
import { counts, lane, listIdeas, samePath } from './store.js';
import { clip } from './text.js';

const LANE_TITLES = {
  doing: 'DOING',
  do: 'DO (best first)',
  maybe: 'MAYBE',
  inbox: 'INBOX (untriaged)',
  skip: 'SKIP',
  done: 'DONE',
  dropped: 'DROPPED',
};

function projectName(p) {
  return p ? path.basename(p) : '';
}

function stamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ideaLine(idea, { cwd = null } = {}) {
  const t = idea.triage;
  const id = `#${idea.id}`.padEnd(5);
  const meta = t && lane(idea) !== 'inbox' && t.verdict !== 'skip'
    ? `${t.model.padEnd(6)} ${t.size.toUpperCase().padEnd(2)} ▲${t.impact}  `
    : '';
  const where = idea.project && !samePath(idea.project, cwd) ? `  · ${projectName(idea.project)}` : '';
  return `  ${id}${meta}${clip(idea.title, 64)}${where}`;
}

export function summaryLine(db) {
  const c = counts(db);
  const parts = ['doing', 'do', 'maybe', 'inbox'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`);
  return `ideamine: ${c.open} open${parts.length ? ` (${parts.join(' · ')})` : ''}${c.done ? ` · ${c.done} done` : ''}`;
}

/** The board: ideas grouped by lane. */
export function renderBoard(db, { filter = 'open', project = null, query = '', cwd = null, limit = 0, hints = false } = {}) {
  const ideas = listIdeas(db, { filter, project, query, limit });
  const out = [summaryLine(db)];
  if (project || query || filter !== 'open') {
    const scope = [filter !== 'open' && filter, project && `project ${projectName(project)}`, query && `"${query}"`];
    out[0] += `  [showing: ${scope.filter(Boolean).join(', ')}]`;
  }
  if (!ideas.length) {
    out.push('', db.ideas.length ? '  (nothing here)' : '  (empty — add one with /idea <text>)');
  }
  let current = null;
  for (const idea of ideas) {
    const l = lane(idea);
    if (l !== current) {
      current = l;
      out.push('', LANE_TITLES[l] || l.toUpperCase());
    }
    out.push(ideaLine(idea, { cwd }));
  }
  if (hints) {
    const c = counts(db);
    const tips = ['/idea <text> to add', '/ideas #N for details'];
    if (c.inbox) tips.push('/idea-triage to score the inbox');
    if (c.do) tips.push('/idea-go to build the top pick');
    out.push('', tips.join(' · '));
  }
  return out.join('\n');
}

/** One idea in full. */
export function renderIdea(idea) {
  const t = idea.triage;
  const out = [`#${idea.id} ${idea.title}`];
  const status = [idea.status];
  if (t) status.push(t.verdict, t.model, `size ${t.size.toUpperCase()}`, `impact ${t.impact}/5`);
  out.push(`status   ${status.join(' · ')}`);
  if (idea.project) out.push(`project  ${idea.project}`);
  const added = [`${stamp(idea.created)} via ${idea.source}`];
  if (idea.tags?.length) added.push(`tags: ${idea.tags.join(', ')}`);
  out.push(`added    ${added.join(' · ')}`);
  if (idea.dup_of) out.push(`dup of   #${idea.dup_of}`);
  if (t?.why) out.push(`why      ${t.why}`);
  if (t?.brief) out.push(`brief    ${t.brief}`);
  if (t?.by) out.push(`triaged  ${stamp(t.at)} by ${t.by}`);
  if (idea.text !== idea.title) out.push('', 'text', ...idea.text.split(/\r?\n/).map((l) => `  ${l}`));
  if (idea.notes?.length) {
    out.push('', 'notes');
    for (const n of idea.notes) out.push(`  ${stamp(n.at)}  ${n.text}`);
  }
  return out.join('\n');
}

/** Confirmation after capture, e.g. "💡 Saved #12 · Add dark mode (3 in inbox)". */
export function renderAdded(results, db) {
  const inbox = counts(db).inbox;
  const lines = [];
  if (results.length === 1) {
    const { idea } = results[0];
    lines.push(`💡 Saved #${idea.id} · ${clip(idea.title, 70)}  (${inbox} in inbox)`);
  } else {
    lines.push(`💡 Saved ${results.length} ideas: ${results.map((r) => `#${r.idea.id}`).join(', ')}  (${inbox} in inbox)`);
  }
  const seen = new Set(results.map((r) => r.idea.id));
  for (const r of results) {
    for (const s of r.similar) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      lines.push(`   similar to #${s.id} (${s.status}): ${clip(s.title, 60)}`);
    }
  }
  return lines.join('\n');
}

/** Markdown export of the whole archive. */
export function renderMarkdown(db) {
  const out = [`# Ideas`, '', `_${summaryLine(db)} · exported ${stamp(new Date().toISOString())}_`];
  let current = null;
  for (const idea of listIdeas(db, { filter: 'all' })) {
    const l = lane(idea);
    if (l !== current) {
      current = l;
      out.push('', `## ${LANE_TITLES[l] || l}`, '');
    }
    const t = idea.triage;
    const meta = t && l !== 'inbox' ? ` — ${t.verdict}, ${t.model}, size ${t.size.toUpperCase()}, impact ${t.impact}/5` : '';
    out.push(`- **#${idea.id} ${idea.title}**${meta}${idea.project ? ` · \`${projectName(idea.project)}\`` : ''}`);
    if (t?.brief) out.push(`  - ${t.brief}`);
    if (idea.text !== idea.title) out.push(`  - > ${idea.text.replace(/\r?\n/g, ' ')}`);
  }
  return out.join('\n') + '\n';
}
