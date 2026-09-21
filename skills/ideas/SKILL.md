---
name: ideas
description: The ideamine queue. ls, cat, rm, and done run on your machine with no model call. go builds the next idea on the cheapest model that can do it, all does every idea that fits this chat, and sort triages the inbox.
argument-hint: "ls [lane|-a|here] | cat N | rm N | go [N] | all | sort | done|start|reopen N | a question"
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list, mcp__plugin_ideamine_ideamine__idea_update, mcp__plugin_ideamine_ideamine__idea_next, mcp__plugin_ideamine_ideamine__idea_triage, mcp__plugin_ideamine_ideamine__idea_remove
---

Request: $ARGUMENTS

The first word of the request is the command. Do not ask the user anything. Do the command.

The user saves ideas from any session. Thus the project that an idea records is only the folder the user was in, and that folder can be wrong or gone. Judge by the text of the idea which ideas fit this chat, and where each idea belongs.

**go [N]**: build one idea with the model recommended for it.
1. Call `idea_next` with `triage: true`. Pass `id` if N is given. The tool triages new ideas first. If it says that the queue is empty, say so in one line and stop. If the triage failed and no idea came back, call `idea_triage` with no verdicts, judge those ideas, save all verdicts in ONE `idea_triage` call with your model name as `by`, and then call `idea_next` again.
2. If N is not given, the tool also returns the whole queue. If an idea in the queue clearly fits this chat (the current project or this conversation), call `idea_next` with its `id`, and build that idea. Else build the first idea.
3. Choose the directory for the build. Use the current project if the idea fits it. Else use the project directory of the idea if it exists and fits the idea (the tool tells if it exists). Else find the project that the idea is about. If you cannot find it, say so in one line and stop.
4. Tell the user the title, the recommended model, and the directory in one line. Then call `idea_update` with status "doing" and `project` set to that directory.
5. Give the build to ONE subagent (Agent tool, general-purpose). Set its `model` to the recommended model (haiku, sonnet, opus, or fable). This sends each idea to the cheapest model that can do it. Set `run_in_background` to false. Step 6 must run in this turn, because the permission to use the ideamine tools ends with the turn. In the subagent prompt, include the brief, the original note, and the directory. Tell the subagent to work only in that directory, and to report what it changed and what is left to do.
6. When the subagent returns, call `idea_update`. Use status "done" with a one-line note. If work remains, keep status "doing" and write a note that says what remains. Then summarize in 2-3 lines.

**all**: do every idea that fits this chat.
1. Call `idea_list` with `full: true`. It returns every idea in the queue, in full.
2. Choose the ideas that fit this chat: the current project or this conversation. If no idea fits, say so in one line and stop.
3. Call `idea_remove` with the `ids` of the ideas that fit. This takes them out of the queue. The other ideas stay in the queue for a chat that they fit.
4. Show the user the ideas that you took, one line each, and how many stay in the queue. Then do the ideas that you took, one at a time, as the user's request.

**sort**: call `idea_triage` with `headless: true`. If that call fails, call `idea_triage` with no verdicts, judge every idea, and save all verdicts in ONE `idea_triage` call with your model name as `by`. Show the result exactly as returned: the verdicts, then the queue.

**Anything else** (ls, cat, rm, done, start, reopen, drop, or a question): answer from `idea_list`. Pass `filter`, `id`, `query`, or `here` when the request asks for them. Show a board exactly as returned. To change a status, use `idea_update`. To delete ideas, use `idea_remove`. Keep the answer short. Do not start to build an idea.
