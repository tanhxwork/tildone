import { useState } from "react";
import { useStore } from "../store";
import type { Goal } from "../types";
import { COLOR_CHOICES } from "../types";
import { IconX } from "./Icons";

/**
 * Create or edit a goal — the same modal pattern as ProjectDialog. `goal: null`
 * is create mode (needs `projectId`, since a goal always lives inside one
 * project — invariant 1, docs/specs/2026-08-20-goals-inside-projects.md);
 * otherwise it edits `goal` in place. Close/reopen and delete live here too,
 * since editing is the only affordance the goal band offers (spec: "matching
 * how projects are edited today").
 */
export function GoalDialog({
  goal,
  projectId,
  onClose,
}: {
  goal: Goal | null;
  projectId: number;
  onClose: () => void;
}) {
  const { addGoal, editGoal, setGoalCompleted, removeGoal, projects } = useStore();
  const project = projects.find((p) => p.id === projectId);
  const [name, setName] = useState(goal?.name ?? "");
  const [notes, setNotes] = useState(goal?.notes ?? "");
  const [color, setColor] = useState(goal?.color ?? COLOR_CHOICES[0]);
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Surfaces whatever the store rejects with — e.g. addGoal/editGoal enforcing
  // the same "unique per project" rule the MCP surface addresses goals by name
  // with. Left up rather than closing, so the name is still there to fix.
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      if (goal) {
        await editGoal(goal.id, { name: trimmed, notes, color, target_date: targetDate || null });
      } else {
        await addGoal({ project_id: projectId, name: trimmed, notes, color, target_date: targetDate || null });
      }
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={goal ? "Edit goal" : "New goal"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{goal ? "Edit Goal" : "New Goal"}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>

        {project && <p className="field-hint">In {project.name}</p>}

        <label className="field">
          <span className="field-label">Name</span>
          <input
            autoFocus
            value={name}
            placeholder="Goal name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>

        <label className="field">
          <span className="field-label">Outcome</span>
          <textarea
            value={notes}
            placeholder="What's true once this goal is done?"
            rows={2}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field-label">Target date</span>
          <div className="date-row">
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            {targetDate && (
              <button
                className="icon-btn"
                aria-label="Clear target date"
                onClick={() => setTargetDate("")}
              >
                <IconX size={12} />
              </button>
            )}
          </div>
        </div>

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

        {error && <p className="field-error">{error}</p>}

        <div className="modal-footer">
          {goal && (
            <>
              {confirmDelete ? (
                <button
                  className="btn danger"
                  onClick={async () => {
                    await removeGoal(goal.id);
                    onClose();
                  }}
                >
                  Tasks stay — delete this goal?
                </button>
              ) : (
                <button className="btn ghost-danger" onClick={() => setConfirmDelete(true)}>
                  Delete goal
                </button>
              )}
              <button
                className="btn"
                onClick={async () => {
                  await setGoalCompleted(goal.id, goal.completed_at === null);
                  onClose();
                }}
              >
                {goal.completed_at === null ? "Close goal" : "Reopen goal"}
              </button>
            </>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            {goal ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
