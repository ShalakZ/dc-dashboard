import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api/client";
import { useInvalidate } from "../api/queries";
import type { SourceMoveDone, SourceMovePreview } from "../api/types";
import { useDialogFocus } from "../hooks/useDialogFocus";
import {
  addressOptions, effectLines, fromToLine, hostNameLine, isChangedSincePreview, MOVE_REFRESHED, moveButtonLabel, moveRequest, previewMove, runMove,
  SCAN_RUNNING_TEXT, tickLabel, warningLines, whyLines,
} from "../lib/moves";
import { upperFirst } from "../lib/upperFirst";

/** How often the dialog asks again while a scan is queued or running (the real run is refused until the scan has finished). */
const RECHECK_MS = 5_000;

type Address = "as_found" | "name";
interface Message { tone: "info" | "error"; text: string }

export interface MoveSourceDialogProps {
  /** The old source, the one that stopped answering and keeps its mappings, and the name the dialog shows for it (a snapshot: the list is replaced every 10 s). */
  oldId: number;
  oldName: string;
  /** The new source the scan found at the new address; it is removed by the move. */
  newId: number;
  /** The parent can keep the dialog mounted and show it only while `open` is true (the default). A closed dialog is not in the page at all, and an open one starts afresh. */
  open?: boolean;
  /** Cancel, Escape (never while the move is running) and nothing else: the backdrop does not close it. */
  onClose: () => void;
  /** The move has happened and the lists are read again. The parent closes the dialog and says so (the toast). */
  onDone: (result: SourceMoveDone) => void;
  /** Where the focus goes when the dialog goes away; without it, what had the focus when the dialog opened (if it is still in the page). */
  returnFocusTo?: () => HTMLElement | null;
  /** Milliseconds between two dry runs while a scan runs (tests shorten it). */
  recheckMs?: number;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

const WarnIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);

/**
 * Move a source to the address where its device turned up (w33): the old source O keeps its points, mappings and readings; only its address changes, and the
 * duplicate the scan made for the new address goes. Opened from the Sources row menu and banner, and from the Discovery card (the parent mounts it with the
 * two ids). On open it asks the server for a preview (a dry run, nothing is written) and shows everything that will happen: from where to where, why the two
 * are thought to be one server, what else changes, a warning about addresses the new server lacks, and, when the match is not certain, a box that must be
 * ticked. Move works only on the preview of the choice on screen NOW, and it sends back the numbers and texts the preview showed: the server refuses in
 * words if anything differs by then (and a refusal of that kind asks for the preview again).
 *
 * When the new address has a Docker name the choice is the name (the default) or the address. The first preview is always for the address the scan found;
 * if it carries a name the dialog asks again with the name, and shows nothing until it has the preview it will use.
 *
 * Frame as in HistoryFillDialog: portaled, `useDialogFocus` (focus on Cancel, Tab wraps, Escape closes only this dialog and never mid-move), `type="button"`
 * everywhere, buttons that wait use aria-disabled (the focus may be on one), one live region (a message slot of a fixed height, so no line arriving moves the
 * buttons) and the page behind is inert while it is open.
 */
export function MoveSourceDialog({ open = true, ...rest }: MoveSourceDialogProps) {
  return open ? <MoveDialogBody {...rest} /> : null;
}

