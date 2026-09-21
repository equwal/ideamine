# ideamine

**An idea inbox for Claude Code.** Save ideas as fast as you have them. Claude sorts them out later.

```
> /idea let the scroller pause when the mouse hovers over a link
  💡 Saved #43 · let the scroller pause when the mouse hovers over a link  (6 in inbox)
```

That line did not call the model. A hook answers `/idea` on your machine before any request goes to Claude, so saving an idea:

- **costs 0 tokens.** `claude -p "/idea …"` reports 0 turns, 0 input tokens, 0 output tokens, $0.
- **does not interrupt the current task.** Claude never sees the idea, so it cannot get distracted by it.
- **works on any model, in any session, and when you are out of usage.** Nothing is sent, so there is nothing to rate-limit.

Every session writes to one archive, `~/.ideamine/ideas.json`, whatever project or model it uses. When you are ready, Claude triages the pile. It decides which ideas are worth doing and picks the **cheapest model that can build each one**: Haiku for a typo, Sonnet for a feature, Opus for a redesign. Fable is only for the hardest problems.

## Install

In Claude Code (CLI, desktop, or IDE):

```bash
claude plugin marketplace add equwal/ideamine
```

```bash
claude plugin install ideamine@ideamine
```

Or from inside a session: `/plugin marketplace add equwal/ideamine`, then `/plugin install ideamine@ideamine`. Start a new session to load it. Requires Node.js 18 or later. There are no dependencies to install. Tested on Claude Code 2.1.224 (CLI) and 2.1.275 (desktop app) on Windows.

Marketplaces you add yourself do not auto-update. To upgrade, run `claude plugin marketplace update ideamine`, then `claude plugin update ideamine@ideamine`.

## Commands

| Command | What it does | Calls the model? |
|---|---|---|
| `/idea <text>` | Save an idea. A pasted bulleted list saves one idea per bullet. `#tags` are recorded. | **No** |
| `/ideas` | Show the board: doing, do (best first), maybe, inbox | **No** |
| `/ideas #12` | Show one idea in full: brief, model, notes | **No** |
| `/ideas done 12 shipped it` | Quick edit. Also `drop`, `start`, `reopen` | **No** |
| `/ideas inbox` · `do` · `maybe` · `skip` · `done` · `all` · `here` | Filter the board. `here` = this project only | **No** |
| `/ideas <question>` | Ask about your ideas, e.g. "which ones fit in an hour?" | Yes, briefly |
| `/idea-triage` | Score the inbox and choose a model for each idea | Yes, briefly |
| `/idea-go [id]` | Build the top idea (or `#id`) with its recommended model | Yes, this is the build |

In the plugin menu the commands also appear as `/ideamine:idea` and so on. Both forms work.

Claude can also save ideas by itself. If you write "idea: dark mode for the popup" or "save that for later", it calls the `idea_add` tool and continues the current task.

## Model routing

`/idea-triage` gives each idea a verdict (`do`, `maybe`, `skip`), an impact from 1 to 5, a size from `xs` to `xl`, a one-line reason, and a short brief that an agent can act on without the original chat. It also picks the cheapest model that is likely to finish the idea in one pass. If a weaker model fails and has to retry, that costs more than using the right model once.

| Model | $ in / out per 1M tokens | Gets ideas like |
|---|---|---|
| `haiku` (Haiku 4.5) | $1 / $5 | mechanical, fully specified, local work: typos, renames, config tweaks, boilerplate, small scripts |
| `sonnet` (Sonnet 5) | $2 / $10 | the default: ordinary features, bug fixes with a clear repro, tests, docs, contained refactors |
| `opus` (Opus 5) | $5 / $25 | ambiguous or cross-cutting work: architecture, hard debugging, performance, security |
| `fable` (Fable 5.1) | $10 / $50 | only the hardest long-horizon or research-grade problems |

The triage does not run on your session's model. `/idea-triage` makes one tool call, and the MCP server hands the work to a separate, minimal `claude -p` run on Sonnet (see below). A session on Opus or Fable therefore pays the same few cents as a session on Haiku. If that CLI is not available, Claude does the triage itself.

