---
name: idea-triage
description: Triage the ideamine inbox. Decide which ideas are worth doing, and pick the cheapest Claude model that can build each one.
argument-hint: "[max ideas]"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_triage
---

1. Call `idea_triage` with `headless: true`. If a number is given here, pass it as `limit`: $ARGUMENTS
   This runs the triage in a separate, minimal Claude Code call. It does not use your context, so it costs little whatever model you are on.
2. If the call succeeds, show its summary as returned and name the single best pick. Stop.
3. If the call fails (for example, the Claude Code CLI cannot be found), do the triage yourself. Call `idea_triage` with no verdicts to get the rubric and the ideas. Judge every idea. Save all verdicts in ONE `idea_triage` call, with your model name as `by`. Then show the summary.
