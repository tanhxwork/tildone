# TaskFlow

A lightweight desktop app for project and task management, built with Tauri 2, React 19, TypeScript, and a local SQLite database. Fully offline — all data stays on your machine.

## Features

- **Projects & tasks** — create projects (with colors), add tasks with notes, due dates, and priorities
- **Kanban board** — drag-and-drop cards across To Do / In Progress / Done columns
- **Today & Upcoming** — cross-project views by due date, with overdue highlighting
- **Inbox** — tasks that don't belong to a project yet
- **Tags, filters & search** — tag tasks, filter by tag/priority, search across titles and notes
- **Light & dark mode** — follows the system appearance

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

## Architecture

- `src-tauri/` — Rust shell. Registers `tauri-plugin-sql` with the schema migration in `src-tauri/migrations/`. The SQLite file lives in the app's data directory (`~/Library/Application Support/com.hongxuan.taskflow/taskflow.db` on macOS).
- `src/db.ts` — thin data-access layer; all SQL lives here.
- `src/store.ts` — zustand store; optimistic UI state + persistence via `db.ts`.
- `src/selectors.ts` — pure filtering/selection logic shared by the list and board views.
- `src/components/` — UI: `Sidebar`, `Header` (search/filters/view toggle), `QuickAdd`, `TaskList`, `Kanban` (dnd-kit), `TaskEditor` (details panel), `ProjectDialog`.

Tasks have a `status` (`todo` / `doing` / `done`) that drives the kanban columns; the list views treat `done` as completed and everything else as open.
