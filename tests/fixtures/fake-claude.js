// Stand-in for the Claude Code CLI: returns a verdict for every idea in the prompt and records how
// it was called, so tests can check flags and environment without spending tokens.
import fs from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

if (process.env.FAKE_CLAUDE_LOG) {
  const env = {};
  for (const key of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_BASE_URL']) env[key] = process.env[key] ?? null;
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), env, input }));
}

const ids = [...(input.split('Ideas to triage')[1] || '').matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
const verdicts = ids.map((id, i) => ({
  id,
  verdict: i === 2 ? 'skip' : 'do',
  impact: 3,
  size: 's',
  model: i === 1 ? 'haiku' : 'sonnet',
  title: `Idea ${id}`,
  why: 'test',
  brief: `Build ${id}.`,
}));

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  structured_output: { verdicts },
  total_cost_usd: 0.0012,
  usage: { input_tokens: 321, output_tokens: 45 },
}));
