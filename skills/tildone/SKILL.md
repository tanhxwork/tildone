---
name: tildone-board
description: Drive the user's Tildone kanban board over the tildone-axi CLI while doing work — claim tasks, show live progress, ask when blocked, close with evidence. Use whenever a session starts, tracks, or finishes work the user follows on the Tildone board.
---

# Working the Tildone board

Tildone is the user's kanban board. You reach it with `tildone-axi` and nothing
else; run `tildone-axi doctor` if a call fails (exit 2 = unreachable, and the CLI
could not restart the app). The user watches the board live: every state change
in your work should appear on it when it happens, not in a closing summary.
`tildone-axi help` lists the verbs; the tool reference behind `tildone-axi call
<tool>` is `MCP.md` in the Tildone repo. This skill is the operating guide.

## A task has three surfaces — use the right one

| Your | Goes in | Via | The user sees |
|---|---|---|---|
| plan / checklist | subtasks | `sub add "<step>"`, `sub done <id>` | live progress bar on the card |
| running log | activity | `log "<text>"` | the Activity feed, timestamped |
| goal, findings, evidence | notes | `new "<title>"`, `note "<text>"` | the notes body |

Never write a `## Plan` or `## Log` section into notes — it renders as flat
text and every tick costs a full notes rewrite. A subtask tick is ~200 bytes; a
log line ~120.

## Lifecycle

1. **Look before you write.** `tildone-axi ls`, or `tildone-axi call
   list_tasks --search <text>` — adopt an existing task instead of duplicating.
   Tell the user the task ref you use.
2. **Claim when you start.** `tildone-axi claim <ref>` sets doing and binds this
   session (`CLAUDE_CODE_SESSION_ID`), checkout and branch, which renders the
   live chips. A new task: `tildone-axi new "<title>"`. Seed the goal with
   `note`, and one `sub add` per step.
3. **Progress as it happens.** `sub done <id>` for each finished step; `log` one
   short present-tense line per checkpoint. `tildone-axi call add_link --task-id
   <id> --url <url> --label <text>` for each artifact at birth: branch pushed,
   PR opened, commit landed.
4. **Blocked?** `tildone-axi call add_comment --task-id <id> --body "<question>"`,
   tag the task `blocked` (`call update_task` replaces tags wholesale; read them
   first), then `tildone-axi wait` parks until the board changes — the user's
   reply arrives as a `comment` change and wakes you. Remove the tag when clear.
5. **Close only verified work.** `tildone-axi done` after tests/build/behavior
   are proven; `log` what shipped and `note` the evidence. Unverified but done:
   tag `needs-review` instead.

## Token discipline

- Writes print a short receipt, not the row — `tildone-axi show <ref>` only when
  you need full state.
- `call update_task` **replaces** provided fields wholesale, `notes` and `tags`
  included. Prefer `note` for new facts; read-merge-write only to rewrite
  superseded prose.
- Don't poll `ls` for changes — park `tildone-axi wait` and sleep.
- `call delete_task` is safe (trash). `call delete_project` permanently deletes
  its tasks — never run it without explicit user confirmation.
