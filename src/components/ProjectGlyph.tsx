import { useStore } from "../store";
import type { Project } from "../types";

/**
 * A project's identity mark: its discovered icon if one was found on disk,
 * otherwise the colour dot. Rendered in a fixed-size slot so a project's row
 * lines up whether it shows a logo or a dot — the dot centres inside the slot,
 * the icon fills it.
 *
 * Discovery lives in the store (`projectIcons`, filled by the Rust
 * `discover_project_icon` command); this component only picks which to draw.
 */
export function ProjectGlyph({
  project,
  size = 16,
  large = false,
}: {
  project: Project;
  /** Slot edge in px — the icon fills it; the fallback dot keeps its own size. */
  size?: number;
  /** Use the larger dot (11px) when falling back, for the header title. */
  large?: boolean;
}) {
  const icon = useStore((s) => s.projectIcons[project.id]);
  return (
    <span className="project-glyph" style={{ width: size, height: size }}>
      {icon?.dataUri ? (
        <img src={icon.dataUri} alt="" aria-hidden="true" />
      ) : (
        <span
          className={`project-dot${large ? " large" : ""}`}
          style={{ background: project.color }}
        />
      )}
    </span>
  );
}
