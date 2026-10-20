import type { TemplateWidget, WidgetType } from "../../api/types";

/*
 * The picture on a template card (w27): one rectangle for each widget the template makes, on the same 12-column grid the dashboard uses, so what the
 * card shows is what the server will create (it draws from the same widget list). Decorative: the card's title and line say everything, so the SVG is
 * hidden from screen readers. Colours come from classes in styles/templates.css (tokens only); nothing here is a raster.
 */

const COLUMNS = 12;
const CELL = 10; // viewBox units for one column
const WIDTH = COLUMNS * CELL;
const HEIGHT = 60;
const STANDARD_ROWS = 12; // a template of up to this many rows keeps one row height; a taller one is squeezed to fit the same picture
const GAP = 2; // the space between two glyphs: each loses half of it on every side
const THIN = 2.5; // a text widget (a heading or a paragraph) is a thin bar at the top of its cell
const MARK_MIN_W = 16; // a mark inside a glyph needs a glyph at least this wide and this high
const MARK_MIN_H = 9;

const round = (n: number) => Number(n.toFixed(2));

/** The little line drawing inside a glyph that says what kind of card it is (a path, never a rect: the rectangles are the widgets). */
function markFor(type: WidgetType, x: number, y: number, w: number, h: number): string | null {
  if (type === "text" || w < MARK_MIN_W || h < MARK_MIN_H) return null;
  const px = (f: number) => round(x + w * f);
  const py = (f: number) => round(y + h * f);
  switch (type) {
    case "timeseries": return `M${px(0.1)} ${py(0.72)}L${px(0.3)} ${py(0.45)}L${px(0.5)} ${py(0.6)}L${px(0.7)} ${py(0.3)}L${px(0.9)} ${py(0.4)}`;
    case "bar": return [0.2, 0.4, 0.6, 0.8].map((f, i) => `M${px(f)} ${py(0.85)}V${py([0.5, 0.3, 0.6, 0.4][i])}`).join("");
    case "stat": return `M${px(0.15)} ${py(0.4)}H${px(0.6)}M${px(0.15)} ${py(0.65)}H${px(0.4)}`;
    case "gauge": return `M${px(0.25)} ${py(0.7)}A${round(w * 0.25)} ${round(w * 0.25)} 0 0 1 ${px(0.75)} ${py(0.7)}`;
    case "table": return `M${px(0.12)} ${py(0.3)}H${px(0.88)}M${px(0.12)} ${py(0.5)}H${px(0.88)}M${px(0.12)} ${py(0.7)}H${px(0.88)}`;
  }
}

/** The glyphs of `widgets`. An empty list (Blank) draws a dashed frame with a plus. */
export function TemplatePreview({ widgets }: { widgets: readonly TemplateWidget[] }) {
  const rows = Math.max(STANDARD_ROWS, ...widgets.map((w) => w.y + w.h));
  const rowH = HEIGHT / rows;
  return (
    <svg className="tpl-preview" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" focusable="false">
      {widgets.length === 0 && (
        <>
          <path className="tpl-blank" d={`M${GAP} ${GAP}H${WIDTH - GAP}V${HEIGHT - GAP}H${GAP}Z`} />
          <path className="tpl-mark" d={`M${WIDTH / 2 - 6} ${HEIGHT / 2}H${WIDTH / 2 + 6}M${WIDTH / 2} ${HEIGHT / 2 - 6}V${HEIGHT / 2 + 6}`} />
        </>
      )}
      {widgets.map((widget, i) => {
        const text = widget.type === "text";
        const x = round(widget.x * CELL + GAP / 2);
        const y = round(widget.y * rowH + GAP / 2);
        const w = round(widget.w * CELL - GAP);
        const h = round(text ? Math.min(THIN, widget.h * rowH - GAP) : widget.h * rowH - GAP);
        const mark = markFor(widget.type, x, y, w, h);
        return (
          <g key={i}>
            <rect className={text ? "tpl-glyph tpl-glyph-text" : "tpl-glyph"} data-type={widget.type} data-x={widget.x} data-y={widget.y} data-w={widget.w} data-h={widget.h} x={x} y={y} width={w} height={h} rx={text ? 1 : 1.5} />
            {mark && <path className="tpl-mark" d={mark} />}
          </g>
        );
      })}
    </svg>
  );
}
