import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CHART_HEIGHT } from "../lib/chartBox";

// Loading skeletons: grey shapes in the layout the data will have, shown while a page has no data yet. A Suspense fallback uses these
// shapes, so this file imports nothing from TrendChart, DashboardsPage or DashboardPage (that would pull their chunks into the main bundle).
// Text placeholders hold no words: a test or a screen reader must never find one. Shapes are bodies (an aria-hidden root); the one
// role="status" of an area is a SkeletonRegion, which a shape wraps itself in when it is given a label.

type Size = number | string;
type Variant = "line" | "block" | "circle";

/**
 * One placeholder. A line is an inline-block set in the text's own line box and sits in a plain span of its own: a bare inline-block that is a
 * direct child of a flex or grid parent (`.tile-label`, `.crumbs li`, `.page-head`) becomes a flex or grid item and loses the text's line height.
 * Numbers are px, strings pass through; a circle given one size is as high as it is wide.
 */
export function Skeleton({ variant = "line", width, height }: { variant?: Variant; width?: Size; height?: Size }) {
  const style: CSSProperties = variant === "circle" ? { width: width ?? height, height: height ?? width } : { width, height };
  if (variant === "line") return <span aria-hidden="true"><span className="sk sk-line" style={style} /></span>;
  return <span className={`sk sk-${variant}`} style={style} aria-hidden="true" />;
}

// A region that follows another (one mounted, or one gone less than 250 ms ago) skips the fade-in delay: a chain of skeletons (the tree
// and then the page, a lazy route's fallback and then the page's table) would otherwise blank the area for 150 ms at every step.
// Read at render, not in an effect, so a swap inside one commit counts too (the old region has not cleaned up yet).
const GRACE_MS = 250;
let mounted = 0;
let lastUnmount = -Infinity;

/** For tests: forget every mounted region and the last unmount. */
export function resetSkeletonClock() {
  mounted = 0;
  lastUnmount = -Infinity;
}

/** The one `role="status"` of an area: busy, with the label as its only text. It takes a className so it can BE the real wrapper. */
export function SkeletonRegion({ label, className, children }: { label: string; className?: string; children?: ReactNode }) {
  // once per mount: its own effect below raises the count, which must not turn a region that is still waiting out its delay into an instant one
  const [instant] = useState(() => mounted > 0 || Date.now() - lastUnmount < GRACE_MS);
  useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      lastUnmount = Date.now();
    };
  }, []);
  return (
    <div role="status" aria-busy="true" className={className ? `sk-region ${className}` : "sk-region"} data-instant={instant ? "" : undefined}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** A shape given a label is its own region; without one it is a bare body for a composite to put in its region. */
function Labelled({ label, children }: { label?: string; children: ReactNode }) {
  return label ? <SkeletonRegion label={label}>{children}</SkeletonRegion> : <>{children}</>;
}

/**
 * The tiles of the asset page and the fleet summary. Each is the real `.tile`: a muted label row (a 16px circle and a line), the figure, and
 * for the tiles listed in `notes` a `<small>` line under it (the fleet's "Live power" tile always has one, and a row is as tall as its tallest tile).
 */
export function TilesSkeleton({ count, fleet, notes, label }: { count: number; fleet?: boolean; notes?: readonly number[]; label?: string }) {
  return (
    <Labelled label={label}>
      <div className={fleet ? "tiles fleet-tiles" : "tiles"} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div className="tile" key={i}>
            <div className="muted tile-label"><Skeleton variant="circle" width={16} /><Skeleton width="10ch" /></div>
            <div className="big"><Skeleton width="6ch" /></div>
            {notes?.includes(i) ? <small><Skeleton width="16ch" /></small> : null}
          </div>
        ))}
      </div>
    </Labelled>
  );
}

// Line widths in `ch`, in a fixed order, so a table looks irregular and is the same every render (a percentage inside a table cell would be cyclic).
const HEAD_WIDTHS = ["7ch", "10ch", "6ch", "9ch", "8ch"];
const CELL_WIDTHS = ["11ch", "8ch", "14ch", "6ch", "10ch", "12ch"];

