---
name: ideas
description: Show the ideamine board or one idea, or answer a question about your saved ideas. The ideamine hook answers board and edit requests instantly, with no model call.
argument-hint: "[open|inbox|do|maybe|done|all|here] | #id | done|drop|start|reopen <id> | a question"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list, mcp__plugin_ideamine_ideamine__idea_update
---

Request: $ARGUMENTS

Call `idea_list`. Pass `filter`, `id`, `query`, or `here` when the request asks for them. Then answer the request from the result. If the request is empty or names only a filter, show the board exactly as returned. To change a status, use `idea_update`. Keep the answer short. Do not start building an idea.
