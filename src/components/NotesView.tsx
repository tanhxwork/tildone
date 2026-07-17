import { useEffect, useMemo, useRef, useState } from "react";
import { parseNoteSections, shouldAutoCollapse } from "../utils/markdownSections";
import { IconChevronDown, IconList } from "./Icons";
import { Markdown } from "./Markdown";

// Per-task expand/collapse memory for the lifetime of the app run — by
// design not persisted (spec 2026-07-17): a restart resets to the default,
// and stale persisted state can never hide a section an agent just wrote.
const sectionMemory = new Map<number, Record<string, boolean>>();

// Keep the scroll-spy line and jump landings clear of the sticky nav bar.
const SPY_OFFSET = 44;

export function NotesView({
  taskId,
  source,
  onStartEdit,
}: {
  taskId: number;
  source: string;
  onStartEdit: () => void;
}) {
  const sections = useMemo(() => parseNoteSections(source), [source]);
  const topSections = useMemo(() => sections.filter((s) => s.topLevel), [sections]);
  const sectioned = sections.length >= 2;
  const autoCollapsed = sectioned && shouldAutoCollapse(source, sections);

  const [overrides, setOverrides] = useState<Record<string, boolean>>(
    () => sectionMemory.get(taskId) ?? {},
  );
  useEffect(() => {
    setOverrides(sectionMemory.get(taskId) ?? {});
  }, [taskId]);

  const isExpanded = (key: string) => overrides[key] ?? !autoCollapsed;
  const setMany = (entries: Record<string, boolean>) => {
    setOverrides((prev) => {
      const next = { ...prev, ...entries };
      sectionMemory.set(taskId, next);
      return next;
    });
  };
  const sectionUi = useMemo(
    () => ({ isExpanded, toggle: (key: string) => setMany({ [key]: !isExpanded(key) }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overrides, autoCollapsed, taskId],
  );

  // Scroll-spy: the nav label names the top-level section whose header last
  // crossed the top of the scrollport (.detail-body scrolls the editor).
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  useEffect(() => {
    if (!sectioned) return;
    const wrap = wrapRef.current;
    const scroller = wrap?.closest(".detail-body");
    if (!wrap || !scroller) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = scroller.getBoundingClientRect().top + SPY_OFFSET;
      let current: string | null = null;
      for (const el of wrap.querySelectorAll<HTMLElement>(".md-section-header")) {
        if (el.getBoundingClientRect().top <= top) {
          current = el.closest("section")?.getAttribute("data-section-key") ?? current;
        }
      }
      setCurrentKey(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sectioned, source, overrides]);

  // Jumping must expand first and scroll only after React has committed the
  // expanded DOM — hence the pending state resolved in an effect, not a rAF.
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingScroll) return;
    wrapRef.current
      ?.querySelector(`[data-note-heading="${CSS.escape(pendingScroll)}"]`)
      ?.scrollIntoView({ block: "start" });
    setPendingScroll(null);
  }, [pendingScroll]);

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const jumpTo = (key: string) => {
    const at = sections.findIndex((s) => s.key === key);
    for (let i = at; i >= 0; i--) {
      if (sections[i].topLevel) {
        setMany({ [sections[i].key]: true });
        break;
      }
    }
    setPendingScroll(key);
    setMenuOpen(false);
  };

  // The dropdown lists top-level sections plus the next depth actually
  // present, indented — deep enough to reach a phase, shallow enough to scan.
  const subDepth = Math.min(
    ...sections.filter((s) => !s.topLevel).map((s) => s.depth),
    Infinity,
  );
  const menuSections = sections.filter((s) => s.topLevel || s.depth === subDepth);
  const currentTitle =
    sections.find((s) => s.key === currentKey)?.title ?? "Sections";

  return (
    <div className="detail-notes-stack" ref={wrapRef}>
      {sectioned && (
        <div className="notes-nav" ref={barRef}>
          <button
            type="button"
            className="notes-nav-current"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Jump to a section"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconList size={12} className="notes-nav-icon" />
            <span className="notes-nav-label">{currentTitle}</span>
            <IconChevronDown size={11} className="notes-nav-caret" />
          </button>
          {menuOpen && (
            <div className="notes-nav-menu" role="menu">
              {menuSections.map((s) => (
                <button
                  type="button"
                  key={s.key}
                  role="menuitem"
                  className={`notes-nav-item${s.topLevel ? "" : " sub"}${
                    s.key === currentKey ? " active" : ""
                  }`}
                  onClick={() => jumpTo(s.key)}
                >
                  {s.title}
                </button>
              ))}
              <div className="notes-nav-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="notes-nav-item action"
                onClick={() => {
                  setMany(Object.fromEntries(topSections.map((s) => [s.key, true])));
                  setMenuOpen(false);
                }}
              >
                Expand all
              </button>
              <button
                type="button"
                role="menuitem"
                className="notes-nav-item action"
                onClick={() => {
                  setMany(Object.fromEntries(topSections.map((s) => [s.key, false])));
                  setMenuOpen(false);
                }}
              >
                Collapse all
              </button>
            </div>
          )}
        </div>
      )}
      <div
        className="detail-notes detail-notes-rendered"
        tabIndex={0}
        aria-label="Task notes, click to edit"
        onClick={onStartEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStartEdit();
          }
        }}
      >
        <Markdown sections={sectioned ? sectionUi : undefined}>{source}</Markdown>
      </div>
    </div>
  );
}
