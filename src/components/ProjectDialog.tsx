import { useState } from "react";
import { useStore } from "../store";
import type { Project } from "../types";
import { COLOR_CHOICES } from "../types";
import { IconX } from "./Icons";

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
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={project ? "Edit project" : "New project"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{project ? "Edit Project" : "New Project"}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            autoFocus
            value={name}
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>

        <div className="field">
          <span className="field-label">Color</span>
          <div className="color-row">
            {COLOR_CHOICES.map((c) => (
              <button
                key={c}
                className={`color-swatch ${c === color ? "selected" : ""}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className="modal-footer">
          {project &&
            (confirmDelete ? (
              <button
                className="btn danger"
                onClick={async () => {
                  await removeProject(project.id);
                  onClose();
                }}
              >
                Delete project and its tasks?
              </button>
            ) : (
              <button className="btn ghost-danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            ))}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            {project ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
