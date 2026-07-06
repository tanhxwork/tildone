import { useState } from "react";
import { aiReady, useAI } from "../ai";
import { useStore } from "../store";
import { todayStr } from "../utils/dates";
import { PLAN_SYSTEM, buildPlanPrompt, parsePlan, planTasks } from "../utils/dailyPlan";
import { IconChevronDown, IconSparkles, IconX } from "./Icons";

const CACHE_KEY = "tildone-daily-plan";

interface PlanCache {
  date: string;
  text: string;
  dismissed: boolean;
}

function readCache(): PlanCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // treat as no cache
  }
  return null;
}

export function DailyPlan() {
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const aiConfig = useAI((s) => s.config);
  const chat = useAI((s) => s.chat);

  const [cache, setCache] = useState<PlanCache | null>(readCache);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(true);

  const input = planTasks(tasks);
  if (!aiReady(aiConfig) || input.overdue.length + input.todays.length === 0) {
    return null;
  }

  const plan = cache && cache.date === todayStr() && !cache.dismissed ? cache : null;

  function save(next: PlanCache) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
    setCache(next);
  }

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const text = await chat(PLAN_SYSTEM, buildPlanPrompt(input, projects));
      save({ date: todayStr(), text, dismissed: false });
      setCollapsed(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!plan) {
    return (
      <div className="daily-plan-cta">
        <button className="btn ai-action" disabled={busy} onClick={() => void generate()}>
          <IconSparkles size={13} />
          {busy ? "Thinking…" : "Plan my day"}
        </button>
        {error && <p className="ai-error">{error}</p>}
      </div>
    );
  }

  const { digest, focus } = parsePlan(plan.text);

  return (
    <section className="daily-plan">
      <header className="daily-plan-header">
        <IconSparkles size={13} />
        <span className="daily-plan-title">Today's plan</span>
        <div className="spacer" />
        <button className="btn small" disabled={busy} onClick={() => void generate()}>
          {busy ? "Thinking…" : "Regenerate"}
        </button>
        <button
          className={`icon-btn chevron ${collapsed ? "" : "open"}`}
          aria-label={collapsed ? "Expand plan" : "Collapse plan"}
          onClick={() => setCollapsed((c) => !c)}
        >
          <IconChevronDown size={14} />
        </button>
        <button
          className="icon-btn"
          aria-label="Dismiss plan"
          onClick={() => save({ ...plan, dismissed: true })}
        >
          <IconX size={13} />
        </button>
      </header>
      {!collapsed && (
        <div className="daily-plan-body">
          {digest && <p className="daily-plan-digest">{digest}</p>}
          {focus.length > 0 && (
            <ol className="daily-plan-focus">
              {focus.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          )}
          {error && <p className="ai-error">{error}</p>}
        </div>
      )}
    </section>
  );
}
