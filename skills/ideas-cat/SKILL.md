---
name: ideas-cat
description: Show ideamine ideas in full. The ideamine hook answers this with no model call.
argument-hint: "<id...>"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list
---

For each id in "$ARGUMENTS", call `idea_list` with that `id`. Show each result exactly as returned.
