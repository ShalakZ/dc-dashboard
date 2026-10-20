import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import "../styles/display-wall.css";
import type { WidgetConfig } from "../api/types";
import { ChartPixelRatioContext } from "../components/dashboard/widgets/chartPixelRatio";
import { withoutEnergyStars } from "../lib/compare";
import { cellStyle, gridStyle, readingOrder } from "../lib/gridMetrics";
import { compactVertical } from "../lib/layout";
import { flagsOf, markerHint, type HintFlags } from "../lib/widgetFormat";
import type { DisplayDashboard, DisplayWidget } from "./displayApi";
import type { Timers } from "./displayLoop";
import { fitWall, naturalHeight } from "./fit";
import { WallCard, wallFocusView, type WallFocus } from "./WallCard";
import { formatClock, isDataWidget } from "./wallRules";
import type { CardState, Wall, WallSnapshot } from "./wallTypes";

// The wall: the screen a connected display shows. It draws a snapshot of the wall controller (the one object that talks to the server) and nothing else:
// no request is made here, and nothing here starts, stops or feeds the controller. It runs OUTSIDE the app, so nothing of the app's providers is used.

/** A pointer that has not moved for this long is hidden (R7). */
export const CURSOR_IDLE_MS = 3_000;

export interface WallViewport { width: number; height: number; dpr: number }

const readWindow = (): WallViewport => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 });

/** The window's size and pixel ratio, kept up to date on `resize` (a browser zoom changes all three); a `fixed` value is used as it is (tests). */
function useViewport(fixed: WallViewport | undefined): WallViewport {
  const [size, setSize] = useState<WallViewport>(readWindow);
  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const onResize = () => {
      const next = readWindow();
      setSize((previous) => (previous.width === next.width && previous.height === next.height && previous.dpr === next.dpr ? previous : next));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fixed]);
  return fixed ?? size;
}

/** The mouse pointer disappears after CURSOR_IDLE_MS without a move and comes back on the next one. The wait runs on the injected timers. */
function useIdleCursor(timers: Timers): { idle: boolean; onMove: () => void } {
  const [idle, setIdle] = useState(false);
  const pending = useRef<unknown>(null);
  const arm = useCallback(() => {
    if (pending.current !== null) timers.clear(pending.current);
    pending.current = timers.set(() => {
      pending.current = null;
      setIdle(true);
    }, CURSOR_IDLE_MS);
  }, [timers]);
  useEffect(() => {
    arm();
    return () => {
      if (pending.current !== null) timers.clear(pending.current);
      pending.current = null;
    };
  }, [arm, timers]);
  const onMove = useCallback(() => {
    setIdle(false);
    arm();
  }, [arm]);
  return { idle, onMove };
}

/**
 * The wall's own short words for the marks in `flags` (the app's marks, `markerHint`'s order), two spaces apart: "~ estimated  * partial  — no rate". The app's words are a
 * sentence per mark (the partial one alone is 34 characters) and do not fit the header's right column; the full text stays as the legend's title.
 */
export function wallMarks(flags: HintFlags): string {
  const words: string[] = [];
  if (flags.estimated) words.push("~ estimated");
  if (flags.partial) words.push("* partial");
  if (flags.noRate) words.push("— no rate");
  return words.join("  ");
}

interface Legend { /** What the header shows. */ marks: string; /** The app's own text (`markerHint`), the legend's title. */ hint: string }

/**
 * The marks the cards on screen carry (`marks` in the wall's short words, `hint` in the app's own): both empty when none does. A comparison of energy shows no `*`
 * and a card that shows a sentence instead of figures marks nothing, as in the app. A card whose answer cannot be read is left out here (its own boundary says so).
 */
function legendOf(widgets: readonly DisplayWidget[], cards: Readonly<Record<number, CardState>>, focus: WallFocus | null): Legend {
  const union: HintFlags = { estimated: false, partial: false, noRate: false };
  for (const widget of widgets) {
    const data = cards[widget.id]?.data ?? null;
    if (data === null || !isDataWidget(widget.type)) continue;
    try {
      const config = widget.config;
      if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
      if (wallFocusView({ config: config as WidgetConfig }, data, focus).bare) continue;
      const flags = flagsOf(withoutEnergyStars(data));
      union.estimated = union.estimated || flags.estimated;
      union.partial = union.partial || flags.partial;
      union.noRate = union.noRate || flags.noRate;
    } catch {
      // a malformed answer: that card is skipped here and draws its own sentence
    }
  }
  return { marks: wallMarks(union), hint: markerHint(union) };
}

