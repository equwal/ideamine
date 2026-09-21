---
name: ideas-rm
description: Delete ideamine ideas for good. The ideamine hook answers this with no model call.
argument-hint: "<id...>"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_remove
---

Call `idea_remove` with the ids in "$ARGUMENTS" as `ids`. Reply with the first line of the result.
