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
    <div className="quick-add">
      <IconPlus size={15} />
      <input
        ref={inputRef}
        value={title}
        placeholder={`Add a task (${hint})…`}
        aria-label="New task title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
    </div>
  );
}
