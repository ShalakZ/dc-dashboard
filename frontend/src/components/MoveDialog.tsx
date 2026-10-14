import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { keys, loadMovePreview, useInvalidate } from "../api/queries";
import type { Asset, MoveBody, MovePreview, MoveResult } from "../api/types";
import { isStaleMove, rateText, rateWarning } from "../lib/moveText";
import { dropVerdict, moveGroup, toRoots, type DropVerdict, type TreeIndex } from "../lib/treeMove";
import { pickerRows } from "./dashboard/AssetPicker";
import { Modal, useModalBusy } from "./Modal";

// What a failed move or preview means, shared with hooks/useTreeMove.tsx (a drag reads the same failures, in toasts).

export type MoveFailure =
  | { kind: "already" }
  | { kind: "stale" }
  | { kind: "refused" | "other"; text: string };

/**
 * "Already there" is a 422 with an EMPTY `refusals` list and the `unchanged` ids (every asset is where it was asked to go): not a refusal, a no-op.
 * A real 422 says why in `detail` (the first reason, in names); a 409 with `stale` means the tree changed under the person; anything else
 * (the network, a 403) reads as the client's own message.
 */
export function moveFailure(error: unknown): MoveFailure {
  if (error instanceof ApiError) {
    if (error.status === 422) {
      const body = error.body as { refusals?: unknown; unchanged?: unknown } | null | undefined;
      if (Array.isArray(body?.refusals) && body.refusals.length === 0 && Array.isArray(body.unchanged) && body.unchanged.length > 0) return { kind: "already" };
      return { kind: "refused", text: error.message };
    }
    if (isStaleMove(error)) return { kind: "stale" };
  }
  return { kind: "other", text: error instanceof Error ? error.message : String(error) };
}

/** The preview found nothing to do: no root really moves (the server lists those apart, in `unchanged`). A 200 answer that says so, for a server that does not answer 422. */
export const nothingChanges = (preview: MovePreview, roots: readonly number[]): boolean =>
  preview.roots.length === 0 || roots.every((id) => preview.unchanged.includes(id));

const TOP = "top";
type Choice = typeof TOP | number;
/** The most places drawn at once: 2,000 radios would freeze the dialog. A search narrows the list (the rest is not lost, only not drawn). */
const ROW_CAP = 300;
const STALE_HERE = "The tree changed; choose again";
const ALREADY_HERE = "Already there. Choose another place.";

/** One place: a radio labelled with the asset's name only (the reason it cannot be chosen is its description, not part of its name). */
function PlaceRow({ group, label, title, depth, reason, checked, onChoose }: {
  group: string; label: string; title?: string; depth: number; reason?: string; checked: boolean; onChoose: () => void;
}) {
  const reasonId = useId();
  return (
    <div className="place-row" style={{ "--depth": depth } as CSSProperties}>
      <label title={title}>
        <input
          type="radio"
          name={group}
          checked={checked}
          // aria-disabled, not disabled: it stays in the arrow-key order and a screen reader reads why it cannot be chosen. The browser still
          // ticks it on a click or an arrow; the controlled `checked` puts the tick back because nothing is chosen here.
          aria-disabled={reason ? true : undefined}
          aria-describedby={reason ? reasonId : undefined}
          onChange={() => { if (!reason) onChoose(); }}
        />
        <span>{label}</span>
      </label>
      {reason && <span id={reasonId} className="place-reason">{reason}</span>}
    </div>
  );
}

/**
 * Move to...: pick a place for `ids` in a list of every asset (tree order, indented), or "Top level". "Move" asks the server what the move would
 * change INSIDE this dialog (never a second dialog on top: two dialogs fight over focus and Escape): if it changes the rate an asset is billed
 * at, the warning appears in the reserved slot and the same button becomes "Move anyway"; a refusal or a stale tree is told in that slot too.
 * `onMoved` gets the result and closes the dialog (the page then toasts, offers Undo and tells the tree where to put the focus).
 * `onCancel` is Cancel and Escape.
 */
export function MoveDialog({ assets, index, ids, move, onCancel, onMoved }: {
  assets: Asset[];
  /** The whole tree, unfiltered (built once by the page). */
  index: TreeIndex;
  /** What was picked (or the open asset), not yet reduced to roots. */
  ids: readonly number[];
  move: (body: MoveBody) => Promise<MoveResult>;
  onCancel: () => void;
  onMoved: (result: MoveResult) => void;
}) {
  const roots = useMemo(() => toRoots(ids, index), [ids, index]);
  const title =
    roots.length === 0 ? "Move to..." : roots.length === 1 ? `Move "${index.nameOf(roots[0])}" to...` : `Move ${roots.length} assets to...`;
  return (
    <Modal title={title} onClose={onCancel}>
      <MoveForm assets={assets} index={index} roots={roots} move={move} onCancel={onCancel} onMoved={onMoved} />
    </Modal>
  );
}

type Phase = "idle" | "checking" | "moving";

