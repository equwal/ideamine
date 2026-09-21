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

Every session writes to one archive, `~/.ideamine/ideas.json`, whatever project or model it uses. The archive is a queue. Claude triages new ideas to put the queue in order: it decides which ideas are worth doing and picks the **cheapest model that can build each one**: Haiku for a typo, Sonnet for a feature, Opus for a redesign. Fable is only for the hardest problems. `/ideas-go` takes the idea that fits your chat, else the first one, and builds it.

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
| `/idea <text>` | Add an idea. A pasted bulleted list adds one idea per bullet. `#tags` are recorded. | **No** |
| `/ideas` | Show the queue: doing, do (best first), maybe, inbox | **No** |
| `/ideas-ls done` · `-a` · `here` | List one lane, every lane, or only this project | **No** |
| `/ideas-cat 12` | Show idea #12 in full: brief, model, notes | **No** |
| `/ideas-rm 12 14` | Delete ideas for good | **No** |
| `/ideas-done 12 shipped it` | Mark an idea done, with a note | **No** |
| `/ideas-reopen 12` | Put an idea back in the queue, for example one that the triage skipped | **No** |
| `/ideas-go [12]` | Build the idea that fits this chat, else the first in the queue, or #12, on its recommended model. New ideas are triaged first. | Yes, this is the build |
| `/ideas-all` | Claude reads every idea, takes the ones that fit this chat out of the queue, and does them. The others stay in the queue. | Yes, this is the build |
| `/ideas-sort` | Triage the inbox now and show the queue. You do not have to: `/ideas-go` triages when it must. | Yes, briefly |
| `/ideas <question>` | Ask about your ideas, e.g. "which ones fit in an hour?" | Yes, briefly |

Each command has its own name, so the slash menu shows all of them when you type `/idea`. The plugin menu also shows them as `/ideamine:ideas-go` and so on. Both forms work.

`/ideas-go` does not ask questions. The queue puts the best `do` ideas first, then the best `maybe` ideas. Ideas that the triage marks `skip` stay out of the queue until you reopen or delete them.

You save ideas from any session, so the project that ideamine records is only the folder you were in. That can be a scratch folder that is gone. For this reason, `/ideas-go` and `/ideas-all` let Claude judge by the text which ideas fit the current chat, and where to build each one. `/ideas-go` builds in the current project when the idea fits it. Else it uses the recorded folder if that folder exists, or finds the project that the idea is about. If it cannot find the project, it stops and tells you.

Claude can also save ideas by itself. If you write "idea: dark mode for the popup" or "save that for later", it calls the `idea_add` tool and continues the current task.

## Model routing

The triage gives each idea a verdict (`do`, `maybe`, `skip`), an impact from 1 to 5, a size from `xs` to `xl`, a one-line reason, and a short brief that an agent can act on without the original chat. It also picks the cheapest model that is likely to finish the idea in one pass. If a weaker model fails and has to retry, that costs more than using the right model once.

| Model | $ in / out per 1M tokens | Gets ideas like |
|---|---|---|
| `haiku` (Haiku 4.5) | $1 / $5 | mechanical, fully specified, local work: typos, renames, config tweaks, boilerplate, small scripts |
| `sonnet` (Sonnet 5) | $2 / $10 | the default: ordinary features, bug fixes with a clear repro, tests, docs, contained refactors |
| `opus` (Opus 5) | $5 / $25 | ambiguous or cross-cutting work: architecture, hard debugging, performance, security |
| `fable` (Fable 5.1) | $10 / $50 | only the hardest long-horizon or research-grade problems |

The triage does not run on your session's model. `/ideas-go` and `/ideas-sort` make one tool call, and the MCP server hands the work to a separate, minimal `claude -p` run on Sonnet (see below). Only new ideas are triaged, once each. A session on Opus or Fable therefore pays the same few cents as a session on Haiku. If that CLI is not available, Claude does the triage itself.

