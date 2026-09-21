---
name: ideas-reopen
description: Put an ideamine idea back in the queue, for example one that the triage skipped. The ideamine hook answers this with no model call.
argument-hint: "<id> [note]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_update
---

Request: $ARGUMENTS

Call `idea_update` with status "reopen". The first word of the request is the `id`. The other words, if there are any, are the `note`. Reply with the one-line result.
