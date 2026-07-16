import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { Project, ProjectIcon } from "../types";
import { COLOR_CHOICES } from "../types";
import { IconX } from "./Icons";

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

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
  // Folder override: "" in the DB means "icon off"; we model that as a checkbox.
  const [iconOff, setIconOff] = useState(project?.folder_path === "");
  const [folder, setFolder] = useState(
    project?.folder_path && project.folder_path !== "" ? project.folder_path : "",
  );
  const [preview, setPreview] = useState<ProjectIcon | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Live-preview the discovered icon as name/folder change, so the choice is
  // visible before saving. Skipped when the icon is turned off.
  useEffect(() => {
    if (iconOff || !name.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      invoke<ProjectIcon>("discover_project_icon", {
        name: name.trim(),
        folder: folder.trim() || null,
      })
        .then((icon) => {
          if (!cancelled) setPreview(icon);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [name, folder, iconOff]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (project) {
      const folderPath = iconOff ? "" : folder.trim() || null;
      await editProject(project.id, trimmed, color, folderPath);
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

        {project && (
          <div className="field">
            <span className="field-label">Icon</span>
            <p className="field-hint">
              Discovered from the project folder. Leave the path blank to use{" "}
              <code>~/projects/{name.trim() || project.name}</code>.
            </p>
            <input
              value={folder}
              placeholder={preview?.folder ?? `~/projects/${project.name}`}
              disabled={iconOff}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
            <div className="icon-preview">
              {iconOff ? (
                <span className="icon-preview-status">Using the colour dot.</span>
              ) : preview?.dataUri ? (
                <>
                  <img className="icon-preview-img" src={preview.dataUri} alt="" />
                  <span className="icon-preview-status">
                    {preview.iconPath ? basename(preview.iconPath) : "Found"}
                  </span>
                </>
              ) : (
                <span className="icon-preview-status">
                  No icon found — using the colour dot.
                </span>
              )}
            </div>
            <label className="icon-off-toggle">
              <input
                type="checkbox"
                checked={iconOff}
                onChange={(e) => setIconOff(e.target.checked)}
              />
              Use the colour dot instead
            </label>
          </div>
        )}

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
