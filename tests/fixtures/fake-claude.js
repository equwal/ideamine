// Stand-in for the Claude Code CLI: returns a verdict for every idea in the prompt and records how
// it was called, so tests can check flags and environment without spending tokens. It pairs an
// idea with a listed project when the idea names that project. It answers with the folder path,
// or with the project name when FAKE_CLAUDE_ANSWER=name (as Haiku did). To a question about the
// ideas, it answers with the first idea of the prompt.
import fs from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

if (process.env.FAKE_CLAUDE_LOG) {
  const env = {};
  for (const key of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_BASE_URL', 'MAX_THINKING_TOKENS']) {
    env[key] = process.env[key] ?? null;
  }
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), env, input }));
}

// Each project line is "name: folder" or "name: folder — what the README says".
const projects = (input.split('Projects on this machine:\n')[1] || '')
  .split('\n\n')[0]
  .split('\n')
  .filter(Boolean)
  .map((line) => ({ name: line.slice(0, line.indexOf(': ')), dir: line.slice(line.indexOf(': ') + 2).split(' — ')[0] }));
const answer = (p) => (p ? (process.env.FAKE_CLAUDE_ANSWER === 'name' ? p.name : p.dir) : '');
const ideas = [...(input.split('Ideas to triage')[1] || '').matchAll(/^#(\d+)(?: \[[^\]]*\])?: (.*)$/gm)];
const verdicts = ideas.map(([, id, text], i) => ({
  id: Number(id),
  verdict: i === 2 ? 'skip' : 'do',
  impact: 3,
  size: 's',
  model: i === 1 ? 'haiku' : 'sonnet',
  title: `Idea ${id}`,
  why: 'test',
  brief: `Build ${id}.`,
  project: answer(projects.find((p) => text.toLowerCase().includes(p.name.toLowerCase()))),
}));

const question = input.split('\nQuestion: ')[1];
const first = input.match(/\*\*#(\d+) /);

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: question ? `#${first ? first[1] : '?'} fits "${question.trim()}".` : '',
  structured_output: question ? undefined : { verdicts },
  total_cost_usd: 0.0012,
  usage: { input_tokens: 321, output_tokens: 45 },
}));
