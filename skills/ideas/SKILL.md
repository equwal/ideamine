---
name: ideas
description: Show the ideamine queue, or ask a question about your ideas. With no question, the ideamine hook shows the queue with no model call.
argument-hint: "[a question]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list, mcp__plugin_ideamine_ideamine__idea_update, mcp__plugin_ideamine_ideamine__idea_remove
---

Request: $ARGUMENTS

Answer from `idea_list`. Pass `filter`, `id`, `query`, `here`, or `full` when the request asks for them. If the request is empty, show the board exactly as returned. To change a status, use `idea_update`. To delete ideas, use `idea_remove`. Keep the answer short. Do not start to build an idea: /ideas-go and /ideas-all do that.
