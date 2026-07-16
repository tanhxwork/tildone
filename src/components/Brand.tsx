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

/** Strokes in `currentColor`, so it follows the accent across light and dark. */
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
      <path d={MARK_PATH} />
    </svg>
  );
}
