import type { Project, Tag, Task } from "../types";
import { STATUS_LABELS } from "../types";

interface Snapshot {
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
}

export function toJSON({ projects, tasks, tags }: Snapshot): string {
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      app: "tildone",
      projects: projects.map((p) => ({ name: p.name, color: p.color })),
      tasks: tasks
        .filter((t) => t.deleted_at === null)
        .map((t) => ({
          title: t.title,
          notes: t.notes || undefined,
          status: t.status,
          priority: t.priority || undefined,
          due_date: t.due_date ?? undefined,
          completed_at: t.completed_at ?? undefined,
          created_at: t.created_at,
          project: t.project_id !== null ? projectName.get(t.project_id) : undefined,
          tags: t.tag_ids.length > 0 ? t.tag_ids.map((id) => tagName.get(id)).filter(Boolean) : undefined,
        })),
    },
    null,
    2,
  );
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCSV({ projects, tasks, tags }: Snapshot): string {
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const header = "title,project,tags,priority,due_date,status,notes,completed_at";
  const rows = tasks
    .filter((t) => t.deleted_at === null)
    .map((t) =>
      [
        t.title,
        t.project_id !== null ? (projectName.get(t.project_id) ?? "") : "",
        t.tag_ids.map((id) => tagName.get(id)).filter(Boolean).join(";"),
        t.priority > 0 ? String(t.priority) : "",
        t.due_date ?? "",
        t.status,
        t.notes,
        t.completed_at ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  return [header, ...rows].join("\n");
}

export function toMarkdown({ projects, tasks, tags }: Snapshot): string {
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const live = tasks.filter((t) => t.deleted_at === null);
  const lines: string[] = ["# Tildone export", ""];

  const section = (title: string, list: Task[]) => {
    if (list.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const t of list) {
      const check = t.status === "done" ? "x" : " ";
      const bits: string[] = [];
      if (t.status === "doing") bits.push(STATUS_LABELS.doing);
      if (t.due_date) bits.push(`due ${t.due_date}`);
      if (t.priority > 0) bits.push(["", "low", "medium", "high"][t.priority]);
      for (const id of t.tag_ids) {
        const name = tagName.get(id);
        if (name) bits.push(`@${name}`);
      }
      lines.push(`- [${check}] ${t.title}${bits.length > 0 ? ` (${bits.join(", ")})` : ""}`);
      if (t.notes) {
        for (const noteLine of t.notes.split("\n")) lines.push(`  ${noteLine}`);
      }
    }
    lines.push("");
  };

  section("Inbox", live.filter((t) => t.project_id === null));
  for (const p of projects) {
    section(p.name, live.filter((t) => t.project_id === p.id));
  }
  return lines.join("\n");
}

/** Minimal CSV parser: quoted fields, embedded commas/newlines/escaped quotes. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}
