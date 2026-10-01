import { useState } from "react";
import { addDays, format } from "date-fns";
import { useStore } from "../store";
import type { ObserveOption } from "../types";
import { IconX } from "./Icons";

// "New observation": the question, where it lives, how a session checks it, when
// it falls due (a date, or a count of log lines) and the 2-3 decisions on offer.
// Saving creates the card Waiting; sessions fill its log over MCP.
export function ObserveDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { projects, addObservation } = useStore();
  const [question, setQuestion] = useState("");
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.id ?? null);
  const [why, setWhy] = useState("");
  const [check, setCheck] = useState("");
  const [triggerKind, setTriggerKind] = useState<"count" | "date">("count");
  const [count, setCount] = useState("5");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(format(addDays(new Date(), 7), "yyyy-MM-dd"));
  const [options, setOptions] = useState<ObserveOption[]>([
    { label: "", detail: "" },
    { label: "", detail: "" },
  ]);
  const [error, setError] = useState<string | null>(null);

  const countValue = Number(count);
  const triggerValid =
    triggerKind === "date" ? date !== "" : Number.isInteger(countValue) && countValue > 0;
  const valid =
    question.trim() !== "" &&
    check.trim() !== "" &&
    triggerValid &&
    options.every((o) => o.label.trim() !== "");

  const setOption = (i: number, patch: Partial<ObserveOption>) =>
    setOptions((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  async function save() {
    if (!valid) return;
    try {
      const id = await addObservation({
        project_id: projectId,
        question: question.trim(),
        why: why.trim(),
        check_text: check.trim(),
        trigger_date: triggerKind === "date" ? date : null,
        trigger_count: triggerKind === "count" ? countValue : null,
        trigger_unit: triggerKind === "count" ? unit.trim() || "checks" : null,
        options: options.map((o) => ({ label: o.label.trim(), detail: o.detail.trim() })),
      });
      onCreated(id);
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal observe-dialog"
        role="dialog"
        aria-label="New observation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>New Observation</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>

        <label className="field">
          <span className="field-label">Question</span>
          <input
            autoFocus
            name="question"
            value={question}
            placeholder="Do builders probe mid-build?"
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Project</span>
          <select
            name="project"
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value === "" ? null : Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="">Inbox</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Why (optional)</span>
          <textarea name="why" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
        </label>

        <label className="field">
          <span className="field-label">How to check, each session</span>
          <textarea
            name="check"
            className="observe-check-input"
            rows={2}
            value={check}
            onChange={(e) => setCheck(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field-label">Due when</span>
          <div className="observe-trigger-row">
            <div className="observe-seg" role="group" aria-label="Trigger kind">
              <button
                type="button"
                className={triggerKind === "count" ? "active" : ""}
                aria-pressed={triggerKind === "count"}
                onClick={() => setTriggerKind("count")}
              >
                Count
              </button>
              <button
                type="button"
                className={triggerKind === "date" ? "active" : ""}
                aria-pressed={triggerKind === "date"}
                onClick={() => setTriggerKind("date")}
              >
                Date
              </button>
            </div>
            {triggerKind === "count" ? (
              <>
                <input
                  name="trigger_count"
                  className="observe-count-input"
                  type="number"
                  min={1}
                  value={count}
                  aria-label="Log lines"
                  onChange={(e) => setCount(e.target.value)}
                />
                <input
                  name="trigger_unit"
                  value={unit}
                  placeholder="deliveries"
                  aria-label="Unit"
                  onChange={(e) => setUnit(e.target.value)}
                />
              </>
            ) : (
              <input
                name="trigger_date"
                type="date"
                value={date}
                aria-label="Due date"
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Decision options</span>
          {options.map((option, i) => (
            <div key={i} className="observe-option-row">
              <input
                name={`option_label_${i}`}
                value={option.label}
                placeholder={["Keep", "Change", "Revert"][i]}
                aria-label={`Option ${i + 1} label`}
                onChange={(e) => setOption(i, { label: e.target.value })}
              />
              <input
                name={`option_detail_${i}`}
                value={option.detail}
                placeholder="What it means"
                aria-label={`Option ${i + 1} detail`}
                onChange={(e) => setOption(i, { detail: e.target.value })}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                >
                  <IconX size={12} />
                </button>
              )}
            </div>
          ))}
          {options.length < 3 && (
            <button
              type="button"
              className="btn small observe-add-option"
              onClick={() => setOptions((list) => [...list, { label: "", detail: "" }])}
            >
              Add option
            </button>
          )}
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-footer">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
