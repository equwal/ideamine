// The ideamine MCP server: the capture tools of ideahook, plus triage and next-idea, plus the
// slash-command prompts that mirror the skills.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handlers as boardHandlers, tools as boardTools } from 'ideaboard/tools';
import { handlers as captureHandlers, INSTRUCTIONS, serve as serveIdeahook, tools as captureTools } from 'ideahook/mcp';

const ROOT = new URL('..', import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(new URL('package.json', ROOT), 'utf8')).version;

const byName = (name) => captureTools.find((t) => t.name === name);

// The order that clients see.
const [triageTool, nextTool] = boardTools;
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

/** Serve MCP on stdin/stdout. `prompts: false` when running as a plugin (skills cover slash commands). */
export function serve({ prompts = true } = {}) {
  return serveIdeahook({
    name: 'ideamine',
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    handlers: { ...captureHandlers, ...boardHandlers },
    prompts: prompts ? PROMPTS : [],
    promptBody: skillBody,
  });
}
