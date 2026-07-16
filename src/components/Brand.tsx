import type { SVGProps } from "react";

/** The Tildone mark: a tilde that settles into a check.
 *  assets/tildone-mark.svg carries the same geometry for non-app use (docs, decks);
 *  keep the two in step if the path ever changes. */
const MARK_PATH = "M16,60 C24,45 35,45 45,57 C51,64 57,65 64,58 C71,52 76,58 80,73 L108,33";

/** The mark's own artboard is 120x120, but the stroked path only spans
 *  x 10.5..113.5 and y 27.5..78.5 (its bbox widened by half the 11px stroke).
 *  Cropping to that keeps the mark optically aligned with adjacent text rather
 *  than floating inside a third of a viewBox of empty padding. */
const MARK_VIEWBOX = "10.5 27.5 103 51";
const MARK_ASPECT = 51 / 103;

type MarkProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { width?: number };

/** Strokes in `currentColor`, so it follows the accent across light and dark.
 *  `pathLength={1}` normalises the stroke length to 1 unit, so a `stroke-dasharray:1`
 *  draw-in animation (see .sidebar-brand-mark in App.css) works regardless of the
 *  path's real length. */
export function TildoneMark({ width = 20, ...rest }: MarkProps) {
  return (
    <svg
      width={width}
      height={Math.round(width * MARK_ASPECT)}
      viewBox={MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={11}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={MARK_PATH} pathLength={1} />
    </svg>
  );
}

/** A one-shot wave-to-check flourish, overlaid on a card as it lands in Done.
 *  The mark self-draws in the success colour, then fades. Purely decorative, so
 *  it's aria-hidden and drops to a plain fade under prefers-reduced-motion
 *  (styles + keyframes: .completion-flourish in App.css). `onDone` fires when
 *  the fade ends, so the caller can unmount it. */
export function CompletionFlourish({ onDone }: { onDone?: () => void }) {
  return (
    <span className="completion-flourish" aria-hidden="true">
      <svg
        viewBox={MARK_VIEWBOX}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className="completion-flourish-path"
          d={MARK_PATH}
          pathLength={1}
          onAnimationEnd={(e) => {
            if (e.animationName.startsWith("flourish-fade")) onDone?.();
          }}
        />
      </svg>
    </span>
  );
}
