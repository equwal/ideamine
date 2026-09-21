---
name: ideas-groups
description: Show the ideamine ideas grouped by meaning (nomic-embed-text). A lane name or -a picks the ideas. The ideamine hook answers this with no model call.
argument-hint: "[inbox|do|maybe|skip|doing|done|dropped|-a]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list
---

Call `idea_list` with `groups: true` for this request: $ARGUMENTS

A lane name is the `filter`, and `-a` is `filter: "all"`. Show the result exactly as returned.