/** A real table in the real `.table-wrap`, so the header and row heights come from the same CSS (`--row-y`). Its rows are not in the accessibility tree; it never scrolls. */
export function TableSkeleton({ columns, rows, label }: { columns: number; rows: number; label?: string }) {
  const cols = Array.from({ length: columns }, (_, c) => c);
  return (
    <Labelled label={label}>
      <div className="table-wrap sk-table" aria-hidden="true">
        <table>
          <thead>
            <tr>{cols.map((c) => <th key={c}><Skeleton width={HEAD_WIDTHS[c % HEAD_WIDTHS.length]} /></th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>{cols.map((c) => <td key={c}><Skeleton width={CELL_WIDTHS[(r * 2 + c * 3) % CELL_WIDTHS.length]} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </Labelled>
  );
}

/** A `.form-card` of `rows` fields: a label line over a 38px field, as the real label is a grid. `wide` is the full-width card. */
export function FormSkeleton({ rows, label, wide }: { rows: number; label?: string; wide?: boolean }) {
  return (
    <Labelled label={label}>
      <div className={wide ? "form-card wide" : "form-card"} aria-hidden="true">
        <div className="sk-stack">
          {Array.from({ length: rows }, (_, i) => (
            <div className="sk-field" key={i}><Skeleton width={HEAD_WIDTHS[i % HEAD_WIDTHS.length]} /><Skeleton variant="block" height={38} /></div>
          ))}
        </div>
      </div>
    </Labelled>
  );
}

/** The trend chart's box. */
export function ChartBlock({ label }: { label?: string }) {
  return <Labelled label={label}><Skeleton variant="block" height={CHART_HEIGHT} /></Labelled>;
}

/**
 * The trend frame: the real `.trend-bar` row, whose label is a grid of a text line, a 6px gap and the 38px select (about 62px), and a 38px range
 * picker aligned to its bottom, over the chart block. No aria-label: the real frame is the "Trend" section and this one must not be found as it.
 */
export function TrendSkeleton({ label }: { label?: string }) {
  return (
    <Labelled label={label}>
      <div className="trend-frame" aria-hidden="true">
        <div className="row trend-bar">
          <div className="sk-field"><Skeleton width="7ch" /><Skeleton variant="block" width={160} height={38} /></div>
          <Skeleton variant="block" width={182} height={38} />
        </div>
        <Skeleton variant="block" height={CHART_HEIGHT} />
      </div>
    </Labelled>
  );
}

// Name widths of the tree rows and their indent level (0 to 2), a fixed pattern.
const TREE_ROWS: ReadonlyArray<readonly [level: number, width: string]> = [
  [0, "13ch"], [1, "10ch"], [2, "12ch"], [2, "8ch"], [1, "11ch"], [2, "10ch"], [0, "9ch"], [1, "12ch"], [0, "11ch"], [1, "8ch"],
];

/** Rows of the real `.node` (32px): the twisty's space, a 16px circle for the kind icon and a name line, indented like the nested lists (21px and a hairline). */
export function TreeSkeleton({ label }: { label?: string }) {
  return (
    <Labelled label={label}>
      <div className="sk-tree" aria-hidden="true">
        {TREE_ROWS.map(([level, width], i) => (
          <div className="node" key={i} style={level ? { marginLeft: level * 22, paddingLeft: 8 } : undefined}>
            <span className="twisty-sp" />
            <Skeleton variant="circle" width={16} />
            <Skeleton width={width} />
          </div>
        ))}
      </div>
    </Labelled>
  );
}

/**
 * The header of a page whose title depends on data (an asset, an audit entry, a source's points); a static title uses the real PageHeader.
 * The parts the real header would have are opt-in: `crumbs` (a trail of three, as a div, not a nav landmark), `icon` (a 40px block beside
 * the title in a `.page-title`; not the accent-tinted `.page-tile`), `sub`, and `actions` (a 34px block in the actions slot: a header
 * without its actions is 6.5px shorter).
 */
export function PageHeaderSkeleton({ crumbs, icon, sub, actions, label }: { crumbs?: boolean; icon?: boolean; sub?: boolean; actions?: boolean; label?: string }) {
  const title = <div className="sk-h1"><Skeleton width="16ch" /></div>;
  return (
    <Labelled label={label}>
      <header className="page-head" aria-hidden="true">
        {crumbs ? (
          <div className="crumbs">
            <ol>
              <li><Skeleton width="6ch" /></li>
              <li><span className="sep sk-sep" /><Skeleton width="10ch" /></li>
              <li><span className="sep sk-sep" /><Skeleton width="12ch" /></li>
            </ol>
          </div>
        ) : null}
        {icon ? <div className="page-title"><Skeleton variant="block" width={40} height={40} />{title}</div> : title}
        {sub ? <p className="sub"><Skeleton width="30ch" /></p> : null}
        {actions ? <div className="actions"><Skeleton variant="block" width={96} height={34} /></div> : null}
      </header>
    </Labelled>
  );
}

/** A whole page with nothing known about it: a page head with a title line, then two 240px blocks side by side. One region. */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label}>
      <PageHeaderSkeleton />
      <div className="sk-pair" aria-hidden="true">
        <Skeleton variant="block" height={240} />
        <Skeleton variant="block" height={240} />
      </div>
    </SkeletonRegion>
  );
}
