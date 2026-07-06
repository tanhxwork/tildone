import { useState } from "react";
import { useStore } from "../store";
import { todayStr, tomorrowStr } from "../utils/dates";

const DISMISS_KEY = "tildone-first-run-dismissed";

export function firstRunDismissed(): boolean {
  return localStorage.getItem(DISMISS_KEY) === "1";
}

interface Template {
  key: string;
  emoji: string;
  title: string;
  blurb: string;
  project: { name: string; color: string };
  tasks: { title: string; due?: "today" | "tomorrow"; tag?: string }[];
}

const TEMPLATES: Template[] = [
  {
    key: "build",
    emoji: "🛠️",
    title: "Physical build",
    blurb: "phases · materials · checkpoints",
    project: { name: "Build project", color: "#dd5b00" },
    tasks: [
      { title: "Sketch the plan & measure up", due: "today" },
      { title: "List materials & get quotes", tag: "shopping" },
      { title: "Order long-lead materials", tag: "shopping" },
      { title: "Prep the site" },
      { title: "First build day", due: "tomorrow" },
      { title: "Inspection / quality check" },
    ],
  },
  {
    key: "software",
    emoji: "💻",
    title: "Software project",
    blurb: "milestones · reviews · releases",
    project: { name: "Software project", color: "#5645d4" },
    tasks: [
      { title: "Write the one-page spec", due: "today" },
      { title: "Set up repo & CI", tag: "code" },
      { title: "Build the walking skeleton", tag: "code" },
      { title: "First internal demo", due: "tomorrow" },
      { title: "Cut v0.1 release" },
    ],
  },
  {
    key: "personal",
    emoji: "🌱",
    title: "Personal",
    blurb: "inbox · today · weekly review",
    project: { name: "Personal", color: "#1aae39" },
    tasks: [
      { title: "Brain-dump everything on your mind", due: "today" },
      { title: "Pick tomorrow's top 3", due: "today" },
      { title: "Weekly review — plan My Week", due: "tomorrow" },
    ],
  },
];

export function FirstRun({ onDone }: { onDone: () => void }) {
  const { addProject, addTask, addTag, projects } = useStore();
  const [busy, setBusy] = useState(false);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    onDone();
  }

  async function useTemplate(template: Template) {
    if (busy) return;
    setBusy(true);
    const beforeIds = new Set(projects.map((p) => p.id));
    await addProject(template.project.name, template.project.color);
    // addProject has no return value; the new project is the one that wasn't there before.
    const created = useStore.getState().projects.find((p) => !beforeIds.has(p.id));
    const projectId = created?.id ?? null;
    for (const t of template.tasks) {
      const tag_ids = t.tag ? [await addTag(t.tag)] : [];
      await addTask({
        title: t.title,
        project_id: projectId,
        due_date: t.due === "today" ? todayStr() : t.due === "tomorrow" ? tomorrowStr() : null,
        tag_ids,
      });
    }
    dismiss();
  }

  return (
    <div className="modal-overlay firstrun-overlay">
      <div className="modal firstrun" onClick={(e) => e.stopPropagation()}>
        <h2 className="firstrun-title">Welcome to Tildone</h2>
        <p className="firstrun-blurb">
          Everything stays on this Mac — no account, no cloud. Start with a template or a blank
          slate.
        </p>
        <div className="firstrun-templates">
          {TEMPLATES.map((template) => (
            <button
              key={template.key}
              className="firstrun-template"
              disabled={busy}
              onClick={() => void useTemplate(template)}
            >
              <span className="firstrun-emoji">{template.emoji}</span>
              <span className="firstrun-template-title">{template.title}</span>
              <span className="firstrun-template-blurb">{template.blurb}</span>
            </button>
          ))}
        </div>
        <div className="firstrun-footer">
          <button className="btn primary" disabled={busy} onClick={dismiss}>
            Start blank
          </button>
          <span className="firstrun-hint">
            or press <kbd>⌘N</kbd> to add your first task
          </span>
        </div>
      </div>
    </div>
  );
}
