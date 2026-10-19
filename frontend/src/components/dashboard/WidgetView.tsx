import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWidgetData } from "../../api/queries";
import type { RangePreset, WidgetConfig, DataWidgetType } from "../../api/types";
import { hasNoBars } from "../../lib/breakdown";
import { withoutEnergyStars } from "../../lib/compare";
import { childrenNote, chooseText, isFollowing, leafText, NO_ASSETS_TEXT, ownAssetsNote } from "../../lib/focus";
import { isLiveWidget, pointIdsOf } from "../../lib/live";
import { isRolling } from "../../lib/ranges";
import { flagsOf, markerHint, sinceText, skeletonShape } from "../../lib/widgetFormat";
import { useFocus } from "./FocusContext";
import { useLiveRegistration } from "./LiveValuesContext";
import { WidgetBody } from "./WidgetBody";
import { WidgetDetails } from "./WidgetDetails";
import { WidgetFrame } from "./WidgetFrame";

export interface WidgetViewProps {
  /** Unique within the page; names this widget in the live registry. */
  widgetKey: string;
  type: DataWidgetType;
  title: string;
  config: WidgetConfig;
  /** The range a widget without its own `config.range` inherits. */
  dashboardRange: RangePreset;
  timezone: string;
  /** Show the CSV button (default true). */
  csv?: boolean;
  /** Follow the dashboard's live stream when eligible (default true). The editor preview and edit mode turn it off. */
  live?: boolean;
  /** Show the Details button and its panel (default true); the editor preview and edit mode turn it off. */
  details?: boolean;
  actions?: ReactNode;
  dragHandle?: boolean;
}

const NO_IDS: number[] = [];