Recommendations are stored as aliases, so they stay valid when a newer model ships under the same name. `/ideas-go` gives the build to a subagent on the recommended model. The subagent starts with a clean context, so the build does not also re-read your whole conversation. To override a recommendation, run `ideamine model 12 opus` or ask Claude.

## Headless triage

```bash
ideamine sort
```

`/ideas-go` and `/ideas-sort` use this same engine. It is one `claude -p` call on your normal Claude Code login, with no tools, no MCP servers, no settings, a two-line system prompt, and a JSON schema for the output. Four ideas take about 1,700 input tokens, roughly two cents on Sonnet. A normal model turn in a setup with a few MCP servers can re-read tens of thousands of tokens. To keep the inbox sorted while you sleep, schedule the command with cron or Task Scheduler. `--model haiku` makes it cheaper, and `--dry-run` shows the exact prompt.

## Command line

```bash
npm install -g github:equwal/ideamine
```

```
ideamine add "support vim keys in the popup"      # "-" reads stdin
ideamine ls [inbox|do|maybe|skip|doing|done|-a] [here]
ideamine cat 12
ideamine rm 12                                    # delete for good
ideamine done 12 "shipped in v1.4"                # also: drop, start, reopen, note
ideamine next                                     # what to build next
ideamine go 12                                    # opens Claude Code on the right model, in the idea's project
ideamine sort                                     # headless triage (see above)
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

Tools: `idea_add`, `idea_list`, `idea_triage`, `idea_update`, `idea_next`, `idea_remove`. Outside the plugin, the slash commands are MCP prompts. Without the hook, saving goes through the model, which costs a few tokens.

## Where your ideas live

`~/.ideamine/ideas.json` is plain, readable JSON. Set `IDEAMINE_HOME` to move it, for example into a synced folder. Each write takes a lock and then replaces the file in one step, so many sessions can write at the same time without losing an idea. The previous version is kept as `ideas.json.bak`. If the file becomes damaged, ideamine stops and does not overwrite it. Nothing leaves your machine, except when you run triage or a build, which go through Claude as usual.

| Variable | Default | Purpose |
|---|---|---|
| `IDEAMINE_HOME` | `~/.ideamine` | archive location |
| `IDEAMINE_TRIAGE_MODEL` | `sonnet` | model for the headless triage |
| `IDEAMINE_CLAUDE_BIN` | `claude` | Claude Code executable |
| `IDEAMINE_SETTING_SOURCES` | *(empty)* | set to `user` if your login needs `settings.json` (e.g. `apiKeyHelper`) |

## How it works

```
/idea …          ──► UserPromptSubmit hook ──► ~/.ideamine/ideas.json ──► "💡 Saved #43"   (model never called)
/ideas, /ideas-ls, -cat, -rm, -done ──► same hook, answers locally

/ideas-go        ──► Claude ──► MCP idea_next ──► claude -p (Sonnet, minimal context), for new ideas only
                                              ──► verdict · impact · size · cheapest capable model · brief
                            ──► subagent on that model ──► builds it ──► idea_update: done
/ideas-all       ──► Claude ──► MCP idea_list (full) ──► idea_remove for the ideas that fit this chat ──► builds them
```

The plugin contains a Node MCP server with no dependencies, ten skills (the slash commands), and one hook. The hook ignores every prompt except `/idea`, `/ideas`, and the local `/ideas-*` commands, and those end before any API call. The hook runs directly, not through a shell, and takes about 130 ms per prompt on Windows. The skills are user-only, so their descriptions add no tokens to your sessions. If the archive cannot be read, the hook lets the prompt through, so the `/idea` skill can still save it with the MCP tool. Your text is never dropped.

## Development

```bash
npm test
```

The tests use `node:test` only. They cover the store, including concurrent writers from several processes, the hook, the MCP protocol, and headless triage. Triage runs against a stand-in `claude`, so the tests spend no tokens.

## License

MIT
