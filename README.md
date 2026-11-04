# Tildone

A lightweight desktop app for project and task management, built with Tauri 2, React 19, TypeScript, and a local SQLite database. Fully offline — all data stays on your machine.

## Features

- **Projects & tasks** — create projects (with colors), add tasks with notes, due dates, and priorities
- **Kanban board** — drag-and-drop cards across To Do / In Progress / Done columns
- **Inbox** — tasks without a project, grouped at the top of All Tasks
- **Tags, filters & search** — tag tasks, filter by tag/priority, search across titles and notes
- **Light & dark mode** — follows the system appearance
- **Agent access** — opt-in local server so AI agents can manage your tasks through `tildone-axi`

## Agent access

Agents (Claude Code or any shell-capable agent) manage tasks, under a specific
project or in the Inbox, through the `tildone-axi` command-line tool. It is the
only agent interface.

1. In Tildone, open **Settings → Agent access** and switch it **On**.
2. Install the command-line tool from **Settings → Agent access → Command-line
   tool**, then run `tildone-axi doctor` to check the link.

On Linux with `TILDONE_URL` unset, `tildone-axi` starts a closed Tildone by itself. Exit code 2 means the
app could not be reached or restarted. For a hub on another machine, set
`TILDONE_URL` and `TILDONE_TOKEN`.

Agents get tools to list/create/update/complete/delete tasks (title, notes,
status, priority, due date, tags) and to manage projects, referring to projects
and tags by name. Changes show up in the app instantly. See **[MCP.md](MCP.md)**
for the full tool reference behind `tildone-axi call <tool>` (safe to paste into an agent's context).

Notes: the server only runs while Tildone is open, listens on localhost only,
and is off by default. Deleted tasks go to the app's trash; deleting a project
is permanent.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | Focus quick-add |
| `⌘K` | Focus search |
| `Esc` | Close the details panel |
| `Enter` | Add task / commit edit |

## Development

Prerequisites: Node.js 18+, Rust toolchain, Xcode Command Line Tools (macOS).

```bash
npm install
npm run tauri dev     # run the app with hot reload
npm run tauri build   # produce a distributable .app / .dmg
```

The e2e specs, their helpers and their gotchas are described in [`tests/e2e/README.md`](tests/e2e/README.md).

## Architecture

- `src-tauri/` — Rust shell. Registers `tauri-plugin-sql` with the schema migration in `src-tauri/migrations/`. The SQLite file lives in the app's data directory (`~/Library/Application Support/com.tildone.desktop/tildone.db` on macOS).
- `src/db.ts` — thin data-access layer; all SQL lives here.
- `src/store.ts` — zustand store; optimistic UI state + persistence via `db.ts`.
- `src/selectors.ts` — pure filtering/selection logic shared by the list and board views.
- `src/components/` — UI: `Sidebar`, `Header` (search/filters/view toggle), `QuickAdd`, `TaskList`, `Kanban` (dnd-kit), `TaskEditor` (details panel), `ProjectDialog`.

Tasks have a `status` (`todo` / `doing` / `done`) that drives the kanban columns; the list views treat `done` as completed and everything else as open.
