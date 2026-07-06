import { addDays, format, parseISO, subDays } from "date-fns";
import { useMemo } from "react";
import { liveTasks } from "../selectors";
import { useSettings } from "../settings";
import { useStore } from "../store";
import { dueLabel, isOverdue, toDateStr, todayStr, weekDates } from "../utils/dates";

/** completed_at is an ISO timestamp (or SQLite datetime); compare on the date part. */
function completedDate(completedAt: string): string {
  return completedAt.slice(0, 10);
}

export function ReviewView() {
  const { tasks, projects, openEditor, select } = useStore();
  const weekStart = useSettings((s) => s.weekStart);

  const stats = useMemo(() => {
    const live = liveTasks(tasks);
    const today = todayStr();
    const thisWeek = weekDates(new Date(), weekStart);
    const lastWeek = weekDates(subDays(new Date(), 7), weekStart);

    const open = live.filter((t) => t.status !== "done");
    const completed = live.filter((t) => t.status === "done" && t.completed_at !== null);

    const inRange = (dates: string[]) =>
      completed.filter((t) => {
        const d = completedDate(t.completed_at!);
        return d >= dates[0] && d <= dates[6] && d <= today;
      }).length;

    const doneThisWeek = inRange(thisWeek);
    const doneLastWeek = inRange(lastWeek);

    const overdue = open
      .filter(isOverdue)
      .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));

    // Completions per day, last 7 days ending today.
    const last7 = Array.from({ length: 7 }, (_, i) => toDateStr(addDays(new Date(), i - 6)));
    const perDay = last7.map((date) => ({
      date,
      count: completed.filter((t) => completedDate(t.completed_at!) === date).length,
    }));

    // Streak: consecutive days with at least one completion, ending today or yesterday.
    const daysWithDone = new Set(completed.map((t) => completedDate(t.completed_at!)));
    let streak = 0;
    let cursor = daysWithDone.has(today) ? new Date() : subDays(new Date(), 1);
    while (daysWithDone.has(toDateStr(cursor))) {
      streak += 1;
      cursor = subDays(cursor, 1);
    }

    const perProject = projects.map((project) => {
      const list = live.filter((t) => t.project_id === project.id);
      const done = list.filter((t) => t.status === "done").length;
      return {
        project,
        total: list.length,
        done,
        pct: list.length > 0 ? Math.round((done / list.length) * 100) : 0,
      };
    });

    return { open: open.length, doneThisWeek, doneLastWeek, overdue, perDay, streak, perProject };
  }, [tasks, projects, weekStart]);

  const delta = stats.doneThisWeek - stats.doneLastWeek;
  const maxPerDay = Math.max(1, ...stats.perDay.map((d) => d.count));

  return (
    <div className="review">
      <div className="review-stats">
        <div className="stat-card">
          <span className="stat-value">{stats.open}</span>
          <span className="stat-label">open tasks</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.doneThisWeek}</span>
          <span className="stat-label">
            done this week
            {delta !== 0 && (
              <span className={`stat-delta ${delta > 0 ? "up" : "down"}`}>
                {" "}
                · {delta > 0 ? "+" : ""}
                {delta} vs last
              </span>
            )}
          </span>
        </div>
        <div className="stat-card">
          <span className={`stat-value ${stats.overdue.length > 0 ? "danger" : ""}`}>
            {stats.overdue.length}
          </span>
          <span className="stat-label">overdue</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.streak > 0 ? `${stats.streak}🔥` : "—"}</span>
          <span className="stat-label">day streak</span>
        </div>
      </div>

      <section className="review-section">
        <h2 className="group-label">Completed per day</h2>
        <div className="review-chart">
          {stats.perDay.map((day) => (
            <div key={day.date} className="chart-col" title={`${day.count} on ${dueLabel(day.date)}`}>
              <div className="chart-bar-track">
                <div
                  className="chart-bar"
                  style={{ height: `${(day.count / maxPerDay) * 100}%` }}
                />
              </div>
              <span className="chart-day">{format(parseISO(day.date), "EEEEE")}</span>
              <span className="chart-count">{day.count > 0 ? day.count : ""}</span>
            </div>
          ))}
        </div>
      </section>

      {stats.perProject.length > 0 && (
        <section className="review-section">
          <h2 className="group-label">Projects</h2>
          <div className="review-projects">
            {stats.perProject.map(({ project, total, done, pct }) => (
              <button
                key={project.id}
                className="review-project"
                onClick={() => select({ type: "project", projectId: project.id })}
              >
                <span className="project-dot" style={{ background: project.color }} />
                <span className="review-project-name">{project.name}</span>
                <span className="review-project-counts">
                  {done}/{total}
                </span>
                <span className="review-progress-track">
                  <span
                    className="review-progress-fill"
                    style={{ width: `${pct}%`, background: project.color }}
                  />
                </span>
                <span className="review-project-pct">{pct}%</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="review-section">
        <h2 className="group-label danger">Needs attention</h2>
        {stats.overdue.length === 0 ? (
          <p className="review-clear">Nothing overdue — nice.</p>
        ) : (
          <div className="review-overdue">
            {stats.overdue.map((task) => (
              <button key={task.id} className="review-overdue-row" onClick={() => openEditor(task.id)}>
                <span className="review-overdue-title">{task.title}</span>
                <span className="review-overdue-when">due {dueLabel(task.due_date!)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
