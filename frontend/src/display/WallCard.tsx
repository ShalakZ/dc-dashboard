import { Component, memo, useMemo, type ReactNode } from "react";
import { TEXT_STYLES, type DataWidgetType, type TextConfig, type WidgetConfig, type WidgetData } from "../api/types";
import { TextWidgetView } from "../components/dashboard/TextWidgetView";
import { WidgetBody } from "../components/dashboard/WidgetBody";
import { WidgetFrame } from "../components/dashboard/WidgetFrame";
import { withoutEnergyStars } from "../lib/compare";
import { childrenNote, chooseText, isFollowing, leafText, NO_ASSETS_TEXT, ownAssetsNote } from "../lib/focus";
import { skeletonShape } from "../lib/widgetFormat";
import type { DisplayWidget } from "./displayApi";
import type { CardState } from "./wallTypes";
import { formatClock, isDataWidget, wallRefetchMs } from "./wallRules";

// One card of the wall. The wall has no provider of the app (no router, no query client, no sign-in), so a card is drawn from what the controller kept:
// WidgetFrame and WidgetBody draw the figures exactly as the app's card does, and nothing here asks the server for anything.

/** What a card says when its dashboard's focus asset is no longer in the tree (the app's card draws an empty body and sends the viewer back to the whole site). */
export const GONE_TEXT = "This asset no longer exists.";
const CANNOT_SHOW = "This card cannot be shown.";

/** The focus asset the item names (the playlist's `focus`; the wall has no address to read it from). */
export interface WallFocus { id: number; name: string }

export interface WallFocusView {
  /** The sentence that replaces the figures, or null when there are figures to draw. */
  sentence: string | null;
  /** The quiet note the app's footer line carries; the wall shows it as a chip in the card head. Empty = none. */
  note: string;
  /** No figures to draw (the body is a sentence). */
  bare: boolean;
  /** The server does not know the focus asset. */
  gone: boolean;
}

/**
 * The focus state of one card, computed as `WidgetView` computes it (w25), from the item's focus instead of the address. The wall has no viewer who could
 * choose a focus, so 'choose' is said in the words for a viewer who cannot (`chooseText(.., false)`: it names no link the page could not follow).
 */
export function wallFocusView(widget: { config: WidgetConfig }, data: WidgetData | null, focus: WallFocus | null): WallFocusView {
  const config = widget.config;
  const follows = isFollowing(config);
  const block = follows ? (data?.focus ?? null) : null;
  const gone = block?.state === "gone";
  const choose = block?.state === "choose";
  const leaf = block?.state === "ok" && config.scope === "children" && block.children?.count === 0;
  const sentence = gone ? GONE_TEXT : choose ? chooseText(block.top_level, false) : leaf ? (block.asset ? leafText(block.asset.path) : NO_ASSETS_TEXT) : null;
  // A card whose own asset IS the focus asset (assets exactly the focus, or a breakdown looking under it) shows the focus asset: the sentence about "its own assets" would be false.
  const assets = Array.isArray(config.assets) ? config.assets : [];
  const ownsFocus = focus !== null && (config.bars === "kind" ? config.root === focus.id : assets.length === 1 && assets[0] === focus.id);
  const note = follows
    ? (block?.state === "ok" && block.children && block.children.shown < block.children.count ? childrenNote(block.children.shown, block.children.count, block.asset?.name ?? null) : "")
    : (focus !== null && !ownsFocus ? ownAssetsNote(focus.name) : "");
  return { sentence, note, bare: sentence !== null, gone };
}

function configOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("a widget's config is not an object");
  return value as Record<string, unknown>;
}

/** A text widget's config as the stored one: a known style, and the text (a divider holds none). */
function textConfigOf(value: unknown): TextConfig {
  const config = configOf(value);
  const style = TEXT_STYLES.find((known) => known === config.style);
  if (style === undefined) throw new Error("a text widget has a style the wall does not know");
  if (typeof config.text === "string") return { style, text: config.text };
  if (style === "divider") return { style, text: "" };
  throw new Error("a text widget has no text");
}

/** The browser's own zone, for the charts' axes when the site's zone is empty or not one the browser knows (the header draws no clock then, but a chart needs some zone). */
function chartZone(timezone: string): string {
  return formatClock(0, timezone) === null ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
}

