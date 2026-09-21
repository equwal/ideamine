---
name: idea
description: Save an idea to the ideamine archive for later without derailing the current task. The ideamine hook usually answers this instantly, with no model call.
argument-hint: <your idea>
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_add
---

Save this idea with the `idea_add` tool. Pass it verbatim as `text`:

$ARGUMENTS

Only save it. Do not plan, discuss, or start building it. Reply with the one-line result from the tool, then continue what you were doing before.