Recommendations are stored as aliases, so they stay valid when a newer model ships under the same name. `/idea-go` gives the build to a subagent on the recommended model. The subagent starts with a clean context, so the build does not also re-read your whole conversation. To override a recommendation, run `ideamine model 12 opus` or ask Claude.

## Headless triage

```bash
ideamine triage
```

`/idea-triage` uses this same engine. It is one `claude -p` call on your normal Claude Code login, with no tools, no MCP servers, no settings, a two-line system prompt, and a JSON schema for the output. Four ideas take about 1,700 input tokens, roughly two cents on Sonnet. A normal model turn in a setup with a few MCP servers can re-read tens of thousands of tokens. To keep the inbox sorted while you sleep, schedule the command with cron or Task Scheduler. `--model haiku` makes it cheaper, and `--dry-run` shows the exact prompt.

## Command line

```bash
npm install -g github:equwal/ideamine
```

```
ideamine add "support vim keys in the popup"      # "-" reads stdin
ideamine ls [inbox|do|maybe|skip|doing|done|all] [here]
ideamine show 12
ideamine done 12 "shipped in v1.4"                # also: drop, start, reopen, note
ideamine next                                     # what to build next
ideamine go 12                                    # opens Claude Code on the right model, in the idea's project
ideamine triage                                   # headless triage (see above)
ideamine export IDEAS.md                          # Markdown copy of everything
```

## Other MCP clients

The MCP server works without the plugin. For Claude Desktop, Cursor, or any stdio MCP client:

```json
{
  "mcpServers": {
    "ideamine": { "command": "npx", "args": ["-y", "github:equwal/ideamine", "mcp"] }
  }
}
```

Tools: `idea_add`, `idea_list`, `idea_triage`, `idea_update`, `idea_next`. Outside the plugin, the slash commands are MCP prompts. Without the hook, saving goes through the model, which costs a few tokens.

## Where your ideas live

`~/.ideamine/ideas.json` is plain, readable JSON. Set `IDEAMINE_HOME` to move it, for example into a synced folder. Each write takes a lock and then replaces the file in one step, so many sessions can write at the same time without losing an idea. The previous version is kept as `ideas.json.bak`. If the file becomes damaged, ideamine stops and does not overwrite it. Nothing leaves your machine, except when you run triage or a build, which go through Claude as usual.

| Variable | Default | Purpose |
|---|---|---|
| `IDEAMINE_HOME` | `~/.ideamine` | archive location |
| `IDEAMINE_TRIAGE_MODEL` | `sonnet` | model for `ideamine triage` |
| `IDEAMINE_CLAUDE_BIN` | `claude` | Claude Code executable |
| `IDEAMINE_SETTING_SOURCES` | *(empty)* | set to `user` if your login needs `settings.json` (e.g. `apiKeyHelper`) |

## How it works

```
/idea …       ──► UserPromptSubmit hook ──► ~/.ideamine/ideas.json ──► "💡 Saved #43"   (model never called)
/ideas        ──► same hook, renders the board locally

/idea-triage  ──► Claude ──► MCP idea_triage ──► claude -p (Sonnet, minimal context)
                                              ──► verdict · impact · size · cheapest capable model · brief
/idea-go      ──► Claude ──► subagent on that model ──► builds it ──► idea_update: done
```

The plugin contains a Node MCP server with no dependencies, four skills (the slash commands), and one hook. The hook ignores every prompt except `/idea` and `/ideas`, and those end before any API call. The hook runs directly, not through a shell, and takes about 130 ms per prompt on Windows. The skills are user-only, so their descriptions add no tokens to your sessions. If the archive cannot be read, the hook lets the prompt through, so the `/idea` skill can still save it with the MCP tool. Your text is never dropped.

## Development

```bash
npm test
```

The tests use `node:test` only. They cover the store, including concurrent writers from several processes, the hook, the MCP protocol, and headless triage. Triage runs against a stand-in `claude`, so the tests spend no tokens.

## License

MIT
