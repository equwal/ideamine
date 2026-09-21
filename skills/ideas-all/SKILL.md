---
name: ideas-all
description: Do every ideamine idea that fits this chat. Claude takes those ideas out of the queue. The other ideas stay in the queue.
disable-model-invocation: true
allowed-tools: mcp__plugin_ideamine_ideamine__idea_list, mcp__plugin_ideamine_ideamine__idea_remove
---

Do every idea from the queue that fits this chat. Do not ask the user anything.

The user saves ideas from any session. The triage pairs each idea with its project folder when one fits. Else the project of an idea is only the folder where the user saved it, and that folder can be wrong or gone. Judge by the text of each idea whether it fits this chat.

1. Call `idea_list` with `full: true`. It returns every idea in the queue, in full.
2. Choose the ideas that fit this chat: the current project or this conversation. If no idea fits, say so in one line and stop.
3. Call `idea_remove` with the `ids` of the ideas that fit. This takes them out of the queue. The other ideas stay in the queue for a chat that they fit.
4. Show the user the ideas that you took, one line each, and how many stay in the queue. Then do the ideas that you took, one at a time, as the user's request.
