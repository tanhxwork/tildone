# Tildone MCP server — agent reference

Tildone embeds an [MCP](https://modelcontextprotocol.io) server so AI agents
can create and manage the user's tasks. This document is the full tool
reference; it is safe to paste into an agent's context.

## Connecting

- **Endpoint:** `http://127.0.0.1:11502/mcp` (MCP Streamable HTTP)
- The Tildone app must be **running** and **Settings → Agent access** must be
  **On** (off by default). If the connection is refused, ask the user to open
  Tildone and enable it.
- 11502 is the **installed app**. A dev build (`bun run tauri dev`) takes a free
  port instead, so it never knocks the installed app off the air — Settings shows
  the real endpoint. To point an agent at a dev build, pin it with
  `TILDONE_AGENT_PORT=11599 bun run tauri dev`.
- Start Tildone **before** the agent session. Clients connect to MCP servers
  once, at startup — a session that began while Tildone was closed (or Agent
  access was Off) has no tildone tools, and calls fail with "No such tool
  available" rather than a connection error. Reconnect the server (`/mcp` in
  Claude Code) or restart the session; the app coming up later is not enough
  on its own.
- Beware: `claude mcp list` probes in a **separate process**, so it reports
  `✔ Connected` even when your own session has no tildone tools. A real tool
  call is the only reliable check.
- Once a session is connected, restarting Tildone is safe — the client
  reconnects on its own within a few seconds (verified across a 2-minute
  outage). Unknown/expired session ids get a `404`, which is the client's cue
  to re-initialize.
- **New tools are the exception to that.** Clients cache the tool list from
  when they connected, so a Tildone build that *adds* a tool stays invisible to
  sessions already running — the existing tools keep working and the new one is
  simply absent, even though the server serves it. Restart the client session
  after upgrading Tildone if you expect a new tool.
- Localhost only, no authentication. Requests carrying a browser `Origin`
  header are rejected (403).

Client setup examples:

```bash
# Claude Code
claude mcp add --transport http tildone http://127.0.0.1:11502/mcp
```

```json
// Any client using a JSON config with streamable HTTP support
{ "mcpServers": { "tildone": { "type": "http", "url": "http://127.0.0.1:11502/mcp" } } }
```

## Data model

| Concept | Details |
|---|---|
| **Task** | `title`, `notes`, `status` (`todo` / `doing` / `done`), `priority` (0 none, 1 low, 2 medium, 3 high), `due_date` (`YYYY-MM-DD` or null), optional project, tag names |
| **Subtask** | A task's checklist item: `title`, `done`, kept in insertion order. Returned by `get_task`. The board card renders them as a live progress bar — **put your plan checklist here, not in `notes`**, and tick items as you go so the user can watch progress. Every subtask write returns `progress: {done, total}`. |
| **Activity** | A task's timestamped log, shown as the **Activity** feed in the app. Tildone writes an entry for every field change on its own; `log_progress` adds your narrative ones. **Put your running log here, not in `notes`.** |
| **Project** | Named container with a color. Deleting a project permanently deletes its tasks. |
| **Inbox** | Where tasks without a project live. Pass `"inbox"` (or omit `project`) to target it. |
| **Tags** | Case-insensitive names. Unknown tag names are **created automatically** when used on a task. |
| **Trash** | `delete_task` is a soft delete; the user can restore for 30 days inside the app. Trashed tasks are hidden from `list_tasks` and refuse further updates. |

Conventions:

- Refer to **projects and tags by name** (project id also works). Project
  matching is case-insensitive. Unknown project names are **not** created
  silently — you get an error listing the existing projects; call
  `create_project` first if the user wants a new one.
- Clearing fields on update: `due_date: ""` clears the due date,
  `priority: 0` clears priority, `project: "inbox"` moves the task out of
  any project.
- **Order is the board.** `list_tasks` returns tasks in the order the user sees
  them, so `list_tasks(project: "X", status: "todo")` starts at the top card of
  that column — *"work the top task first"* means **rank 0**. `rank` is a dense
  0-based ordinal within a **(project, status)** group. It is **not** comparable
  across projects, and it is `null` for a trashed task.
- **Rank is read-only** — only the user reorders, by dragging. No tool takes a
  rank or position, by design: the board is theirs.
- **A task has three surfaces — use the right one.** They each have their own
  storage and their own place in the UI, and picking wrong is what makes progress
  expensive and invisible:

  | Your | Goes in | Via | The user sees |
  |---|---|---|---|
  | plan / checklist | subtasks | `add_subtask` / `set_subtask` | a live progress bar on the card |
  | running log | activity | `log_progress` | the Activity feed, timestamped |
  | goal, findings, evidence | `notes` | `create_task` / `append_note` | the notes body |

  Writing a `## Plan` checklist or a `## Log` section **into `notes`** works, but it
  is the expensive path: ticking one box then means resending the whole notes blob
  through `update_task`, and none of it renders as progress. Keep `notes` as prose
  that rarely changes, and it stays cheap to append to.
- Tasks are **not** sorted by due date. Use `due_before` to ask for overdue work.
- Tool errors (unknown id, bad date, unknown project…) come back as MCP tool
  errors with a human-readable message — read it, it usually says what to do.
- All writes are visible in the user's open app immediately.

## Tools

### Read

