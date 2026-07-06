import { useState } from "react";
import { useStore } from "../store";
import type { Project } from "../types";
import { COLOR_CHOICES } from "../types";
import { IconX } from "./Icons";
import {
  Button,
  field,
  fieldLabel,
  iconBtn,
  inputBase,
  modal,
  modalOverlay,
  modalTitle,
} from "./ui";

export function ProjectDialog({
  project,
  onClose,
}: {
  project: Project | null;
  onClose: () => void;
}) {
  const { addProject, editProject, removeProject } = useStore();
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState(project?.color ?? COLOR_CHOICES[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (project) {
      await editProject(project.id, trimmed, color);
    } else {
      await addProject(trimmed, color);
    }
    onClose();
  }

  return (
    <div className={modalOverlay} onClick={onClose}>
      <div
        className={`${modal} w-[340px]`}
        role="dialog"
        aria-label={project ? "Edit project" : "New project"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className={modalTitle}>{project ? "Edit Project" : "New Project"}</h2>
          <button className={iconBtn} aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>

        <label className={field}>
          <span className={fieldLabel}>Name</span>
          <input
            autoFocus
            className={inputBase}
            value={name}
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>

        <div className={field}>
          <span className={fieldLabel}>Color</span>
          <div className="flex gap-2">
            {COLOR_CHOICES.map((c) => (
              <button
                key={c}
                className={`size-[22px] rounded-full border-2 transition-[transform,border-color] hover:scale-[1.12] ${
                  c === color ? "border-ink" : "border-transparent"
                }`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {project &&
            (confirmDelete ? (
              <Button
                variant="danger"
                onClick={async () => {
                  await removeProject(project.id);
                  onClose();
                }}
              >
                Delete project and its tasks?
              </Button>
            ) : (
              <Button variant="ghost-danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={save}>
            {project ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
