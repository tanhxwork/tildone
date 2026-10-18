import { useEffect, useMemo, useRef, useState } from "react";
import { townModel, type TownCharacter, type TownRoom } from "../selectors";
import { paneHasFocus } from "../paneStore";
import { useStore } from "../store";
import { TownRenderer, type TownHover, type TownTarget } from "./renderer";

// The Town page: every project as a floating island bridged to a town square,
// agents placed by presence state. The canvas belongs to TownRenderer; this page
// owns the chrome (toolbar, focus bar, card, legend) and the state the renderer
// is told about: which buildings are open, whether bots show, which island is
// focused, and the day/night palette.
//
// The canvas is not reachable from the keyboard or a screen reader, so a visually
// hidden region mirrors it: one button per agent (focus shows its card, the same
// card the pointer gets) and one per building (toggles it open). The e2e spec
// drives the page through that region.

const STATE_LABEL: Record<TownCharacter["state"], string> = {
  working: "Working",
  blocked: "Blocked",
  quiet: "Quiet",
};

/** Card width plus a margin; keeps the card inside the stage's right edge. */
const CARD_ROOM = 296;

/** The resolved app theme (settings.ts applyTheme writes it), followed live. */
function useDarkTheme(): boolean {
  const read = () => document.documentElement.dataset.theme === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function agentLabel(c: TownCharacter): string {
  return c.agentName ?? "Agent";
}

export function TownPage() {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const live = useStore((s) => s.live);
  const presence = useStore((s) => s.presence);
  const goals = useStore((s) => s.goals);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  // Opened from a goal, the town shows that goal alone; a goal deleted under us
  // falls back to the whole town.
  const goalId = selection.type === "town" ? selection.goalId : undefined;
  const goal = goals.find((g) => g.id === goalId);
  const model = useMemo(
    () => townModel(projects, tasks, live, presence, goal),
    [projects, tasks, live, presence, goal],
  );
  const dark = useDarkTheme();

  const islands = model.rooms.filter(
    (r): r is TownRoom & { projectId: number } => r.projectId !== null,
  );
  const agents = model.rooms.flatMap((room) => room.characters.map((c) => ({ c, room })));

  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [bots, setBots] = useState(true);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [hover, setHover] = useState<TownHover | null>(null);
  const [keyboardAgent, setKeyboardAgent] = useState<number | null>(null);

  // A focused or opened project can be deleted under us; only live ids count.
  const focused = islands.some((r) => r.projectId === focusId) ? focusId : null;
  const openCount = islands.filter((r) => open.has(r.projectId)).length;
  const allOpen = islands.length > 0 && openCount === islands.length;
  const noneOpen = openCount === 0;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TownRenderer | null>(null);
  // The renderer is built once; its click callback reads the latest handler.
  const clickRef = useRef<(target: TownTarget) => void>(() => {});
  clickRef.current = (target) => {
    if (target.kind === "building") toggleBuilding(target.projectId);
    else if (target.kind === "label")
      setFocusId((id) => (id === target.projectId ? null : target.projectId));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new TownRenderer(canvas, {
      onHover: setHover,
      onClick: (target) => clickRef.current(target),
    });
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => rendererRef.current?.setModel(model), [model]);
  useEffect(() => rendererRef.current?.setDark(dark), [dark]);
  useEffect(() => rendererRef.current?.setOpen(open), [open]);
  useEffect(() => rendererRef.current?.setBots(bots), [bots]);
  useEffect(() => rendererRef.current?.focus(focused), [focused]);

  // Esc zooms back out, unless the key belongs to something else: the session
  // terminal, a text field (header search, palette input), or a dialog or the
  // palette. Judged from the event target, not store flags: App's own Esc
  // handler may already have closed the palette by the time this one runs.
  useEffect(() => {
    if (focused === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || paneHasFocus()) return;
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
            '[role="dialog"], [aria-modal="true"], .modal-overlay, .session-pane',
        )
      )
        return;
      setFocusId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused]);

  function toggleBuilding(projectId: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  // Beside an anchor, kept inside the stage's right edge.
  const cardAt = (anchor: { x: number; y: number }) => {
    const width = stageRef.current?.clientWidth ?? 0;
    return { x: Math.max(8, Math.min(anchor.x + 14, width - CARD_ROOM)), y: anchor.y + 14 };
  };

  // The card: the pointer's agent wins over the keyboard's.
  const cardTaskId =
    hover?.target.kind === "agent" ? hover.target.taskId : keyboardAgent;
  const cardAgent = agents.find((a) => a.c.taskId === cardTaskId) ?? null;
  let card: { x: number; y: number } | null = null;
  if (cardAgent) {
    const anchor =
      hover?.target.kind === "agent"
        ? hover
        : (rendererRef.current?.agentAnchor(cardAgent.c.taskId) ?? null);
    // No anchor (the agent is off-scene, or the renderer has none yet): the
    // stage's top-left corner.
    card = anchor ? cardAt(anchor) : { x: 12, y: 12 };
  }

  // Buildings and name chips get a one-line hint instead of the agent card.
  const hoverRoom =
    hover && hover.target.kind !== "agent"
      ? (islands.find((r) => r.projectId === (hover.target as { projectId: number }).projectId) ??
        null)
      : null;

  return (
    <div className="town-page">
      <div className="town-toolbar">
        {goal && (
          <button className="btn" onClick={() => select({ type: "town" })}>
            Whole town
          </button>
        )}
        <div className="segmented" role="group" aria-label="Buildings">
          <button
            className={noneOpen ? "active" : ""}
            aria-pressed={noneOpen}
            onClick={() => setOpen(new Set())}
          >
            Outside
          </button>
          <button
            className={allOpen ? "active" : ""}
            aria-pressed={allOpen}
            onClick={() => setOpen(new Set(islands.map((r) => r.projectId)))}
          >
            Inside
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Helper bots">
          <button className={bots ? "active" : ""} aria-pressed={bots} onClick={() => setBots(true)}>
            Helper bots
          </button>
          <button className={!bots ? "active" : ""} aria-pressed={!bots} onClick={() => setBots(false)}>
            Agents only
          </button>
        </div>
        <span className="town-toolbar-hint">
          Click a building to look inside. Click a name to zoom; Esc zooms out.
        </span>
      </div>

      <div className="town-focusbar" role="group" aria-label="Focus">
        <button
          className={focused === null ? "active" : ""}
          aria-pressed={focused === null}
          onClick={() => setFocusId(null)}
        >
          All projects
        </button>
        {islands.map((r) => (
          <button
            key={r.projectId}
            className={focused === r.projectId ? "active" : ""}
            aria-pressed={focused === r.projectId}
            onClick={() => setFocusId(r.projectId)}
          >
            <i className="town-dot" style={{ background: r.color ?? undefined }} aria-hidden="true" />
            {r.name}
          </button>
        ))}
      </div>

      <div
        ref={stageRef}
        className={`town-stage${hover ? " pointing" : ""}`}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} className="town-canvas" aria-hidden="true" />

        {islands.length === 0 && (
          <p className="town-empty">Create a project to build its island</p>
        )}

        {cardAgent && card && (
          <div
            className="town-card"
            data-testid="town-card"
            role="status"
            style={{ left: card.x, top: card.y }}
          >
            <div className="town-card-name">{agentLabel(cardAgent.c)}</div>
            <div className="town-card-meta">
              {cardAgent.room.name}
              {cardAgent.c.ref ? ` · ${cardAgent.c.ref}` : ""}
            </div>
            <div className="town-card-title">{cardAgent.c.title}</div>
            <div className={`town-card-state ${cardAgent.c.state}`}>
              {STATE_LABEL[cardAgent.c.state]}
            </div>
            {cardAgent.c.lastLog && <div className="town-card-meta">{cardAgent.c.lastLog}</div>}
          </div>
        )}

        {!cardAgent && hover && hoverRoom && (
          <div className="town-card" style={{ left: cardAt(hover).x, top: cardAt(hover).y }}>
            <div className="town-card-name">{hoverRoom.name}</div>
            <div className="town-card-meta">
              {hover.target.kind === "label"
                ? focused === hoverRoom.projectId
                  ? "Click to see all projects"
                  : "Click to zoom to this project"
                : `${hoverRoom.openTaskCount} open tasks · click to look ${
                    open.has(hoverRoom.projectId) ? "outside" : "inside"
                  }`}
            </div>
          </div>
        )}

        <div className="visually-hidden" role="group" aria-label="Town">
          {agents.map(({ c, room }) => (
            <button
              key={c.taskId}
              data-testid={`town-agent-${c.taskId}`}
              aria-label={`${agentLabel(c)}, ${room.name}${c.ref ? ` ${c.ref}` : ""}: ${c.title}, ${STATE_LABEL[c.state].toLowerCase()}`}
              onFocus={() => setKeyboardAgent(c.taskId)}
              onBlur={() => setKeyboardAgent((id) => (id === c.taskId ? null : id))}
              onClick={() => setFocusId(room.projectId)}
            />
          ))}
          {islands.map((r) => (
            <button
              key={r.projectId}
              aria-label={`${r.name} building`}
              aria-pressed={open.has(r.projectId)}
              onClick={() => toggleBuilding(r.projectId)}
            />
          ))}
        </div>
      </div>

      <div className="town-legend" aria-hidden="true">
        <span>
          <i className="town-dot working" />
          Working at a desk
        </span>
        <span>
          <i className="town-dot blocked" />
          Blocked at the front door
        </span>
        <span>
          <i className="town-dot quiet" />
          Quiet in the lounge
        </span>
        {bots && <span>Bots and drones are decoration, never agents</span>}
      </div>
    </div>
  );
}
