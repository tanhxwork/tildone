import { useMemo, useState } from "react";
import { liveTasks } from "../selectors";
import { useStore } from "../store";
import { COLOR_CHOICES } from "../types";
import { IconChevronDown, IconChevronUp, IconX } from "./Icons";

export function TagManager() {
  const {
    tags,
    projects,
    tasks,
    setTagManagerOpen,
    updateTagMeta,
    removeTag,
    mergeTags,
    editProject,
    moveProject,
  } = useStore();
  const [renamingTag, setRenamingTag] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mergingTag, setMergingTag] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [renamingProject, setRenamingProject] = useState<number | null>(null);

  const counts = useMemo(() => {
    const live = liveTasks(tasks);
    const byTag = new Map<number, number>();
    const byProject = new Map<number, number>();
    for (const t of live) {
      for (const id of t.tag_ids) byTag.set(id, (byTag.get(id) ?? 0) + 1);
      if (t.project_id !== null) {
        byProject.set(t.project_id, (byProject.get(t.project_id) ?? 0) + 1);
      }
    }
    return { byTag, byProject };
  }, [tasks]);

  function commitTagRename(id: number) {
    const tag = tags.find((t) => t.id === id);
    const name = renameValue.trim();
    setRenamingTag(null);
    if (tag && name && name !== tag.name) {
      void updateTagMeta(id, name, tag.color);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => setTagManagerOpen(false)}>
      <div className="modal manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Tags & projects</h2>
          <button
            className="icon-btn"
            aria-label="Close manager"
            onClick={() => setTagManagerOpen(false)}
          >
            <IconX size={14} />
          </button>
        </div>

        <section className="settings-section">
          <h3 className="settings-heading">
            Tags <span className="group-count">{tags.length}</span>
          </h3>
          {tags.length === 0 && (
            <p className="settings-sub">No tags yet — add them from a task or with @tag in quick add.</p>
          )}
          <div className="manager-list">
            {tags.map((tag) => (
              <div key={tag.id} className="manager-row">
                {renamingTag === tag.id ? (
                  <input
                    autoFocus
                    className="manager-rename"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitTagRename(tag.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitTagRename(tag.id);
                      if (e.key === "Escape") setRenamingTag(null);
                    }}
                  />
                ) : (
                  <button
                    className="tag-chip manager-name"
                    style={{ ["--tag-color" as string]: tag.color }}
                    title="Click to rename"
                    onClick={() => {
                      setRenamingTag(tag.id);
                      setRenameValue(tag.name);
                    }}
                  >
                    {tag.name}
                  </button>
                )}
                <span className="manager-count">{counts.byTag.get(tag.id) ?? 0} tasks</span>

                <span className="manager-colors">
                  {COLOR_CHOICES.map((color) => (
                    <button
                      key={color}
                      className={`color-swatch mini ${tag.color === color ? "selected" : ""}`}
                      style={{ background: color }}
                      aria-label={`Set color ${color}`}
                      onClick={() => void updateTagMeta(tag.id, tag.name, color)}
                    />
                  ))}
                </span>

                {mergingTag === tag.id ? (
                  <select
                    autoFocus
                    className="manager-merge-select"
                    aria-label={`Merge ${tag.name} into`}
                    defaultValue=""
                    onBlur={() => setMergingTag(null)}
                    onChange={(e) => {
                      const target = Number(e.target.value);
                      setMergingTag(null);
                      if (target) void mergeTags(tag.id, target);
                    }}
                  >
                    <option value="" disabled>
                      merge into…
                    </option>
                    {tags
                      .filter((t) => t.id !== tag.id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <button
                    className="btn small"
                    disabled={tags.length < 2}
                    onClick={() => setMergingTag(tag.id)}
                  >
                    Merge
                  </button>
                )}

                <button
                  className={`btn small ${confirmDelete === tag.id ? "danger" : "ghost-danger"}`}
                  onBlur={() => setConfirmDelete(null)}
                  onClick={() => {
                    if (confirmDelete === tag.id) {
                      void removeTag(tag.id);
                      setConfirmDelete(null);
                    } else {
                      setConfirmDelete(tag.id);
                    }
                  }}
                >
                  {confirmDelete === tag.id ? "Sure?" : "Delete"}
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">
            Projects <span className="group-count">{projects.length}</span>
          </h3>
          <div className="manager-list">
            {projects.map((project, i) => (
              <div key={project.id} className="manager-row">
                {renamingProject === project.id ? (
                  <ProjectRename
                    initial={project.name}
                    onDone={(name) => {
                      setRenamingProject(null);
                      if (name && name !== project.name) {
                        void editProject(project.id, name, project.color, project.folder_path);
                      }
                    }}
                  />
                ) : (
                  <button
                    className="manager-name manager-project"
                    title="Click to rename"
                    onClick={() => setRenamingProject(project.id)}
                  >
                    <span className="project-dot" style={{ background: project.color }} />
                    {project.name}
                  </button>
                )}
                <span className="manager-count">
                  {counts.byProject.get(project.id) ?? 0} tasks
                </span>
                <span className="manager-colors">
                  {COLOR_CHOICES.map((color) => (
                    <button
                      key={color}
                      className={`color-swatch mini ${project.color === color ? "selected" : ""}`}
                      style={{ background: color }}
                      aria-label={`Set color ${color}`}
                      onClick={() => void editProject(project.id, project.name, color, project.folder_path)}
                    />
                  ))}
                </span>
                <button
                  className="icon-btn"
                  aria-label={`Move ${project.name} up`}
                  disabled={i === 0}
                  onClick={() => void moveProject(project.id, -1)}
                >
                  <IconChevronUp size={13} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Move ${project.name} down`}
                  disabled={i === projects.length - 1}
                  onClick={() => void moveProject(project.id, 1)}
                >
                  <IconChevronDown size={13} />
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <p className="settings-sub">No projects yet — create one from the sidebar.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function ProjectRename({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      className="manager-rename"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value.trim());
        if (e.key === "Escape") onDone(initial);
      }}
    />
  );
}
