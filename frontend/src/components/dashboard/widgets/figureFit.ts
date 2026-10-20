import type { CSSProperties } from "react";

/**
 * The two counts the stylesheet sizes a stat or gauge figure from (`--fig-chars` and `--fig-unit`, see `.stat .big` in styles/widgets.css): how many characters the
 * figure has (its marks and scale letter included) and how many its unit has. Text length is a count, not a measurement: the width it is set against is the card's,
 * read by the stylesheet in container units, so no script measures a width (front end pack 10). A figure has at least one character.
 */
export function figureFit(figure: string, unit: string): CSSProperties {
  return { "--fig-chars": Math.max(1, Array.from(figure).length), "--fig-unit": Array.from(unit.trim()).length } as CSSProperties;
}
