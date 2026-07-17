---
name: tildone-board
description: Drive the user's Tildone kanban board over MCP while doing work — claim tasks, show live progress, ask when blocked, close with evidence. Use whenever a session starts, tracks, or finishes work the user follows on the Tildone board.
---

# Working the Tildone board

Tildone is the user's kanban board (MCP server `tildone`, default endpoint
`http://127.0.0.1:11502/mcp`). The user watches it live: every state change in
your work should appear on the board when it happens, not in a closing summary.
Full tool reference: `MCP.md` in the Tildone repo — this skill is the operating
guide.

## A task has three surfaces — use the right one

| Your | Goes in | Via | The user sees |
|---|---|---|---|
| plan / checklist | subtasks | `add_subtask`, `set_subtask` | live progress bar on the card |
| running log | activity | `log_progress` | the Activity feed, timestamped |
| goal, findings, evidence | notes | `create_task`, `append_note` | the notes body |

Never write a `## Plan` or `## Log` section into `notes` — it renders as flat
text and every tick costs a full notes rewrite. A subtask tick is ~200 bytes; a
log line ~120.

## Lifecycle

1. **Look before you write.** `list_tasks` with `search`/`project` — adopt an
   existing task instead of duplicating. Tell the user the task ref you use.
2. **Claim when you start.** Set `status: "doing"` and send `session_id` (your
   `CLAUDE_CODE_SESSION_ID`), plus `cwd` and `branch` once you have a worktree —
   that renders the live chips. Seed `notes` with the goal, one subtask per step.
3. **Progress as it happens.** Tick each subtask when done; `log_progress` one
   short present-tense line per checkpoint. `add_link` each artifact at birth:
   branch pushed, PR opened, commit landed.
4. **Blocked?** `add_comment` the question, tag the task `blocked`, then park
   `list_changes` (`since` + `wait_ms`) on it — the user's reply arrives as a
   `comment` change and wakes you. Remove the tag when clear.
5. **Close only verified work.** `complete_task` after tests/build/behavior are
   proven; log what shipped and append evidence to notes. Unverified but done:
   tag `needs-review` instead.

## Token discipline

- Writes return a receipt `{id, ref, status}`, not the row — call `get_task`
  only when you need full state. Null fields are omitted from all responses.
- `update_task` **replaces** provided fields wholesale, `notes` and `tags`
  included. Prefer `append_note` for new facts; read-merge-write only to rewrite
  superseded prose.
- Don't poll `list_tasks` for changes — park `list_changes` and sleep.
- `delete_task` is safe (trash). `delete_project` permanently deletes its tasks
  — never call it without explicit user confirmation.
