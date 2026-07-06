import { useState, type RefObject } from "react";
import { useStore } from "../store";
import { todayStr, tomorrowStr } from "../utils/dates";
import { IconPlus } from "./Icons";

export function QuickAdd({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { selection, addTask } = useStore();
  const [title, setTitle] = useState("");

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    const project_id = selection.type === "project" ? selection.projectId : null;
    const due_date =
      selection.type === "today"
        ? todayStr()
        : selection.type === "upcoming"
          ? tomorrowStr()
          : null;
    await addTask({ title: trimmed, project_id, due_date });
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
    <div className="mx-5 my-3 flex items-center gap-2 rounded-lg border border-edge bg-card px-2.5 py-[7px] text-ink-faint transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]">
      <IconPlus size={15} />
      <input
        ref={inputRef}
        value={title}
        placeholder={`Add a task (${hint})…`}
        aria-label="New task title"
        className="flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
    </div>
  );
}
