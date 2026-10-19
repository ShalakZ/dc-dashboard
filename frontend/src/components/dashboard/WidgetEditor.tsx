import { Fragment, useId, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { useAssetKinds } from "../../api/queries";
import {
  TEXT_STYLES, WIDGET_TYPES, type Asset, type Metric, type RangePreset, type TextStyle, type WidgetBars, type WidgetSource, type WidgetType,
} from "../../api/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  AGGREGATION_LABELS, allowedAggregations, allowedSources, blankForm, compareAllowed, formFromDraft, formIssues, formToFields, isCompareOn,
  isKindMode, keepAssetsWithMetric, MAX_ASSETS, MAX_TEXT, MAX_TOP, MIN_TOP, singleAssetForm, SOURCE_LABELS, TYPE_LABELS, WIDGET_METRICS,
  withBars, withCompare, withMetric, withSource, withType,
  type Aggregation, type WidgetFields, type WidgetForm, type WidgetMetric,
} from "../../lib/dashboardEdit";
import type { DraftWidget } from "../../lib/layout";
import { assetLabels } from "../../lib/pickerRows";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { autoTitle, TEXT_LIMITS, TEXT_STYLE_LABELS, textLength } from "../../lib/textWidget";
import { InfoTip } from "../InfoTip";
import { AssetPicker } from "./AssetPicker";
import { WidgetCard } from "./WidgetCard";

export type EditorFields = WidgetFields;

/** How long the form must sit still before the preview asks the API about it (a keystroke in the gauge limits would otherwise blank it each time). */
export const PREVIEW_DELAY_MS = 300;
/** The preview's name in the live-values registry. Dashboard widgets are registered as `String(id)` or `new-N`, so it never collides with one. */
const PREVIEW_KEY = "widget-editor-preview";

const COMPARE_TIP = "Only complete days count: this month from the 1st up to yesterday, against the same number of days from the 1st of last month, so both sides cover the same number of days. On the 1st there is nothing to compare yet, and the card says so.";
const KIND_TIP = "Choose the level that carries the meters, for example Panels or Racks. Each bar is that asset's own reading. If two levels both have meters (racks and the panels that feed them), a total over both counts the same energy twice.";

interface Props {
  /** The widget being edited, or null to add a new one. */
  initial: DraftWidget | null;
  assets: Asset[];
  /** Which assets have their own mapping for which metric (the API skips the others). The caller builds it from the discovery graph. */
  metricAssets: Map<Metric, Set<number>>;
  dashboardRange: RangePreset;
  timezone: string;
  /** The titles of the dashboard's other widgets (not the one being edited): a new text widget's automatic title avoids them. */
  otherTitles: string[];
  onSave: (fields: EditorFields) => void;
  onClose: () => void;
}

interface KindBarsProps {
  assets: Asset[];
  root: number | null;
  kind: string;
  top: string;
  /** The asset the saved widget looked under no longer exists: it is shown as the whole site, with a note. */
  rootGone: boolean;
  patch: (changes: Partial<WidgetForm>) => void;
  /** The ids of the two text fields and of the list of suggestions. */
  ids: { kind: string; top: string; list: string };
}

/**
 * The asset field of a bar chart with one bar per asset of a kind (it replaces the Assets picker): where to look (a single pick over the whole
 * tree, or the whole site), the kind to draw a bar for (the registry's kinds as suggestions) and how many bars to draw. The three labels are
 * exactly "Look under", "One bar for each" and "Bars to show": the picker has its own "Filter by kind", and a lookup by substring must not
 * find two of them. The kinds are asked for only here, so a dialog that never gets to this mode sends no request for them.
 */
