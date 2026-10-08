import { useId, useMemo, useRef, useState } from "react";
import { WIDGET_TYPES, type Asset, type Metric, type RangePreset, type WidgetConfig, type WidgetSource, type WidgetType } from "../../api/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  AGGREGATION_LABELS, allowedAggregations, allowedSources, blankForm, formFromDraft, formIssues, formToFields, isSingleAsset,
  keepAssetsWithMetric, MAX_ASSETS, MAX_TEXT, SOURCE_LABELS, TYPE_LABELS, WIDGET_METRICS, withMetric, withSource, withType,
  type Aggregation, type WidgetForm, type WidgetMetric,
} from "../../lib/dashboardEdit";
import type { DraftWidget } from "../../lib/layout";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { AssetPicker } from "./AssetPicker";
import { WidgetView } from "./WidgetView";

export interface EditorFields { type: WidgetType; title: string; config: WidgetConfig }

/** How long the form must sit still before the preview asks the API about it (a keystroke in the gauge limits would otherwise blank it each time). */
export const PREVIEW_DELAY_MS = 300;
/** The preview's name in the live-values registry. Dashboard widgets are registered as `String(id)` or `new-N`, so it never collides with one. */
const PREVIEW_KEY = "widget-editor-preview";

interface Props {
  /** The widget being edited, or null to add a new one. */
  initial: DraftWidget | null;
  assets: Asset[];
  /** Which assets have their own mapping for which metric (the API skips the others). The caller builds it from the discovery graph. */
  metricAssets: Map<Metric, Set<number>>;
  dashboardRange: RangePreset;
  timezone: string;
  onSave: (fields: EditorFields) => void;
  onClose: () => void;
}

/**
 * Add or edit one widget. Nothing leaves the dialog until "Save widget"; Save stays disabled until the form follows the
 * API's rules, and the preview (the real widget, via POST /api/widget-data) appears once it does and has stopped changing.
 */
export function WidgetEditor({ initial, assets, metricAssets, dashboardRange, timezone, onSave, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const field = (name: string) => `${id}-${name}`;
  const known = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const [dropped] = useState(() => (initial ? initial.config.assets.filter((a) => !known.has(a)).length : 0));
  const [form, setForm] = useState<WidgetForm>(() => {
    if (!initial) return blankForm();
    const loaded = formFromDraft(initial);
    return { ...loaded, assets: loaded.assets.filter((a) => known.has(a)) };
  });
  useDialogFocus(root, onClose, { initial: titleInput });

  const patch = (changes: Partial<WidgetForm>) => setForm((current) => ({ ...current, ...changes }));
  const messages = Object.values(formIssues(form)).filter((m): m is string => m !== undefined);
  const fields = useMemo(() => formToFields(form), [form]);
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

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label={heading} className="dialog">
        <h2>{heading}</h2>
        <div className="editor-cols">
          <div>
            <div className="field">
              <label htmlFor={field("type")}>Type</label>
              <select id={field("type")} value={form.type} onChange={(e) => setForm((f) => withType(f, e.target.value as WidgetType))}>
                {WIDGET_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={field("title")}>Title</label>
              <input id={field("title")} ref={titleInput} value={form.title} maxLength={MAX_TEXT} onChange={(e) => patch({ title: e.target.value })} />
            </div>
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
              <select id={field("range")} value={form.range} onChange={(e) => patch({ range: e.target.value as RangePreset | "" })}>
                <option value="">Use dashboard range</option>
                {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
              </select>
            </div>
            {form.type === "bar" && (
              <div className="field">
                <label htmlFor={field("bars")}>Bars</label>
                <select id={field("bars")} value={form.bars} onChange={(e) => patch({ bars: e.target.value as "asset" | "time" })}>
                  <option value="asset">One bar per asset</option>
                  <option value="time">One bar per time bucket</option>
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
          </div>
          <div>
            <AssetPicker
              assets={offered} tree={assets} notes={notes} selected={form.assets} onChange={(ids) => patch({ assets: ids })}
              single={isSingleAsset(form.type)} max={MAX_ASSETS}
              empty={assets.length > 0 ? `No asset has a mapping for ${form.metric}; choose another metric.` : undefined}
            />
            {dropped > 0 && <p className="muted">{dropped} removed asset{dropped === 1 ? " was" : "s were"} dropped from this widget.</p>}
            <h3>Preview</h3>
            {messages.length > 0 ? (
              <p className="muted">Complete the form to see a preview.</p>
            ) : !settledValid ? (
              <p className="muted">Preparing the preview…</p>
            ) : (
              <div className="widget-preview">
                <WidgetView
                  widgetKey={PREVIEW_KEY} type={settledFields.type} title={settledFields.title} config={settledFields.config}
                  dashboardRange={dashboardRange} timezone={timezone} csv={false} live={false}
                />
              </div>
            )}
          </div>
        </div>
        {messages.length > 0 && <ul className="muted issues">{messages.map((m) => <li key={m}>{m}</li>)}</ul>}
        <div className="row">
          <button type="button" onClick={() => onSave(fields)} disabled={messages.length > 0}>Save widget</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