function Sentence({ text }: { text: string }) {
  return <p className="widget-empty">{text}</p>;
}

interface DataProps {
  widget: DisplayWidget;
  card: CardState | undefined;
  timezone: string;
  focus: WallFocus | null;
}

function DataCard({ widget, card, timezone, focus }: DataProps) {
  const config = configOf(widget.config) as unknown as WidgetConfig;
  const type = widget.type as DataWidgetType;
  // A comparison of energy draws no `*` (a cost mark), whatever flag its answer carries: cleared once here, as the app's card does.
  const answer = card?.data ?? null;
  const data = useMemo(() => (answer === null ? null : withoutEnergyStars(answer)), [answer]);
  if (card?.status === "unavailable") {
    return (
      <WidgetFrame title={widget.title} type={type} loading={false} error={null} missing={0}>
        <Sentence text={CANNOT_SHOW} />
      </WidgetFrame>
    );
  }
  const view = wallFocusView({ config }, data, focus);
  // A failure with an answer kept shows nothing (the figures stay, R8); a card that never answered says so; a card whose failures are 120 s old is dimmed and tagged.
  const stale = card !== undefined && card.notUpdated && data !== null;
  const failed = card !== undefined && (card.status === "error" || stale);
  const since = stale && card.answeredAt !== null ? formatClock(card.answeredAt, timezone) : null;
  const head = view.note !== "" || stale ? (
    <>
      {view.note !== "" && <span className="wall-card-note chip chip-warn" title={view.note}><span className="wall-card-note-text">{view.note}</span></span>}
      {stale && <span className="wall-card-tag">{since === null ? "Not updated" : `Not updated since ${since}`}</span>}
    </>
  ) : undefined;
  return (
    <div className={stale ? "wall-card wall-card-stale" : "wall-card"}>
      <WidgetFrame
        title={widget.title}
        type={type}
        shape={skeletonShape(type, config)}
        loading={card === undefined || card.status === "loading"}
        error={failed ? new Error("") : null}
        retryMs={wallRefetchMs(config)}
        drawn={data !== null}
        missing={view.gone ? 0 : (data?.missing.length ?? 0)}
        noMetric={data?.no_metric.length ?? 0}
        actions={head}
      >
        {view.sentence !== null ? <Sentence text={view.sentence} /> : data !== null ? (
          <WidgetBody type={type} data={data} config={config} timezone={chartZone(timezone)} live={false} splitDisabled />
        ) : null}
      </WidgetFrame>
    </div>
  );
}

function Card(props: DataProps) {
  const { widget } = props;
  if (widget.type === "text") return <TextWidgetView title={widget.title} config={textConfigOf(widget.config)} />;
  if (!isDataWidget(widget.type)) throw new Error("a widget of a type the wall does not know");
  return <DataCard {...props} />;
}

interface BoundaryProps {
  children: ReactNode;
  /** A new answer is a new chance: the boundary starts over when this changes, without remounting a card that is fine. */
  resetKey: number;
}

/**
 * One bad card never blanks the wall: a render error inside it draws the usual card with one plain sentence, and the card is tried again when its next answer arrives.
 * Nothing is logged here.
 */
class WallCardBoundary extends Component<BoundaryProps, { failed: boolean; resetKey: number }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: BoundaryProps, state: { failed: boolean; resetKey: number }) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <section className="widget-frame">
        <Sentence text={CANNOT_SHOW} />
      </section>
    ) : this.props.children;
  }
}

export interface WallCardProps {
  widget: DisplayWidget;
  /** The controller's state for this widget; undefined before it has made one (and for a text widget, which has none). */
  card: CardState | undefined;
  /** The site's time zone ("" when the playlist did not say). */
  timezone: string;
  /** The item's focus asset, or null. */
  focus: WallFocus | null;
}

/** One card of the wall: a data widget drawn from its kept answer, or a text widget. Memoised: a minute passing redraws the clock, not the cards. */
export const WallCard = memo(function WallCard({ widget, card, timezone, focus }: WallCardProps) {
  return (
    <WallCardBoundary resetKey={card?.answeredAt ?? 0}>
      <Card widget={widget} card={card} timezone={timezone} focus={focus} />
    </WallCardBoundary>
  );
});