| Tool | Arguments | Returns |
|---|---|---|
| `list_projects` | — | `[{id, name, color, open_tasks, done_tasks}]` |
| `list_tags` | — | `[{id, name, color, task_count}]` |
| `list_tasks` | all optional: `project` (name/id/`"inbox"`), `status`, `due_before` (`YYYY-MM-DD`), `tag`, `search` (substring in title/notes), `include_done` (bool) | `{count, tasks: [{id, title, status, priority, due_date, completed_at, project, tags, rank}]}` |
| `get_task` | `id` | full task incl. `notes`, `tags`, `subtasks`, `created_at`, `rank` |
| `list_changes` | all optional: `since` (cursor), `wait_ms` (block up to N ms, max 60000) | `{cursor, changes: [{id, entity, entity_id, kind, created_at}], truncated?}` |

By default `list_tasks` excludes completed tasks; pass `include_done: true`
or `status: "done"` to see them. Trashed tasks are never listed.

### Waking on board changes

`list_changes` lets you **wait for the user** instead of polling. Call it once
with no arguments to get a cursor, then pass that cursor back with a `wait_ms`:
the call **blocks** until something changes, then returns the changes and a new
cursor. Loop on it.

```jsonc
{ "name": "list_changes", "arguments": {} }
// -> {"cursor": 41, "changes": []}

{ "name": "list_changes", "arguments": { "since": 41, "wait_ms": 30000 } }
// ... the call parks; the user drags a card into To Do ...
// -> {"cursor": 42, "changes": [{"id": 42, "entity": "task", "entity_id": 7,
//                                "kind": "status", "created_at": "..."}]}
```

- `kind` is one of `created`, `status`, `moved`, `trashed`, `restored`, `edited`.
  `entity` is always `"task"` today.
- A change says **that** a task changed, not what it now is — it carries no task
  fields. Follow up with `get_task` / `list_tasks`.
- **Every writer is caught**, because the feed is written by database triggers
  rather than by the app: a card dragged across the board and a task updated by
  another agent both show up, with no cooperation required from either.
- A write that changes nothing produces nothing, so a drag that reshuffles a
  column reports `moved` for the cards that moved — not a `status` change for
  every card it rewrote.
- A timeout is a **normal result**: an empty `changes` and the same `cursor`.
  Call again to keep waiting.
- Omitting `since` always returns immediately with a baseline — it never replays
  history, and `wait_ms` is ignored.
- Changes are kept for **30 days**. If your cursor is older than that, the reply
  carries `truncated: true` and a note: the list is incomplete, so re-sync with
  `list_tasks` and continue from the returned `cursor`.
- Like every tool here, this only runs while **Tildone is open**. A parked call
  returns as soon as the app quits.

### Write

| Tool | Arguments | Notes |
|---|---|---|
| `create_task` | `title` (required); optional `project`, `notes`, `due_date`, `priority`, `tags` (array), `status` | Omit `project` → Inbox. |
| `update_task` | `id` (required); any of `title`, `notes`, `status`, `priority`, `due_date`, `project`, `tags` | Only provided fields change, but a provided field **replaces** wholesale — `notes` and `tags` included. Read before you write, or use `append_note`. |
| `append_note` | `id`, `text` | Appends prose to the **end** of `notes` (newline-separated). It cannot destroy existing notes and costs the same however long they are, but it is **end-only** — it cannot insert into a section. For a running log use `log_progress`. Returns a `notes_chars` size hint. |
| `log_progress` | `task_id`, `text` | One narrative line — what you just did, found or decided. Lands in the task's **Activity** feed, timestamped. **Prefer this for progress logs**, not a `## Log` section in `notes`. |
| `complete_task` | `id` | Shorthand for `status: "done"`; sets the completion timestamp. |
| `delete_task` | `id` | Soft delete to the app's trash (restorable by the user). |
| `add_subtask` | `task_id`, `title` | Appends to the end of the task's checklist. |
| `set_subtask` | `id` (the **subtask** id), optional `done`, `title` | Tick/untick or rename. Only provided fields change. |
| `delete_subtask` | `id` (the **subtask** id) | **Hard** delete — subtasks have no trash. |
| `create_project` | `name` (required), `color` (hex, optional) | Fails if the name already exists. |
| `update_project` | `id` (required), `name`, `color` | |
| `delete_project` | `id` | **Destructive and irreversible** — permanently deletes the project *and all its tasks*. Confirm with the user first. |

Writes return a **receipt, not the row**: `{id, title, status}` (plus
`completed_at` once done). They deliberately do not echo `notes`/`tags`/etc. back
— that doubled the cost of every update. Call `get_task` when you genuinely need
the full task after a write. Subtask writes also return `progress: {done, total}`.

### Examples

```jsonc
// A task for a specific project, due Friday, tagged
{ "name": "create_task", "arguments": {
  "title": "Prepare quarterly report",
  "project": "Work", "due_date": "2026-07-10",
  "priority": 2, "tags": ["reports", "q3"],
  "notes": "Include the revenue breakdown the user asked for." } }

// Everything overdue or due today, any project
{ "name": "list_tasks", "arguments": { "due_before": "2026-07-06" } }

// The top card of a project's To Do column — the one to work first
{ "name": "list_tasks", "arguments": { "project": "Work", "status": "todo" } }
// -> {"count": 3, "tasks": [{"id": 31, "rank": 0, ...}, {"rank": 1}, {"rank": 2}]}

// Move a task to another project and bump priority
{ "name": "update_task", "arguments": { "id": 42, "project": "Home", "priority": 3 } }
```

## Recommended agent workflow

1. `list_projects` (and `list_tags` if tagging) to learn what exists.
2. Look before you write: `list_tasks` with a `search`/`project` filter to
   avoid creating duplicates.
3. Create or update tasks; report the returned task ids back to the user.
4. Treat `delete_project` (and bulk deletions in general) as
   confirm-with-the-user operations. `delete_task` is safe — it goes to the
   trash.
