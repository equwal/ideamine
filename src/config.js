// Settings. `ideamine config` writes them to ~/.ideamine/config.json. An environment variable
// overrides the file, so a test or a single command can use other values.

import fs from 'node:fs';
import path from 'node:path';
import { home, withLock, writeAtomic } from './store.js';

export const SETTINGS = {
  embed_url: {
    env: 'IDEAMINE_EMBED_URL',
    value: 'http://127.0.0.1:11434/v1',
    about: 'OpenAI-compatible embeddings API (Ollama, llama.cpp server)',
  },
  embed_model: { env: 'IDEAMINE_EMBED_MODEL', value: 'nomic-embed-text', about: 'embedding model' },
  search_threshold: {
    env: 'IDEAMINE_SEARCH_THRESHOLD',
    value: 0.5,
    about: 'lowest similarity (0 to 1) of a search result to the query',
  },
  group_threshold: {
    env: 'IDEAMINE_GROUP_THRESHOLD',
    value: 0.65,
    about: 'lowest mean similarity (0 to 1) of the ideas in a group; also the floor for related ideas',
  },
  publish_url: {
    env: 'IDEAMINE_PUBLISH_URL',
    value: '',
    about: 'dashboard server that gets index.html and data.json by HTTP PUT (empty: off)',
  },
};

const configPath = () => path.join(home(), 'config.json');

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function setting(key) {
  const s = SETTINGS[key];
  if (!s) throw new Error(`unknown setting "${key}" (use: ${Object.keys(SETTINGS).join(', ')})`);
  return s;
}

function parse(key, raw) {
  if (typeof setting(key).value !== 'number') return String(raw).trim();
  const n = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${key} must be a number from 0 to 1`);
  return n;
}

/** The value and where it comes from: env, file, or default. */
function lookup(key) {
  const s = setting(key);
  const env = process.env[s.env];
  if (env !== undefined && env !== '') return { value: parse(key, env), from: s.env };
  const saved = readFile()[key];
  if (saved !== undefined) return { value: parse(key, saved), from: 'config.json' };
  return { value: s.value, from: 'default' };
}

export function get(key) {
  return lookup(key).value;
}

/** Save a setting. An empty value removes it from the file, so the default applies again. */
export function set(key, value) {
  const clean = value == null || String(value).trim() === '' ? undefined : parse(key, value);
  withLock(() => {
    const all = readFile();
    if (clean === undefined) delete all[key];
    else all[key] = clean;
    writeAtomic(configPath(), JSON.stringify(all, null, 2) + '\n');
  });
  return get(key);
}

/** Every setting, one line each, with its source. */
export function describe() {
  return Object.keys(SETTINGS)
    .map((key) => {
      const { value, from } = lookup(key);
      return `${key.padEnd(17)} ${String(value === '' ? '(off)' : value).padEnd(28)} ${from} · ${SETTINGS[key].about}`;
    })
    .join('\n');
}
