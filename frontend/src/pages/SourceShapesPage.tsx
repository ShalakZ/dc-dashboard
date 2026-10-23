import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useInvalidate, keys } from "../api/queries";
import { getShapeRules, putShapeRules, SEARCH_MAX, useShapes, type Shape, type ShapeDecision, type ShapesAnswer } from "../api/shapes";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { Icon, type IconName } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
import { PageHeader } from "../components/PageHeader";
import { ReviewShapesDialog } from "../components/shapes/ReviewShapesDialog";
import { ShapeRow } from "../components/shapes/ShapeRow";
import { useToast } from "../components/Toasts";
import { PAGE_NEED } from "../components/navItems";
import { PageHeaderSkeleton, SkeletonRegion, TableSkeleton, TilesSkeleton } from "../components/Skeleton";
import { assetLabels, assetOptions } from "../lib/pickerRows";
import type { Timers } from "../lib/progress";
import {
  barNote, chosenShapes, choiceOf, coveredTags, decide, decisionBody, grouped, matchSentence, mergeRules, NO_DECISIONS, plural, presetFromRules, readLink, reviewIsInert, reviewLabel,
  rowOf, searchTerm, similarSentence, splitSections, tick, wantsRules, withoutRule, type Decisions,
} from "../lib/shapes";

/** How long the search box waits after the last key before it asks the server. */
const SEARCH_WAIT_MS = 300;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function Tile({ icon, title, value, tip }: { icon: IconName; title: string; value: number; tip: string }) {
  return (
    <div className="tile">
      {/* each tip is named after its tile ("About Shapes"), so a list of buttons tells them apart */}
      <div className="muted"><span className="tile-label"><Icon name={icon} /><span>{title}</span></span><InfoTip label={`About ${title}`}>{tip}</InfoTip></div>
      <div className="big">{grouped(value)}</div>
    </div>
  );
}

/**
 * Map a large source by the SHAPE of its tags (w36). The server groups the tags of a source into a few dozen shapes (a tag name with its numbers replaced by #);
 * a person decides about a shape, billing first, instead of about thousands of points. Every row starts at Ignore. The shapes, the billing labels and the asset
 * names are guesses made from the tag text, and the page says so. Nothing is written here: Review shows what the decisions would map (the server's lines and
 * checks, then the tag list planner's dry run), and Map goes through the existing tag-list route, with its Undo.
 *
 * The page needs discovery.view and nothing else (the answer carries the source's name and its assets); deciding needs discovery.accept, without it every
 * decision is read-only text and there is no Review button. `timers` lets a test move the 300 ms of the search box by hand.
 */
export function SourceShapesPage({ timers = realTimers }: { timers?: Timers } = {}) {
  const sourceId = Number(useParams().id);
  // Keyed by the source: the decisions and the shapes seen belong to one source, and the page component is reused when only the address's id changes.
  return <ShapesBody key={sourceId} sourceId={sourceId} timers={timers} />;
}

