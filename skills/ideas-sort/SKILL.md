---
name: ideas-sort
description: Triage the ideamine inbox now and show the queue. You do not have to, because /ideas-go triages when it must.
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_triage
---

Call `idea_triage` with `headless: true`. If that call fails, call `idea_triage` with no verdicts, judge every idea, and save all verdicts in ONE `idea_triage` call with your model name as `by`. Show the result exactly as returned: the verdicts, then the queue.
