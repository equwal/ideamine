---
name: ideas-ls
description: List the ideamine queue, one lane, or every lane (-a). The ideamine hook answers this with no model call.
argument-hint: "[inbox|do|maybe|skip|doing|done|dropped|-a] [here]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list
---

Call `idea_list` for this request: $ARGUMENTS

A lane name is the `filter`, `-a` is `filter: "all"`, and `here` is `here: true`. Pass other words as `query`. Show the board exactly as returned.
