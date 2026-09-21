---
name: ideas-find
description: Search the ideamine archive by meaning (nomic-embed-text), in every lane. The ideamine hook answers this with no model call.
argument-hint: "<words>"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list
---

Call `idea_list` with `semantic: true`, `filter: "all"`, and `query` set to: $ARGUMENTS

Show the result exactly as returned.