function MoveForm({ assets, index, roots, move, onCancel, onMoved }: {
  assets: Asset[]; index: TreeIndex; roots: number[];
  move: (body: MoveBody) => Promise<MoveResult>; onCancel: () => void; onMoved: (result: MoveResult) => void;
}) {
  const group = useId();
  const invalidate = useInvalidate();
  const places = useMemo(() => pickerRows(assets), [assets]);
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  // The preview the person has seen for `choice` when it changes a rate: pressing the button again moves with ITS `expect`.
  const [warn, setWarn] = useState<{ choice: Choice; preview: MovePreview } | null>(null);
  const [note, setNote] = useState<{ tone: "info" | "error"; text: string } | null>(null); // "already there" is a note, not an error
  useModalBusy(phase === "moving"); // Escape must not close the dialog on a move that is being written (a preview only reads: Escape may leave it)

  const alive = useRef(true);
  useEffect(() => { // set again on mount: a strict-mode double run would otherwise leave it false
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const running = useRef(false);

  const needle = search.trim().toLowerCase();
  const matches = useMemo(() => (needle ? places.filter((p) => p.name.toLowerCase().includes(needle)) : places), [places, needle]);
  const shown = useMemo(() => matches.slice(0, ROW_CAP), [matches]);
  const hidden = matches.length - shown.length;

  // What each drawn place says about this move, worked out when it is first drawn: 300 rows of a 500-root move cost real time.
  const verdicts = useMemo(() => new Map<Choice, DropVerdict>(), [roots, index]);
  const verdictOf = (place: Choice): DropVerdict => {
    let verdict = verdicts.get(place);
    if (!verdict) {
      verdict = dropVerdict({ ids: roots, target: { parent_id: place === TOP ? null : place, before_id: null }, index });
      verdicts.set(place, verdict);
    }
    return verdict;
  };
  const reasonOf = (place: Choice) => {
    const verdict = verdictOf(place);
    return verdict.ok ? undefined : verdict.reason;
  };

  // A place the search has filtered out is not chosen any more: the person always sees where the assets go. (It is chosen again if the search
  // lets it back.) "Top level" is always drawn.
  const picked: Choice | null = choice !== null && (choice === TOP || shown.some((p) => p.id === choice)) && verdictOf(choice).ok ? choice : null;
  const warning = warn !== null && warn.choice === picked ? warn.preview : null;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  const choose = (place: Choice) => {
    if (phase !== "idle" || !verdictOf(place).ok) return;
    setChoice(place);
    setWarn(null);
    setNote(null);
  };

  const fail = (error: unknown, from: "preview" | "move") => {
    if (!alive.current) return;
    const failure = moveFailure(error);
    setWarn(null);
    setPhase("idle");
    if (failure.kind === "already") setNote({ tone: "info", text: ALREADY_HERE });
    else if (failure.kind === "stale") {
      setNote({ tone: "error", text: STALE_HERE });
      // A refused move has already refreshed the lists (the mutation settles that); a refused preview has not.
      if (from === "preview") void invalidate(keys.assets, keys.fleet);
    } else setNote({ tone: "error", text: failure.text });
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    // The button is aria-disabled, not disabled (it may hold the focus): the guard is here, and also stops Enter in a field.
    if (running.current || phase !== "idle" || picked === null) return;
    running.current = true;
    const at = picked;
    const body = { moves: [moveGroup(roots, { parent_id: at === TOP ? null : at, before_id: null })] };
    try {
      let preview = warning;
      if (!preview) {
        setPhase("checking");
        setNote(null);
        try {
          preview = await loadMovePreview(body);
        } catch (error) {
          fail(error, "preview");
          return;
        }
        if (!alive.current) return;
        if (pickedRef.current !== at) { // the person chose elsewhere (or searched the place away) while the server was asked: that answer is for another move
          setPhase("idle");
          return;
        }
        if (nothingChanges(preview, roots)) {
          setPhase("idle");
          setNote({ tone: "info", text: ALREADY_HERE });
          return;
        }
        if (preview.rate_changes) {
          setWarn({ choice: at, preview });
          setPhase("idle");
          return;
        }
      }
      setPhase("moving");
      let result: MoveResult;
      try {
        result = await move({ ...body, expect: preview.expect });
      } catch (error) {
        fail(error, "move");
        return;
      }
      if (alive.current) onMoved(result);
    } finally {
      running.current = false;
    }
  }

  const message = warning
    ? { tone: "warn", text: rateWarning(warning.roots, (rate) => rateText(rate, warning.currency)).message }
    : note;
  const topReason = reasonOf(TOP);
  const label = phase === "checking" ? "Checking..." : warning ? "Move anyway" : "Move";

  return (
    <form onSubmit={submit}>
      <label>Search places
        {/* Enter here must not move anything: a person refining the search who presses Enter would otherwise write the move to a place chosen earlier. */}
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} autoComplete="off" />
      </label>
      {/* A box of a FIXED height: a search that thins the list must not resize the dialog or move its buttons. */}
      <div className="place-list">
        <div role="radiogroup" aria-label="Places">
          <PlaceRow group={group} label="Top level" depth={0} reason={topReason} checked={picked === TOP} onChoose={() => choose(TOP)} />
          {shown.map((p) => (
            <PlaceRow
              key={p.id}
              group={group}
              label={p.label}
              title={p.parentPath ? `${p.parentPath} / ${p.name}` : p.name}
              depth={p.depth}
              reason={reasonOf(p.id)}
              checked={picked === p.id}
              onChoose={() => choose(p.id)}
            />
          ))}
        </div>
        {hidden > 0 && <p className="place-more">Keep typing to narrow the list</p>}
        {needle !== "" && matches.length === 0 && <p className="place-more">No place matches</p>}
      </div>
      {/* The slot is always there (3 lines): the warning or the refusal lands in it without moving the buttons. One polite announcer, no role. */}
      <div className="place-message" aria-live="polite" data-tone={message?.tone}>{message?.text}</div>
      <div className="row">
        <button type="button" className="place-cancel" onClick={() => { if (phase !== "moving") onCancel(); }} aria-disabled={phase === "moving" ? true : undefined}>Cancel</button>
        <button type="submit" className="primary place-go" aria-disabled={picked === null || phase !== "idle" ? true : undefined} aria-busy={phase !== "idle" ? true : undefined}>{label}</button>
      </div>
    </form>
  );
}
