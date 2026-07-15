# Tildone MCP server — agent reference

Tildone embeds an [MCP](https://modelcontextprotocol.io) server so AI agents
can create and manage the user's tasks. This document is the full tool
reference; it is safe to paste into an agent's context.

## Connecting

- **Endpoint:** `http://127.0.0.1:11502/mcp` (MCP Streamable HTTP)
- The Tildone app must be **running** and **Settings → Agent access** must be
  **On** (off by default). If the connection is refused, ask the user to open
  Tildone and enable it.
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
- Tool errors (unknown id, bad date, unknown project…) come back as MCP tool
  errors with a human-readable message — read it, it usually says what to do.
- All writes are visible in the user's open app immediately.

## Tools

### Read

| Tool | Arguments | Returns |
|---|---|---|
| `list_projects` | — | `[{id, name, color, open_tasks, done_tasks}]` |
| `list_tags` | — | `[{id, name, color, task_count}]` |
| `list_tasks` | all optional: `project` (name/id/`"inbox"`), `status`, `due_before` (`YYYY-MM-DD`), `tag`, `search` (substring in title/notes), `include_done` (bool) | `{count, tasks: [{id, title, status, priority, due_date, completed_at, project, tags}]}` |
| `get_task` | `id` | full task incl. `notes`, `tags`, `subtasks`, `created_at` |

By default `list_tasks` excludes completed tasks; pass `include_done: true`
or `status: "done"` to see them. Trashed tasks are never listed.

### Write

| Tool | Arguments | Notes |
|---|---|---|
| `create_task` | `title` (required); optional `project`, `notes`, `due_date`, `priority`, `tags` (array), `status` | Omit `project` → Inbox. |
| `update_task` | `id` (required); any of `title`, `notes`, `status`, `priority`, `due_date`, `project`, `tags` | Only provided fields change, but a provided field **replaces** wholesale — `notes` and `tags` included. Read before you write, or use `append_note`. |
| `append_note` | `id`, `text` | Appends to `notes` (newline-separated). **Prefer this for progress logs** — it cannot destroy existing notes, and costs the same however long the notes are. Returns a `notes_chars` size hint. |
| `complete_task` | `id` | Shorthand for `status: "done"`; sets the completion timestamp. |
| `delete_task` | `id` | Soft delete to the app's trash (restorable by the user). |

Writes return a **receipt, not the row**: `{id, title, status}` (plus
`completed_at` once done). They deliberately do not echo `notes`/`tags`/etc. back
— that doubled the cost of every update. Call `get_task` when you genuinely need
the full task after a write.
| `create_project` | `name` (required), `color` (hex, optional) | Fails if the name already exists. |
| `update_project` | `id` (required), `name`, `color` | |
| `delete_project` | `id` | **Destructive and irreversible** — permanently deletes the project *and all its tasks*. Confirm with the user first. |

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