/** Fetch and show one widget: query by the effective range, register for live updates, draw it inside a WidgetFrame. */
export function WidgetView({ widgetKey, type, title, config, dashboardRange, timezone, csv = true, live = true, details = true, actions, dragHandle }: WidgetViewProps) {
  const preset = config.range ?? dashboardRange;
  // "Split by" on a breakdown by kind: the viewer's pick lasts for this visit only (not saved, not in the address, like the dashboard range) and is tied to the
  // kind the widget is saved with, so a saved change of that kind (an edit) drops the pick. The asked-for config, the CSV and the Details panel all follow it.
  const [pick, setPick] = useState<{ stored: string | undefined; kind: string } | null>(null);
  const kind = config.bars === "kind" && pick !== null && pick.stored === config.kind ? pick.kind : config.kind;
  const shown = useMemo(() => (kind === config.kind ? config : { ...config, kind }), [config, kind]);
  const onKind = useCallback((next: string) => setPick({ stored: config.kind, kind: next }), [config.kind]);
  // w25. A card that follows the focus asks about the dashboard's focus (the key and the request carry it); any other card never does, so a change of focus
  // costs it nothing (no request, no new render of its figures).
  const ctx = useFocus();
  const follows = isFollowing(shown);
  const focus = follows ? ctx.focus : null;
  const query = useWidgetData(type, shown, preset, true, focus);
  // A comparison of energy draws no `*` (a cost mark), whatever flag its answer carries: cleared once here, for the card, the footer and the Details panel alike.
  const answer = query.data;
  const data = useMemo(() => (answer ? withoutEnergyStars(answer) : undefined), [answer]);
  // The focus of the last real answer this card drew. A placeholder (the previous answer, kept while the next loads) is dimmed only when it was fetched for another
  // focus: a change of range, or of the breakdown's "Split by", keeps the plain placeholder it always had (R13).
  const drawnFor = useRef<number | null>(null);
  const placeholder = query.isPlaceholderData;
  const stale = follows && placeholder && drawnFor.current !== focus;
  useEffect(() => {
    if (data && !placeholder) drawnFor.current = focus;
  }, [data, placeholder, focus]);
  // What the server says about the focus (null for a card that does not follow it), and the three answers that have no figures to draw.
  const block = follows ? (data?.focus ?? null) : null;
  const gone = block?.state === "gone";
  const choose = block?.state === "choose";
  const leaf = block?.state === "ok" && shown.scope === "children" && block.children?.count === 0;
  const bare = gone || choose || leaf; // no figures: no footer line about them either
  // A breakdown that found no bars says so in a sentence that names the asset it looked under; read from a placeholder that would be the previous focus's asset under
  // the new trail, so the card keeps an empty dimmed body until the real answer lands (as it does for the two sentences below).
  const oldSentence = stale && data?.mode === "values" && data.breakdown != null && hasNoBars(data.values);
  // A sentence is about the focus the answer was fetched for, so none is drawn from a placeholder for another focus: a card that said "choose a focus" or "X has no
  // children" shows an empty dimmed body until the real answer lands.
  const sentence = stale ? null : choose ? chooseText(block.top_level, ctx.allowed) : leaf ? (block.asset ? leafText(block.asset.path) : NO_ASSETS_TEXT) : null;
  // A focus the server does not know: the page falls back to the whole site. The id is null until the real answer says so, and goes back to null when the
  // address changes, so each focus value reports once (the provider ignores a report for a focus that is no longer in the address).
  const goneFor = gone && !placeholder ? focus : null;
  const reportGone = ctx.reportGone;
  useEffect(() => {
    if (goneFor !== null) reportGone(goneFor);
  }, [goneFor, reportGone]);
  // The Details drawer. `opener` is the button that opened it: focus goes back there on close (a browser may not focus a clicked button).
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // The button waits (aria-disabled) while the first answer loads; with no answer and none coming (an error) there is nothing to show, so no button.
  // A card with nothing but a sentence (a focus to choose, a gone one, a leaf) has no figures to explain: no button.
  const canOpen = details && !bare && (query.isLoading || data !== undefined);
  // The Details drawer is about one focus: when the address moves to another, it closes.
  useEffect(() => setOpen(false), [focus]);
  const following = live && isLiveWidget(type, shown, preset);
  useLiveRegistration(widgetKey, following ? pointIdsOf(data) : NO_IDS);
  // Rolling energy and cost windows start at a whole hour, not at "now minus the range": say where. The config already tells whether the line will come, before the data does.
  const sinceExpected = config.source !== "metric" && isRolling(preset);
  const csvSource = csv ? { type, config: shown, range: preset, ...(focus === null ? {} : { focus }) } : undefined;
  // The footer's last sentence (R6, R11): which part of the tree a card that follows the focus really shows, or that the others keep their own. A card whose own asset
  // IS the focus asset (assets exactly the focus, or a breakdown looking under it) shows the focus asset, so the sentence would be false there (W4).
  const ownsFocus = ctx.focus !== null && (shown.bars === "kind" ? shown.root === ctx.focus : shown.assets.length === 1 && shown.assets[0] === ctx.focus);
  const note = follows
    ? (block?.state === "ok" && block.children && block.children.shown < block.children.count ? childrenNote(block.children.shown, block.children.count, block.asset?.name ?? null) : "")
    : (ctx.focus !== null && ctx.name !== null && !ownsFocus ? ownAssetsNote(ctx.name) : "");
  // The footer line's room is held on the focus, not on the words: the note about the asset's name waits for the asset list, and a children card's count comes and goes
  // with its answer, but the body must not move when either arrives.
  const footKeep = follows ? shown.scope === "children" : ctx.focus !== null;
  return (
    <>
      <WidgetFrame
        title={title}
        type={type}
        shape={skeletonShape(type, config)}
        footSpace={sinceExpected || footKeep || note !== ""}
        footKeep={footKeep}
        loading={query.isLoading}
        error={query.error}
        missing={gone ? 0 : (data?.missing.length ?? 0)}
        noMetric={data?.no_metric.length ?? 0}
        // The footer explains the markers for every type: a chart's legend may be off, and a figure carries only its mark.
        hint={data && !bare ? markerHint(flagsOf(data)) : ""}
        since={data && !bare && data.source !== "metric" && isRolling(data.range.preset) ? sinceText(data.range.start, data.range.end, timezone) : ""}
        note={note}
        stale={stale}
        csv={csvSource}
        details={canOpen ? (button) => { opener.current = button; setOpen(true); } : undefined}
        actions={actions}
        dragHandle={dragHandle}
      >
        {sentence !== null ? <p className="widget-empty">{sentence}</p> : data && !bare && !oldSentence ? <WidgetBody type={type} data={data} config={shown} timezone={timezone} live={following} onKind={onKind} splitDisabled={!details} /> : null}
      </WidgetFrame>
      {open && canOpen && data && !stale && (
        <WidgetDetails
          title={title} type={type} data={data} config={shown} timezone={timezone} following={following} csv={csvSource}
          onClose={() => setOpen(false)} returnFocus={() => opener.current}
        />
      )}
    </>
  );
}