function MoveDialogBody({ oldId, oldName, newId, onClose, onDone, returnFocusTo, recheckMs = RECHECK_MS }: Omit<MoveSourceDialogProps, "open">) {
  const invalidate = useInvalidate();
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const titleId = `${ids}-title`;
  const statusId = `${ids}-status`;
  const bodyId = `${ids}-body`;

  const [address, setAddress] = useState<Address>("as_found");
  const [preview, setPreview] = useState<SourceMovePreview | null>(null);
  const [foundHost, setFoundHost] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const alive = useRef(true);
  const running = useRef(false);
  const latest = useRef(0); // the number of the newest dry run: an older answer arriving later is dropped
  const picked = useRef(false); // the person (or a fallback) has decided the address: the name is no longer the default
  const lastMatch = useRef("");
  const keep = useRef({ onClose, onDone, returnFocusTo });
  keep.current = { onClose, onDone, returnFocusTo };
  // What had the focus when the dialog was asked for, read while rendering: a page that locks its controls while a dialog is open makes the browser drop the
  // focus of the menu item that opened it before any effect runs.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));

  const requestClose = () => { if (!running.current) keep.current.onClose(); };
  useDialogFocus(root, requestClose, { busy: moving, initial: cancel });

  // The page behind is inert while the dialog is open (the shell and the skip link, never the toast stack, which is a sibling). Declared after useDialogFocus on
  // purpose: that hook saves the opener and moves the focus in first. On the way out the page comes back first, and only then can the focus go back to the opener.
  useEffect(() => {
    const made = Array.from(document.querySelectorAll<HTMLElement>(".shell, .skip-link")).filter((el) => !el.hasAttribute("inert"));
    for (const el of made) el.setAttribute("inert", "");
    return () => {
      for (const el of made) el.removeAttribute("inert");
      const target = keep.current.returnFocusTo?.() ?? opener;
      if (target?.isConnected && target !== document.activeElement) target.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per open; the callbacks are read from `keep`

  /**
   * Ask the server what the move would do for this choice of address. `quiet` (the re-check while a scan runs) leaves the screen as it is until the answer
   * comes. `note` is a sentence to show once the answer is in (the reason for asking again). `auto` marks the dialog's own request for the name.
   */
  async function load(want: Address, options: { quiet?: boolean; note?: Message; auto?: boolean } = {}) {
    const mine = ++latest.current;
    if (!options.quiet) {
      setLoading(true);
      setMessage(null);
    }
    try {
      const got = await previewMove(oldId, { to: newId, address: want });
      if (!alive.current || mine !== latest.current) return;
      if (want === "as_found") setFoundHost(got.to.host);
      if (want === "as_found" && got.name_hint && !picked.current) {
        picked.current = true; // the default is applied once
        setAddress("name");
        void load("name", { ...options, auto: true });
        return;
      }
      const matchKey = JSON.stringify(got.match);
      if (matchKey !== lastMatch.current) setTicked(false); // a tick belongs to the match it was made for
      lastMatch.current = matchKey;
      setAddress(want);
      setPreview(got);
      setMessage(options.quiet ? null : options.note ?? null);
      setLoading(false);
    } catch (error) {
      if (!alive.current || mine !== latest.current) return;
      if (options.auto) { // the name could not be used after all: carry on with the address the scan found
        picked.current = true;
        setAddress("as_found");
        void load("as_found", { ...options, auto: false });
        return;
      }
      setPreview(null);
      setMessage({ tone: "error", text: stop(upperFirst(reasonOf(error))) });
      setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load("as_found");
    return () => { alive.current = false; latest.current += 1; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per open

  // While a scan is queued or running the real run would be refused: ask again now and then, so that Move comes alive by itself when the scan has finished.
  useEffect(() => {
    if (!preview?.scan_running || moving || loading) return;
    const timer = window.setTimeout(() => void load(preview.address, { quiet: true }), recheckMs);
    return () => window.clearTimeout(timer);
  }, [preview, moving, loading, recheckMs]); // eslint-disable-line react-hooks/exhaustive-deps -- `load` only reads refs and setters

  function choose(value: Address) {
    if (running.current || value === address) return;
    picked.current = true;
    setAddress(value);
    void load(value);
  }

  const tick = preview ? tickLabel(preview) : null;
  const ready = preview !== null && !loading && !moving && !preview.scan_running && (tick === null || ticked);

  async function move() {
    if (running.current || preview === null || loading || preview.scan_running) return; // a scan running is already said in the message slot
    if (tick !== null && !ticked) {
      setMessage({ tone: "error", text: "Tick the box to confirm before you move." });
      return;
    }
    const request = moveRequest(preview);
    running.current = true;
    setMoving(true);
    setMessage(null);
    let done: SourceMoveDone | null = null;
    let refusal: unknown = null;
    try {
      done = await runMove(oldId, request);
    } catch (error) {
      refusal = error;
    } finally {
      // The lists are out of date after a refusal too (a 409 means somebody else changed something). Before the person is told: their view must already be right.
      try { await invalidate(...MOVE_REFRESHED); } catch { /* the lists fetch themselves again on their next visit */ }
      running.current = false;
    }
    if (done !== null) {
      if (alive.current) setMoving(false);
      keep.current.onDone(done);
      return;
    }
    if (!alive.current) return;
    setMoving(false);
    const text = stop(upperFirst(reasonOf(refusal)));
    if (refusal instanceof ApiError && refusal.status === 409) {
      // Something changed under the dialog (a scan started, the counts moved, the new name differs): ask again, so what is on screen is true, and say why.
      const changed = isChangedSincePreview(refusal);
      if (changed) setTicked(false);
      void load(preview.address, { note: { tone: "error", text: changed ? `${text} The preview is updated: check it and press Move again.` : text } });
      return;
    }
    setMessage({ tone: "error", text });
  }

  const options = preview ? addressOptions(preview, foundHost) : [];
  const nameLine = preview ? hostNameLine(preview) : null;
  const status = moving
    ? "Moving the source..."
    : loading ? "Checking what the move would do..."
    : message?.text ?? (preview?.scan_running ? SCAN_RUNNING_TEXT : "");

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog move-source">
        <h2 id={titleId}>{`Move to new address: ${oldName}`}</h2>
        <p className="muted">A scan found a server at a new address that looks like this one. Nothing changes until you press Move.</p>

        <div id={bodyId} className="move-body" aria-busy={loading || moving ? true : undefined}>
          {preview !== null && (
            <>
              <p className="move-fromto">{fromToLine(preview)}</p>
              {nameLine !== null && <p>{nameLine}</p>}
              {options.length > 0 && (
                <div role="radiogroup" aria-label="Address to use" className="move-choice">
                  {options.map((o) => (
                    <label key={o.value} className="inline move-radio">
                      <input type="radio" name={`${ids}-address`} value={o.value} checked={address === o.value} disabled={moving} onChange={() => choose(o.value)} />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {whyLines(preview).map((line) => <p key={line}>{line}</p>)}
              <ul className="move-list">{effectLines(preview).map((line) => <li key={line}>{line}</li>)}</ul>
              {warningLines(preview).map((line) => (
                <p key={line} className="move-warn"><WarnIcon /><span>{line}</span></p>
              ))}
              {tick !== null && (
                <label className="inline move-tick">
                  <input type="checkbox" checked={ticked} disabled={moving} onChange={(event) => { setTicked(event.target.checked); setMessage(null); }} />
                  {tick}
                </label>
              )}
            </>
          )}
        </div>

        {/* The message line and the buttons are one footer that sticks to the bottom of the dialog, so a refusal is never hidden under the buttons in a short window. */}
        <div className="move-foot">
          <div id={statusId} className="move-status" aria-live="polite" aria-atomic="true" data-tone={message?.tone === "error" && !loading && !moving ? "error" : undefined}>{status}</div>
          <div className="row">
            <button type="button" ref={cancel} className="move-cancel" aria-disabled={moving ? true : undefined} onClick={requestClose}>Cancel</button>
            <button type="button" className="primary move-go" aria-disabled={ready ? undefined : true} aria-describedby={statusId} onClick={() => void move()}>
              {moveButtonLabel(preview?.mappings ?? null)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