function ShapesBody({ sourceId, timers }: { sourceId: number; timers: Timers }) {
  const { can } = useAuth();
  const canDecide = can("discovery.accept");
  const canPoints = meets(PAGE_NEED.sourcePoints, can);
  const [params, setParams] = useSearchParams();
  const [start] = useState(() => ({ ...readLink(params), rules: wantsRules(params) })); // `rules`: opened to review the new tags that match the saved rules (?rules=1)
  const invalidate = useInvalidate();
  const toast = useToast();

  // The search: what is typed, what the server was last asked (after the wait; the address's own search is applied at once), and the shape to look at.
  const [text, setText] = useState(start.q);
  const [term, setTerm] = useState(() => searchTerm(start.q));
  const [focusKey, setFocusKey] = useState(start.focus);
  const [focusTick, setFocusTick] = useState(0);
  const focused = useRef("");
  useEffect(() => {
    const next = searchTerm(text);
    if (next === term) return;
    const handle = timers.set(() => { setTerm(next); setFocusKey(""); }, SEARCH_WAIT_MS);
    return () => timers.clear(handle);
  }, [text, term, timers]);
  useEffect(() => {
    const next = new URLSearchParams();
    if (term !== "") next.set("q", term);
    if (focusKey !== "") next.set("focus", focusKey);
    if (start.rules) next.set("rules", "1"); // a reload asks for the same preset (rows with nothing left to decide are not preset)
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [term, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps -- writes the address; reading it again would loop

  const { data, error, isFetchedAfterMount } = useShapes(sourceId, term);

  // The page opened with a search and no shape to look at (the Find option of the Discovery canvas): the focus goes into Search tags, which holds the query. Once.
  const searchBox = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(start.q !== "" && start.focus === "");
  useEffect(() => {
    if (!focusSearch.current || data === undefined) return;
    focusSearch.current = false;
    searchBox.current?.focus({ preventScroll: true });
  }, [data]);

  // The bottom bar sticks to the bottom edge, and so does the toast stack: the room under the bar's top edge is published as --bottom-bar-h (feedback-toasts.css lifts the stack
  // by it), so a toast (with its Undo) never covers the bar's controls. While the bar is stuck that is its height; at the end of the page it is not stuck (it ends above the
  // room main keeps for a settled toast), so the distance is measured from its top edge to the window's bottom, again on every scroll and resize. A bar above or below the window
  // covers nothing: 0. The bar exists once the first answer is in and only for a role that can decide. Taken away when the page goes.
  const bar = useRef<HTMLDivElement>(null);
  const hasBar = canDecide && data !== undefined;
  useEffect(() => {
    const el = bar.current;
    if (!hasBar || el === null) return;
    const rootStyle = document.documentElement.style;
    let published = "";
    const measure = () => {
      const { top, bottom } = el.getBoundingClientRect();
      const room = bottom <= 0 || top >= window.innerHeight ? 0 : Math.ceil(window.innerHeight - top);
      const next = `${room}px`;
      if (next === published) return; // a scroll fires often; the document's styles are touched only when the value moves
      published = next;
      rootStyle.setProperty("--bottom-bar-h", next);
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      watcher.disconnect();
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      rootStyle.removeProperty("--bottom-bar-h");
    };
  }, [hasBar]);

  // Every shape the page has been shown, by key: a decision outlives a search that no longer lists its row, and still needs its tag count and its label.
  const [seen, setSeen] = useState<{ answer: ShapesAnswer | null; shapes: ReadonlyMap<string, Shape> }>({ answer: null, shapes: new Map() });
  if (data !== undefined && seen.answer !== data) {
    const merged = new Map(seen.shapes);
    for (const shape of data.shapes) merged.set(shape.key, shape);
    setSeen({ answer: data, shapes: merged });
  }
  const known = seen.shapes;
  const similarOf = (key: string) => (known.get(key)?.similar ?? []).filter((other) => known.has(other));
  const labelOf = (key: string) => known.get(key)?.label ?? key;

  const [decisions, setDecisions] = useState<Decisions>(NO_DECISIONS);
  const chosen = chosenShapes(decisions, known);
  const covered = coveredTags(chosen);
  const inert = reviewIsInert(chosen.length, covered); // nothing chosen, nothing left to map, or more shapes than one review takes
  const [parentChoice, setParentChoice] = useState<number | null>(null);
  const [createAssets, setCreateAssets] = useState(true);
  const [review, setReview] = useState<{ decisions: ReturnType<typeof decisionBody>; parentId: number | null; createAssets: boolean } | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [restOpen, setRestOpen] = useState(false);

  // ?rules=1: ONCE, on the first answer READ AFTER THE PAGE OPENED, every row that has a saved rule and tags still to decide about is set to its rule (still shown, still
  // changeable, still only through Review and Map). A cached answer from an earlier visit is shown at once but does not count: it may still say the rows are mapped (the
  // visit before ended with a Map), and the preset would be spent on it. A later answer (a search, a refresh) never presets again. A closed section that holds a preset
  // row is opened. A role that cannot decide gets nothing: its decisions would be text nobody can act on.
  const presetPending = useRef(start.rules);
  useEffect(() => {
    if (!presetPending.current || data === undefined || !isFetchedAfterMount || !canDecide) return;
    presetPending.current = false;
    const preset = presetFromRules(data.shapes);
    if (preset === NO_DECISIONS) return;
    setDecisions(preset);
    if (data.shapes.some((shape) => shape.billing === null && preset.choices[shape.key] !== undefined)) setRestOpen(true);
  }, [data, isFetchedAfterMount, canDecide]);

  /**
   * The Map worked: remember the decisions as the source's rules. The server's rules are read NOW and the decided keys replaced in them, because the PUT replaces the
   * whole set and this page only knows the rules of the rows it was shown (a search, the 300-row cap). Silent; a failure is one info toast beside the success toast.
   */
  async function remember(applied: ShapeDecision[]) {
    try {
      const { rules } = await getShapeRules(sourceId);
      await putShapeRules(sourceId, mergeRules(rules, applied));
    } catch {
      toast.info("The mapping was done; the rules could not be saved.");
      return;
    }
    try { await invalidate(keys.sources, keys.graph); } catch { /* the rows show the rule on their next read */ }
  }
  // Forget this rule: the server's rules again, without that key. One at a time; the focus goes to the row (its button is about to go).
  const [forgetting, setForgetting] = useState<string | null>(null);
  async function forget(shape: Shape) {
    if (forgetting !== null) return;
    setForgetting(shape.key);
    try {
      const { rules } = await getShapeRules(sourceId);
      await putShapeRules(sourceId, withoutRule(rules, shape.key));
      await invalidate(keys.sources, keys.graph);
      if (root.current !== null) rowOf(root.current, shape.key)?.focus({ preventScroll: true });
    } catch (error) {
      toast.error(`The rule could not be forgotten: ${reasonOf(error)}`);
    } finally {
      setForgetting(null);
    }
  }

  const assets = useMemo(() => (data?.assets ?? []).map((asset) => ({ ...asset, sort_order: 0 })), [data?.assets]);
  const parentId = parentChoice !== null && assets.some((asset) => asset.id === parentChoice) ? parentChoice : null;
  const parentLabels = useMemo(() => assetLabels(assets), [assets]);
  const parentOptions = useMemo(() => assetOptions(assets), [assets]);

  // A search hit or a deep link: open the section the row is in, then put the focus on the row once (a later refresh of the list does not take it back).
  useEffect(() => {
    if (focusKey === "" || data === undefined || focused.current === focusKey) return;
    if (data.shapes.some((shape) => shape.key === focusKey && shape.billing === null) && !restOpen) {
      setRestOpen(true);
      return;
    }
    const row = root.current === null ? null : rowOf(root.current, focusKey);
    if (row === null) return;
    focused.current = focusKey;
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
  }, [focusKey, focusTick, data, restOpen]);
  const show = (key: string) => {
    focused.current = "";
    setFocusKey(key);
    setFocusTick((n) => n + 1);
  };

  // The dialog closed: the focus goes back to the button that opened it. The dialog restores it itself when it can; this covers a browser that gave the button
  // no focus to give back. It runs after the dialog has gone (a focus moved earlier would be pulled back into the dialog), and only if nothing else holds it.
  const reviewing = review !== null;
  const wasReviewing = useRef(false);
  useEffect(() => {
    if (wasReviewing.current && !reviewing) {
      const at = document.activeElement;
      if (at === null || at === document.body) reviewButton.current?.focus({ preventScroll: true });
    }
    wasReviewing.current = reviewing;
  }, [reviewing]);
  const closeReview = () => setReview(null);
  const openReview = () => {
    if (inert || review !== null) return;
    setReview({ decisions: decisionBody(chosen), parentId, createAssets });
  };

  if (data === undefined) {
    if (error) return <p className="error" role="alert">{error.message}</p>;
    return (
      <SkeletonRegion label="Loading shapes">
        <PageHeaderSkeleton crumbs />
        <TilesSkeleton count={4} />
        <TableSkeleton columns={4} rows={6} />
      </SkeletonRegion>
    );
  }

  const { billing, rest } = splitSections(data.shapes);
  const restPoints = rest.reduce((sum, shape) => sum + shape.count, 0);
  const billingPoints = billing.reduce((sum, shape) => sum + shape.count, 0);
  const row = (shape: Shape) => {
    const similar = similarOf(shape.key);
    return (
      <ShapeRow
        key={shape.key} shape={shape} choice={choiceOf(decisions, shape.key)} canDecide={canDecide}
        similarText={similar.length > 0 ? similarSentence(similar, labelOf) : null} ticked={decisions.ticks[shape.key] === true}
        highlighted={focusKey === shape.key} forgetting={forgetting === shape.key} onForget={canDecide ? () => void forget(shape) : undefined}
        onChoice={(patch) => setDecisions((current) => decide(current, shape.key, patch, similarOf))}
        onTick={(on) => setDecisions((current) => tick(current, shape.key, on, similarOf))}
      />
    );
  };

  const matches = term !== "" ? data.matches : undefined;
  const live = term !== "" && matches !== undefined ? matchSentence(matches.count, term, data.shapes.length) : "";
  const note = barNote(chosen.length, covered);

  return (
    <div className="shapes-page" ref={root}>
      <PageHeader
        title={`${data.source_name}: map by tag shape`}
        crumbs={[{ label: "Discovery", to: "/discovery" }, { label: data.source_name }]}
        headingRef={heading}
      />
      {error && <p className="error" role="alert">{error.message}</p>}
      <p className="shapes-guess">
        {"Every shape, billing label and asset name on this page is a guess made from the tag text: check the examples before you map. "}
        {canDecide ? "Nothing is mapped until you press Review and then Map, and a map can be undone." : "Your role can look at the shapes but not map them."}
      </p>

      <div className="tiles shape-tiles">
        <Tile icon="database" title="Points" value={data.points} tip="Every tag the last browse found on this source." />
        <Tile
          icon="layers" title="Shapes" value={data.shapes_total}
          tip="A shape is a tag name with its numbers replaced by #: PDUA01_PM0_PENRG and PDUA02_PM0_PENRG are one shape, PDUA#_PM0_PENRG. Only names that repeat make a shape."
        />
        <Tile icon="assets" title="Mapped" value={data.mapped} tip="Tags that already belong to an asset." />
        <Tile icon="readings" title="Other tags" value={data.other_tags} tip="Tags with no repeating pattern: no other tag looks like them, so they are in no shape." />
      </div>

      <div className="shapes-search">
        <input
          ref={searchBox} type="search" aria-label="Search tags" placeholder="Search tags" value={text} maxLength={SEARCH_MAX}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <p className="shapes-live muted" role="status">{live}</p>
      {matches !== undefined && matches.first.length > 0 && (
        <ul className="shapes-matches" aria-label="Matching tags">
          {matches.first.map((match, i) => (
            <li key={`${i}-${match.address}`}>
              {match.shape !== null ? (
                <>
                  <button type="button" onClick={() => show(match.shape!)}>{match.name}</button>
                  <span className="muted">{` is in ${labelOf(match.shape)}`}</span>
                </>
              ) : (
                <>
                  <span title={match.address}>{match.name}</span>
                  <span className="muted"> is in no shape (see Other tags)</span>
                </>
              )}
            </li>
          ))}
          {matches.count > matches.first.length && <li className="muted">{`and ${grouped(matches.count - matches.first.length)} more`}</li>}
        </ul>
      )}
      {term !== "" && data.shapes.length === 0 && <p className="muted">{`No shape has a tag that matches "${term}".`}</p>}

      <div className="shapes-section">
        <h2>Suggested for billing</h2>
        <p className="muted shapes-count">
          {billing.length === 0 ? "No shape looks like an energy counter or a power reading." : `${plural(billing.length, "shape")}, ${plural(billingPoints, "tag")}. Counters first, then power.`}
        </p>
        {billing.length > 0 && <div className="shapes-rows">{billing.map(row)}</div>}
      </div>

      {rest.length > 0 && (
        <div className="shapes-section">
          <button type="button" className="shapes-disclosure" aria-expanded={restOpen} aria-controls="shapes-rest" onClick={() => setRestOpen(!restOpen)}>
            <Icon name="chevron" />
            {`Not needed for billing (${plural(restPoints, "point")})`}
          </button>
          {restOpen && <div id="shapes-rest" className="shapes-rows">{rest.map(row)}</div>}
        </div>
      )}

      {data.more_shapes > 0 && <p className="muted">{`+ ${grouped(data.more_shapes)} more shapes. Use Search tags to find them.`}</p>}

      {data.other_tags > 0 && (
        <p className="shapes-other">
          <strong>{`Other tags (${grouped(data.other_tags)})`}</strong>
          {": no repeating pattern. "}
          {data.other_examples.length > 0 && `For example ${data.other_examples.map((example) => example.name).join(", ")}. `}
          {canPoints && <Link to={`/sources/${sourceId}/points`}>See them on the Points page</Link>}
        </p>
      )}

      {canDecide && (
        <div className="shapes-bar" ref={bar}>
          <div className="shapes-bar-go">
            <button
              ref={reviewButton} type="button" className="primary" aria-disabled={inert ? true : undefined}
              aria-describedby="shapes-bar-note" onClick={openReview}
            >
              {reviewLabel(covered)}
            </button>
          </div>
          <div className="shapes-bar-field">
            <label htmlFor="shapes-parent">Put new assets under</label>
            <select id="shapes-parent" value={parentId ?? ""} onChange={(event) => setParentChoice(event.target.value === "" ? null : Number(event.target.value))}>
              <option value="">(top level)</option>
              {parentOptions.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
            </select>
          </div>
          <label className="shapes-bar-check">
            <input type="checkbox" checked={createAssets} onChange={(event) => setCreateAssets(event.target.checked)} />
            Create missing assets
          </label>
          <p id="shapes-bar-note" className="muted shapes-bar-note" title={note}>{note}</p>
        </div>
      )}

      {review !== null && (
        <ReviewShapesDialog
          sourceId={sourceId} sourceName={data.source_name} decisions={review.decisions} parentId={review.parentId}
          parentLabel={review.parentId === null ? null : (parentLabels.get(review.parentId) ?? null)} createAssets={review.createAssets}
          labelOf={labelOf} onClose={closeReview}
          onMapped={() => { void remember(review.decisions); setDecisions(NO_DECISIONS); }}
        />
      )}
    </div>
  );
}
