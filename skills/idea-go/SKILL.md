---
name: idea-go
description: Build the top ideamine idea, or a given #id, with the Claude model it was triaged for.
argument-hint: "[id]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_next, mcp__plugin_ideamine_ideamine__idea_update
---

Build one idea from the archive, using the model recommended for it. Requested idea: $ARGUMENTS (empty means the best pick).

1. Call `idea_next`. Pass `id` if an id is given. If nothing is ready, say so and suggest /idea-triage. If the idea has no triage yet, ask whether to triage it first, then stop.
2. Tell the user the title and the recommended model in one line. Then call `idea_update` with status "doing".
3. Give the build to ONE subagent (Agent tool, general-purpose). Set its `model` to the recommended model (haiku, sonnet, opus, or fable). The purpose of this command is to send each idea to the cheapest model that can do it. In the subagent prompt, include the brief, the original note, and the project directory. Tell the subagent to work only in that directory, and to report what it changed and what is left to do.
4. When the subagent returns, call `idea_update`. Use status "done" with a one-line note. If work remains, keep status "doing" and write a note that says what remains. Then summarize in 2-3 lines.