function KindBars({ assets, root, kind, top, rootGone, patch, ids }: KindBarsProps) {
  const { can } = useAuth();
  const { data: kinds } = useAssetKinds(can("assets.view"));
  const labels = useMemo(() => assetLabels(assets), [assets]);
  const picked = useMemo(() => (root === null ? [] : [root]), [root]);
  return (
    <>
      <AssetPicker
        key="look-under" label="Look under" assets={assets} selected={picked} single max={1}
        onChange={(chosen) => patch({ root: chosen[0] ?? null })}
      />
      {/* The button is never disabled: a disabled button that has the focus drops it to the page. It does nothing while the whole site is already chosen. */}
      <div className="row">
        <p className="spacer" aria-live="polite">{`Under: ${root === null ? "Whole site" : labels.get(root) ?? `Asset #${root}`}`}</p>
        <button type="button" className="quiet whole-site" aria-disabled={root === null ? true : undefined} onClick={() => { if (root !== null) patch({ root: null }); }}>
          Whole site
        </button>
      </div>
      {/* The sentence is true only while the form still looks at the whole site: a new pick hides it (visibility, so the line keeps its room and nothing below moves). */}
      {rootGone && <p className="muted" style={{ visibility: root === null ? "visible" : "hidden" }}>The asset this widget looked under was removed, so it now looks at the whole site.</p>}
      <div className="field has-tip">
        <label htmlFor={ids.kind}>One bar for each</label>
        <InfoTip>{KIND_TIP}</InfoTip>
        <input id={ids.kind} list={ids.list} value={kind} autoComplete="off" spellCheck={false} onChange={(e) => patch({ kind: e.target.value })} />
        <datalist id={ids.list}>{(kinds ?? []).map((k) => <option key={k.id} value={k.name} />)}</datalist>
      </div>
      <div className="field">
        <label htmlFor={ids.top}>Bars to show</label>
        <input id={ids.top} type="number" min={MIN_TOP} max={MAX_TOP} step={1} value={top} onChange={(e) => patch({ top: e.target.value })} />
      </div>
    </>
  );
}

/**
 * Add or edit one widget. Nothing leaves the dialog until "Save widget"; Save stays disabled until the form follows the
 * API's rules, and the preview (the real widget, via POST /api/widget-data) appears once it does and has stopped changing.
 * A text widget has no data: its dialog is Type, Title, Style and Text, and its preview draws at once from the form and asks the API nothing.
 */
export function WidgetEditor({ initial, assets, metricAssets, dashboardRange, timezone, otherTitles, onSave, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const field = (name: string) => `${id}-${name}`;
  const known = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const [dropped] = useState(() => (initial && initial.type !== "text" ? initial.config.assets.filter((a) => !known.has(a)).length : 0));
  // A saved breakdown whose root was deleted since: it is shown as the whole site, with a note (like the dropped assets above).
  const [rootGone] = useState(() => initial !== null && initial.type !== "text" && initial.config.root != null && !known.has(initial.config.root));
  const [form, setForm] = useState<WidgetForm>(() => {
    if (!initial) return blankForm();
    const loaded = formFromDraft(initial);
    return { ...loaded, assets: loaded.assets.filter((a) => known.has(a)), root: loaded.root !== null && known.has(loaded.root) ? loaded.root : null };
  });
  // The range the form had before the comparison box was ticked: unticking the box gives it back (an automatic untick, from a change of type or
  // source, leaves the range alone). A widget that opens with the box ticked has only this month to go back to.
  const [rangeBefore, setRangeBefore] = useState<RangePreset | "">(form.range);
  // True once the title is the person's own: a widget that already exists has one, and so has a new one after they type in Title.
  // Until then a text widget's title follows its style and text (autoTitle), and a data type's title stays empty.
  const [titleEdited, setTitleEdited] = useState(initial !== null);
  useDialogFocus(root, onClose, { initial: titleInput });

  const patch = (changes: Partial<WidgetForm>) => setForm((current) => ({ ...current, ...changes }));
  const comparable = compareAllowed(form);
  const comparing = isCompareOn(form);
  const kindMode = isKindMode(form);
  const compareNote = field("compare-note");
  const onCompare = (on: boolean) => {
    if (on) setRangeBefore(form.range);
    setForm((current) => withCompare(current, on, rangeBefore));
  };
  /** The form with the automatic title applied when it still applies (a text widget whose title was never typed). */
  const retitled = (f: WidgetForm): WidgetForm => (titleEdited || f.type !== "text" ? f : { ...f, title: autoTitle(f.style, f.text, otherTitles) });
  const messages = Object.values(formIssues(form)).filter((m): m is string => m !== undefined);
  const fields = useMemo(() => formToFields(form), [form]);
  const isText = form.type === "text";
  const characters = form.style === "divider" ? null : { count: textLength(form.text), limit: TEXT_LIMITS[form.style] };
  const heading = initial ? "Edit widget" : "Add widget";

  // A metric widget lists the assets that have the metric, plus any already-selected one that lacks it (a saved widget may
  // name such an asset): that one stays checked and labelled so it can be unchecked. Energy and cost take every asset.
  const { offered, notes } = useMemo(() => {
    if (form.source !== "metric") return { offered: assets, notes: undefined };
    const having = metricAssets.get(form.metric);
    const selected = new Set(form.assets);
    return {
      offered: assets.filter((a) => having?.has(a.id) || selected.has(a.id)),
      notes: new Map(form.assets.filter((a) => !having?.has(a)).map((a) => [a, `no ${form.metric}`] as const)),
    };
  }, [assets, metricAssets, form.source, form.metric, form.assets]);

  // The preview follows the form only after it has settled, and only when what it settled on is valid too.
  const settled = useDebouncedValue(form, PREVIEW_DELAY_MS);
  const settledFields = useMemo(() => formToFields(settled), [settled]);
  const settledValid = Object.keys(formIssues(settled)).length === 0;
  const shown = isText ? fields : settledFields; // a text widget draws from the form itself, at once

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label={heading} className="dialog">
        <h2>{heading}</h2>
        <div className="editor-cols">
          <div>
            <div className="field">
              <label htmlFor={field("type")}>Type</label>
              <select
                id={field("type")}
                value={form.type}
                onChange={(e) => {
                  const type = e.target.value as WidgetType;
                  setForm((f) => {
                    // A gauge forces the metric source; assets that lack the metric go then, but not on a type change that keeps the source.
                    const next = withType(f, type);
                    const repaired = next.source !== f.source ? keepAssetsWithMetric(next, metricAssets) : next;
                    // A title nobody typed follows the type: the text widget's automatic one, none for a data widget (a typed one is kept).
                    return titleEdited ? repaired : { ...repaired, title: type === "text" ? autoTitle(repaired.style, repaired.text, otherTitles) : "" };
                  });
                }}
              >
                {WIDGET_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={field("title")}>Title</label>
              <input
                id={field("title")} ref={titleInput} value={form.title} maxLength={MAX_TEXT}
                onChange={(e) => { setTitleEdited(true); patch({ title: e.target.value }); }}
              />
            </div>
            {form.type === "text" ? (
              <Fragment key="text-fields">
                <div className="field">
                  <label htmlFor={field("style")}>Style</label>
                  <select id={field("style")} value={form.style} onChange={(e) => setForm((f) => retitled({ ...f, style: e.target.value as TextStyle }))}>
                    {TEXT_STYLES.map((s) => <option key={s} value={s}>{TEXT_STYLE_LABELS[s]}</option>)}
                  </select>
                </div>
                {characters && (
                  <div className="field">
                    <label htmlFor={field("text")}>Text</label>
                    <textarea
                      id={field("text")} rows={5} value={form.text} aria-describedby={field("count")}
                      onChange={(e) => setForm((f) => retitled({ ...f, text: e.target.value }))}
                    />
                    {/* The line is always here for a heading and a paragraph (min-height: 1lh), so the count appearing moves nothing. It is not a live region. */}
                    <p id={field("count")} className="widget-text-count">
                      {`${characters.count.toLocaleString("en-US")} of ${characters.limit.toLocaleString("en-US")} characters`}
                    </p>
                  </div>
                )}
              </Fragment>
            ) : (
              <Fragment key="data-fields">
                <div className="field">
                  <label htmlFor={field("source")}>Source</label>
                  <select
                    id={field("source")}
                    value={form.source}
                    onChange={(e) => setForm((f) => keepAssetsWithMetric(withSource(f, e.target.value as WidgetSource), metricAssets))}
                  >
                    {allowedSources(form.type).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
                  </select>
                </div>
                {form.source === "metric" && (
                  <div className="field">
                    <label htmlFor={field("metric")}>Metric</label>
                    <select
                      id={field("metric")}
                      value={form.metric}
                      onChange={(e) => setForm((f) => keepAssetsWithMetric(withMetric(f, e.target.value as WidgetMetric), metricAssets))}
                    >
                      {WIDGET_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
                {form.type !== "timeseries" && (
                  <div className="field">
                    <label htmlFor={field("aggregation")}>Aggregation</label>
                    <select id={field("aggregation")} value={form.aggregation} onChange={(e) => patch({ aggregation: e.target.value as Aggregation })}>
                      {allowedAggregations(form.type, form.source, form.metric).map((a) => <option key={a} value={a}>{AGGREGATION_LABELS[a]}</option>)}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label htmlFor={field("range")}>Widget range</label>
                  <select
                    id={field("range")} value={form.range} disabled={comparing} aria-describedby={comparing ? compareNote : undefined}
                    onChange={(e) => patch({ range: e.target.value as RangePreset | "" })}
                  >
                    <option value="">Use dashboard range</option>
                    {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
                  </select>
                  {/* Where a comparison is possible the sentence's two lines are always here, hidden until the box is ticked, so ticking it moves nothing. */}
                  {comparable && (
                    <p id={compareNote} className="muted field-help" style={{ visibility: comparing ? "visible" : "hidden" }}>
                      A comparison always looks at this month so far, against the same days of last month.
                    </p>
                  )}
                </div>
                {comparable && (
                  <div className="has-tip compare-field">
                    <label className="inline">
                      <input type="checkbox" checked={comparing} onChange={(e) => onCompare(e.target.checked)} />
                      Compare with the same days of last month
                    </label>
                    <InfoTip>{COMPARE_TIP}</InfoTip>
                  </div>
                )}
                {form.type === "bar" && (
                  <div className="field">
                    <label htmlFor={field("bars")}>Bars</label>
                    <select id={field("bars")} value={form.bars} onChange={(e) => setForm((f) => withBars(f, e.target.value as WidgetBars))}>
                      <option value="asset">One bar per asset</option>
                      <option value="time">One bar per time bucket</option>
                      {form.source !== "metric" && <option value="kind">One bar per asset of a kind</option>}
                    </select>
                  </div>
                )}
                {form.type === "gauge" && (
                  <div className="row">
                    <div className="field">
                      <label htmlFor={field("gmin")}>Gauge minimum</label>
                      <input id={field("gmin")} type="number" step="any" value={form.gaugeMin} onChange={(e) => patch({ gaugeMin: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor={field("gmax")}>Gauge maximum</label>
                      <input id={field("gmax")} type="number" step="any" value={form.gaugeMax} onChange={(e) => patch({ gaugeMax: e.target.value })} />
                    </div>
                  </div>
                )}
              </Fragment>
            )}
          </div>
          <div>
            {kindMode && (
              <KindBars
                assets={assets} root={form.root} kind={form.kind} top={form.top} rootGone={rootGone} patch={patch}
                ids={{ kind: field("kind"), top: field("top"), list: field("kinds") }}
              />
            )}
            {form.type !== "text" && !kindMode && (
              <>
                <AssetPicker
                  key="assets"
                  assets={offered} tree={assets} notes={notes} selected={form.assets} onChange={(ids) => patch({ assets: ids })}
                  single={singleAssetForm(form)} max={MAX_ASSETS}
                  empty={assets.length > 0 ? `No asset has a mapping for ${form.metric}; choose another metric.` : undefined}
                />
                {dropped > 0 && <p className="muted">{dropped} removed asset{dropped === 1 ? " was" : "s were"} dropped from this widget.</p>}
              </>
            )}
            <h3>Preview</h3>
            {messages.length > 0 ? (
              <p className="muted">Complete the form to see a preview.</p>
            ) : !isText && (!settledValid || settled.type === "text") ? (
              <p className="muted">Preparing the preview…</p>
            ) : (
              // The real card, as a dashboard draws it, minus the buttons that act on a saved widget (Details, CSV) and the stream.
              // A text widget has no data to wait for: it draws at once from the form, not from the settled copy, and asks the API nothing.
              <div className="widget-preview" data-type={shown.type}>
                <WidgetCard widget={shown} widgetKey={PREVIEW_KEY} dashboardRange={dashboardRange} timezone={timezone} csv={false} details={false} live={false} />
              </div>
            )}
          </div>
        </div>
        <div className="widget-issues">{messages.length > 0 && <ul className="muted issues">{messages.map((m) => <li key={m}>{m}</li>)}</ul>}</div>
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={() => onSave(fields)} disabled={messages.length > 0}>Save widget</button>
        </div>
      </div>
    </div>
  );
}
