// Pure text helpers: titles, tags, bullet splitting, and cheap duplicate detection.

const STOPWORDS = new Set(
  ('a an and any are as at be but by can could do does for from get got has have how i if in into is it its ' +
    'just like make me more my of on or our out so some than that the their them then there these they this ' +
    'to too up use using via was way we what when where which while who why will with would you your')
    .split(' '),
);

/** First non-empty line, whitespace-collapsed, cut at a word boundary. */
export function deriveTitle(text, max = 72) {
  const first = String(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const clean = first
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/(?:^|\s)#[a-z][\w-]{0,31}(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || first;
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '') + '…';
}

/** `#tag` words (must start with a letter, so `#12` and `C#` are not tags). */
export function extractTags(text) {
  const tags = new Set();
  for (const m of String(text).matchAll(/(?:^|\s)#([a-z][\w-]{0,31})/gi)) tags.add(m[1].toLowerCase());
  return [...tags];
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
}

const BULLET = /^(\s{0,3})(?:[-*•]|\d+[.)])\s+/;

/**
 * A pasted bulleted list becomes one idea per bullet; anything else is one idea.
 * Indented lines under a bullet are kept with that bullet.
 */
export function splitIdeas(text) {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  let pureList = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (BULLET.test(line)) items.push(line.replace(BULLET, '').trim());
    else if (items.length && /^\s+/.test(line)) items[items.length - 1] += '\n' + line.trim();
    else {
      pureList = false;
      break;
    }
  }
  if (pureList && items.length >= 2) return items.filter(Boolean);
  const whole = String(text).trim();
  return whole ? [whole] : [];
}

export function wordSet(text) {
  const words = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return new Set(words);
}

/** Jaccard similarity of two word sets, plus the shared-word count. */
export function similarity(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return { score: union ? shared / union : 0, shared };
}

export function isSimilar(a, b) {
  const { score, shared } = similarity(a, b);
  return (score >= 0.55 && shared >= 2) || score >= 0.8;
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
