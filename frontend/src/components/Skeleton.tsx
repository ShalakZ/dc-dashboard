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

// A region that follows a skeleton somebody SAW skips the fade-in delay: a chain of skeletons (the tree and then the page, a lazy route's
// fallback and then the page's table) would otherwise blank the area for 150 ms at every step. A skeleton is seen once it is on screen:
// an instant one at once, a delayed one when its 150 ms delay (app.css) has run out. One that was answered inside the delay was never seen
// and leaves nothing behind, or the next region (the chart after the asset) would pop in at full opacity for a few frames.
// Read at render, not in an effect, so a swap inside one commit counts too (the old region has not cleaned up yet).
const SEEN_AFTER_MS = 150;
const GRACE_MS = 250;
interface Region { born: number; instant: boolean }
const mounted = new Set<Region>();
let lastSeenGone = -Infinity;

const isSeen = (region: Region, now: number) => region.instant || now - region.born >= SEEN_AFTER_MS;
function followsSeen(now: number) {
  if (now - lastSeenGone < GRACE_MS) return true;
  for (const region of mounted) if (isSeen(region, now)) return true;
  return false;
}

/** For tests: forget every mounted region and the last unmount. */
export function resetSkeletonClock() {
  mounted.clear();
  lastSeenGone = -Infinity;
}