/** The dashboard's own grid: the same placement as the app's read-only grid (`StaticGrid`), under the wall's own class names so no rule of the app's grid reaches it. */
function WallGrid({ widgets, render }: { widgets: readonly DisplayWidget[]; render: (widget: DisplayWidget) => ReactNode }) {
  const cells = widgets.map((widget) => ({ key: String(widget.id), x: widget.x, y: widget.y, w: widget.w, h: widget.h, widget }));
  return (
    <div className="wall-grid" style={gridStyle}>
      {readingOrder(compactVertical(cells)).map((cell) => (
        <div key={cell.key} className="wall-cell" style={cellStyle(cell)}>{render(cell.widget)}</div>
      ))}
    </div>
  );
}

function Message({ text }: { text: string | null }) {
  return (
    <div className="display-screen">
      <p className={text === null ? "display-screen-text display-screen-quiet" : "display-screen-text"} aria-live="polite">{text ?? "Connecting..."}</p>
    </div>
  );
}

interface ViewProps {
  snap: WallSnapshot;
  dashboard: DisplayDashboard;
  focus: WallFocus | null;
  timers: Timers;
  viewport: WallViewport | undefined;
}

function WallView({ snap, dashboard, focus, timers, viewport }: ViewProps) {
  const win = useViewport(viewport);
  const { idle, onMove } = useIdleCursor(timers);
  const { widgets } = dashboard;
  const natural = useMemo(() => naturalHeight(widgets), [widgets]);
  const fit = fitWall({ width: win.width, height: win.height }, natural);
  const legend = useMemo(() => legendOf(widgets, snap.cards, focus), [widgets, snap.cards, focus]);
  const { band, position, timezone } = snap;
  const clock = formatClock(snap.now, timezone);
  const updated = snap.updatedAt === null ? null : formatClock(snap.updatedAt, timezone);
  const scale = { "--wall-s": fit.scale, "--wall-unit": fit.unit } as CSSProperties;
  return (
    <main
      className={idle ? "wall wall-cursor-hidden" : "wall"} aria-label="Display" style={scale} data-dim={band ? "true" : undefined}
      onPointerMove={onMove} onMouseMove={onMove}
    >
      <header className="wall-head">
        <h1 className="wall-title">{focus ? `${dashboard.name}, ${focus.name}` : dashboard.name}</h1>
        <p className="wall-position">{position ? `${position.index} of ${position.of}` : ""}</p>
        <div className="wall-meta">
          {legend.marks !== "" && <p className="wall-legend" title={legend.hint}>{legend.marks}</p>}
          {updated !== null && <p className="wall-updated">{`Updated ${updated}`}</p>}
          {clock !== null && <p className="wall-clock">{clock}</p>}
        </div>
      </header>
      <div className="wall-stage" style={{ top: fit.top, height: natural * fit.scale }}>
        <div className="wall-canvas" data-phase={snap.phase} style={{ left: fit.left, width: fit.logicalWidth, transform: `scale(${fit.scale})`, transformOrigin: "0 0" }}>
          <ChartPixelRatioContext.Provider value={win.dpr * fit.scale}>
            <WallGrid widgets={widgets} render={(widget) => <WallCard widget={widget} card={snap.cards[widget.id]} timezone={timezone} focus={focus} />} />
          </ChartPixelRatioContext.Provider>
        </div>
      </div>
      {band && (
        <div className="wall-band" role="status">
          <p className="wall-band-text">{band.text}</p>
        </div>
      )}
    </main>
  );
}

interface Props {
  wall: Wall;
  /** The clock of the cursor's idle wait; tests move it by hand. */
  timers: Timers;
  /** The window as the view should see it (tests); by default the real window, followed on `resize`. */
  viewport?: WallViewport;
}

/** What a connected display shows: the pinned dashboard at the scale that fits the window, or the one sentence when nothing can be shown. */
export function WallScreen({ wall, timers, viewport }: Props) {
  const subscribe = useCallback((listener: () => void) => wall.subscribe(listener), [wall]);
  const read = useCallback(() => wall.snapshot(), [wall]);
  const snap = useSyncExternalStore(subscribe, read);
  const dashboard = snap.item?.dashboard ?? null;
  if (snap.item === null || dashboard === null) return <Message text={snap.emptyText} />;
  return <WallView snap={snap} dashboard={dashboard} focus={snap.item.focus} timers={timers} viewport={viewport} />;
}

