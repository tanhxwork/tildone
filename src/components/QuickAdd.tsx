import { useMemo, useState, type RefObject } from "react";
import { useStore } from "../store";
import { PRIORITY_LABELS } from "../types";
import { dueLabel, todayStr, tomorrowStr } from "../utils/dates";
import { parseQuickAdd } from "../utils/quickParse";
import { IconPlus } from "./Icons";

export function QuickAdd({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { selection, addTask, addTag, projects, tags } = useStore();
  const [title, setTitle] = useState("");

  const parsed = useMemo(
    () => parseQuickAdd(title, { projects, tags }),
    [title, projects, tags],
  );
  const previewProject = projects.find((p) => p.id === parsed.projectId);
  const hasTokens =
    parsed.dueDate !== null ||
    previewProject !== undefined ||
    parsed.priority > 0 ||
    parsed.tagNames.length > 0;

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    const p = parseQuickAdd(trimmed, { projects, tags });
    // Parsed tokens override the view defaults; absent tokens keep them.
    const project_id =
      p.projectId ?? (selection.type === "project" ? selection.projectId : null);
    const due_date =
      p.dueDate ??
      (selection.type === "today"
        ? todayStr()
        : selection.type === "upcoming"
          ? tomorrowStr()
          : null);
    const tag_ids: number[] = [];
    for (const name of p.tagNames) tag_ids.push(await addTag(name));
    await addTask({
      // An input that is all tokens ("tomorrow !high") keeps the raw text as title.
      title: p.title || trimmed,
      project_id,
      due_date,
      priority: p.priority,
      tag_ids,
    });
    setTitle("");
  }

  const hint =
    selection.type === "today"
      ? "due today"
      : selection.type === "upcoming"
        ? "due tomorrow"
        : selection.type === "project"
          ? "in this project"
          : "to inbox";

  return (
    <>
      <div className="quick-add">
        <IconPlus size={15} />
        <input
          ref={inputRef}
          value={title}
          placeholder={`Add a task (${hint})… try "pay rent tomorrow #home !high"`}
          aria-label="New task title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      {hasTokens && (
        <div className="quick-add-preview" aria-live="polite">
          {parsed.dueDate !== null && (
            <span className="qa-chip qa-date">{dueLabel(parsed.dueDate)}</span>
          )}
          {previewProject && <span className="qa-chip qa-project">#{previewProject.name}</span>}
          {parsed.priority > 0 && (
            <span className="qa-chip qa-priority">{PRIORITY_LABELS[parsed.priority]}</span>
          )}
          {parsed.tagNames.map((name) => (
            <span key={name.toLowerCase()} className="qa-chip qa-tag">
              @{name}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