/** The one `role="status"` of an area: busy, with the label as its only text. It takes a className so it can BE the real wrapper. */
export function SkeletonRegion({ label, className, children }: { label: string; className?: string; children?: ReactNode }) {
  // once per mount: its own effect below joins the set, which must not turn a region that is still waiting out its delay into an instant one
  const [self] = useState<Region>(() => {
    const born = performance.now();
    return { born, instant: followsSeen(born) };
  });
  useEffect(() => {
    mounted.add(self);
    return () => {
      mounted.delete(self);
      const now = performance.now();
      if (isSeen(self, now)) lastSeenGone = now; // StrictMode's simulated unmount comes at once, so it stamps nothing for a delayed region
    };
  }, [self]);
  return (
    <div role="status" aria-busy="true" className={className ? `sk-region ${className}` : "sk-region"} data-instant={self.instant ? "" : undefined}>
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
 * The tiles of the asset page, the fleet summary and the Storage page. Each is the real `.tile`: a muted label row (a 16px circle and a line,
 * or with `plain` just a line, as Storage's `.muted` caption), the figure, and for the tiles listed in `notes` a `<small>` line under it (the
 * fleet's "Live power" tile always has one, and a row is as tall as its tallest tile). `className` adds classes to the grid (`storage-tiles`).
 */
export function TilesSkeleton({ count, fleet, notes, plain, className, label }: {
  count: number; fleet?: boolean; notes?: readonly number[]; plain?: boolean; className?: string; label?: string;
}) {
  const grid = ["tiles", fleet ? "fleet-tiles" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <Labelled label={label}>
      <div className={grid} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div className="tile" key={i}>
            {plain ? (
              <div className="muted"><Skeleton width="12ch" /></div>
            ) : (
              <div className="muted tile-label"><Skeleton variant="circle" width={16} /><Skeleton width="10ch" /></div>
            )}
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

/**
 * A real table in the real `.table-wrap`, so the header and row heights come from the same CSS (`--row-y`). Its rows are not in the
 * accessibility tree; it never scrolls. `caption` adds the muted how-to-read row above the header (Billing's), `headless` leaves the header
 * out (Storage's rows per day has body rows only): a table is as tall as the real one only if it has the same rows.
 */
export function TableSkeleton({ columns, rows, label, caption, headless }: { columns: number; rows: number; label?: string; caption?: boolean; headless?: boolean }) {
  const cols = Array.from({ length: columns }, (_, c) => c);
  return (
    <Labelled label={label}>
      <div className="table-wrap sk-table" aria-hidden="true">
        <table>
          {caption ? <caption className="muted"><Skeleton width="44ch" /></caption> : null}
          {headless ? null : (
            <thead>
              <tr>{cols.map((c) => <th key={c}><Skeleton width={HEAD_WIDTHS[c % HEAD_WIDTHS.length]} /></th>)}</tr>
            </thead>
          )}
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

/**
 * A `.form-card` of `rows` fields: a label line over a 38px field, as the real label is a grid. `wide` is the full-width card. `bare` is the
 * rows alone, for a card the page already draws (the sign-in card keeps its real heading). `inline` is the Tariffs page's one-row bar
 * (`.inline-form`: the fields side by side and a button), not a card.
 */
export function FormSkeleton({ rows, label, wide, bare, inline }: { rows: number; label?: string; wide?: boolean; bare?: boolean; inline?: boolean }) {
  const fields = Array.from({ length: rows }, (_, i) => (
    <div className="sk-field" key={i}>
      <Skeleton width={HEAD_WIDTHS[i % HEAD_WIDTHS.length]} />
      <Skeleton variant="block" width={inline ? 110 : undefined} height={38} />
    </div>
  ));
  return (
    <Labelled label={label}>
      {inline ? (
        <div className="inline-form" aria-hidden="true">{fields}<Skeleton variant="block" width={64} height={38} /></div>
      ) : bare ? (
        <div className="sk-stack" aria-hidden="true">{fields}</div>
      ) : (
        <div className={wide ? "form-card wide" : "form-card"} aria-hidden="true"><div className="sk-stack">{fields}</div></div>
      )}
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

/** A breadcrumb trail of lines with the separators drawn by the stylesheet, as a div (the page's one Breadcrumb landmark is the real one). */
function TrailSkeleton({ widths }: { widths: readonly string[] }) {
  return (
    <div className="crumbs" aria-hidden="true">
      <ol>
        {widths.map((width, i) => (
          <li key={i}>{i > 0 ? <span className="sep sk-sep" /> : null}<Skeleton width={width} /></li>
        ))}
      </ol>
    </div>
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
        {crumbs ? <TrailSkeleton widths={["6ch", "10ch", "12ch"]} /> : null}
        {icon ? <div className="page-title"><Skeleton variant="block" width={40} height={40} />{title}</div> : title}
        {sub ? <p className="sub"><Skeleton width="30ch" /></p> : null}
        {actions ? <div className="actions"><Skeleton variant="block" width={96} height={34} /></div> : null}
      </header>
    </Labelled>
  );
}

/**
 * A gap (34px, or the `height` given) for a button or a row of controls that depends on data: the actions slot of a REAL page header
 * (Sources, Scans, Billing: one without its actions is 6.5px shorter), Audit's place for the Friendly/Raw switch, Billing's for the month
 * bar (38px, its selects). Not grey: it stands outside any region, and a grey block would show before the fade-in delay.
 */
export function ActionsSpace({ height = 34 }: { height?: number } = {}) {
  return <span aria-hidden="true" style={{ display: "block", height }} />;
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

// Name widths of the kinds in the fleet summary's row, a fixed pattern.
const KIND_WIDTHS = ["5ch", "7ch", "4ch", "6ch", "5ch"];

/**
 * The fleet summary under its header: the four tiles (the second, "Live power", always has its note line), "By kind" and a row of kinds,
 * "Needs attention" and its table. One region; the headings are real `.section-title` h2s that no one can read.
 */
export function FleetSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label}>
      <TilesSkeleton count={4} fleet notes={[1]} />
      <h2 className="section-title" aria-hidden="true"><Skeleton width="8ch" /></h2>
      <ul className="kind-list" aria-hidden="true">
        {KIND_WIDTHS.map((width, i) => (
          <li key={i}>
            <span className="kind-name"><Skeleton variant="circle" width={16} /><Skeleton width={width} /></span>
            <span className="kind-count"><Skeleton width="2ch" /></span>
          </li>
        ))}
      </ul>
      <h2 className="section-title" aria-hidden="true"><Skeleton width="15ch" /></h2>
      <TableSkeleton columns={4} rows={3} />
    </SkeletonRegion>
  );
}

/**
 * The asset page under the workspace's pane: the region IS the page's `div.asset-page`, so `.asset-page > h2` styles the two heading
 * placeholders. The header carries crumbs, the icon block and the sub line; three tiles without notes; the trend frame; the metrics table.
 */
export function AssetSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="asset-page">
      <PageHeaderSkeleton crumbs icon sub />
      <TilesSkeleton count={3} />
      <h2 aria-hidden="true"><Skeleton width="6ch" /></h2>
      <TrendSkeleton />
      <h2 aria-hidden="true"><Skeleton width="8ch" /></h2>
      <TableSkeleton columns={4} rows={3} />
    </SkeletonRegion>
  );
}

/**
 * The dashboard page, which has no `.page-head`: its top is the trail (Dashboards and the dashboard's name) and the `.row.dash-head` (the title,
 * a spacer, the range label and its 142x38 select, and for someone who can edit the 55px Edit button), then the widgets. The widgets are four
 * 240px blocks in two columns with the grid's 10px gap: the real grid is the dashboard's own layout, which is not known yet. The region is
 * `.sk-dash`, which gives the trail the margin `main > .crumbs` gives the real one. None of the grid's class names: a locator must not find it.
 */
export function DashboardSkeleton({ label, canEdit }: { label: string; canEdit?: boolean }) {
  return (
    <SkeletonRegion label={label} className="sk-dash">
      <TrailSkeleton widths={["10ch", "14ch"]} />
      <div className="row dash-head" aria-hidden="true">
        <div className="sk-h1"><Skeleton width="18ch" /></div>
        <span className="spacer" />
        <Skeleton width="14ch" />
        <Skeleton variant="block" width={142} height={38} />
        {canEdit ? <Skeleton variant="block" width={55} height={34} /> : null}
      </div>
      <div className="sk-quad" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="block" height={240} />)}
      </div>
    </SkeletonRegion>
  );
}

/**
 * The Discovery graph's canvas: the region IS the real `.graph-layout` row (it takes what the window leaves under the header, at least
 * 320px), holding one block that stretches to the row. The page header above it is the real one.
 */
export function CanvasSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="graph-layout">
      <Skeleton variant="block" height="auto" />
    </SkeletonRegion>
  );
}
