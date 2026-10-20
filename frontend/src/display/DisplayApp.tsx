import { Component, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import "../styles/display-screen.css";
import { BACKOFF_CAP_MS, BACKOFF_START_MS, realTimers, startDisplay, type DisplayState, type Timers } from "./displayLoop";
import type { SecretHandle } from "./secretHandle";

// The display screen (w28's minimal page; w29 puts the rotating dashboards in its place). It runs OUTSIDE the app: no AuthProvider, no
// query client, no router, no shell and no /api/me. main.tsx has already taken the secret from the address (takeFragment) and hands
// in a handle on it (never the string: the claim releases it at the first definite answer); the page's one job is to say, in large
// type, whether this screen is connected.

const OFFLINE = "Cannot reach the server. Trying again...";

function sentence(state: DisplayState): string {
  switch (state.kind) {
    case "connecting":
      return "Connecting...";
    case "connected": {
      const dashboards = `${state.dashboards} ${state.dashboards === 1 ? "dashboard" : "dashboards"}`;
      const skipped = state.skipped > 0 ? ` (${state.skipped} skipped)` : "";
      return `Connected as ${state.displayName}. Playlist ${state.playlistName}: ${dashboards}${skipped}. The rotating screen arrives in the next update.`;
    }
    case "notConnected":
      return "This screen is not connected. Open its display link once.";
    case "revoked":
      return "This display link was revoked or is not valid. Ask an administrator for a new link.";
    case "blocked":
      return "Too many wrong links from this address. Try again in about 15 minutes.";
    case "offline":
      return OFFLINE;
  }
}

/** The whole screen: one dark box, one live region. The same box for every state, so nothing jumps when the sentence changes. */
function Message({ text, quiet = false }: { text: string; quiet?: boolean }) {
  return (
    <div className="display-screen">
      <p className={quiet ? "display-screen-text display-screen-quiet" : "display-screen-text"} aria-live="polite">
        {text}
      </p>
    </div>
  );
}

interface Props {
  /** A handle on the secret main.tsx took from the address, or null (no link was opened: the cookie may already be there). The claim releases it. */
  handle: SecretHandle | null;
  /** The clock; tests move it by hand. */
  timers?: Timers;
}

function DisplayScreen({ handle, timers }: Props) {
  const [state, setState] = useState<DisplayState>({ kind: "connecting" });
  useEffect(() => startDisplay(handle, setState, { timers }), [handle, timers]);
  return <Message text={sentence(state)} quiet={state.kind === "connecting"} />;
}

/**
 * A render error must never leave a blank screen on a wall: say the usual "cannot reach" sentence and mount the screen again after a
 * wait that doubles from 5 to 60 seconds. Nothing is logged here, and the screen's state (including a claim already made) is kept
 * out of the tree that failed, so a retry does not claim twice.
 */
export class DisplayBoundary extends Component<{ children: ReactNode; timers?: Timers }, { failed: boolean }> {
  state = { failed: false };
  private failures = 0;
  private handle: unknown = null;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    const timers = this.props.timers ?? realTimers;
    const wait = Math.min(BACKOFF_START_MS * 2 ** this.failures, BACKOFF_CAP_MS);
    this.failures += 1;
    this.handle = timers.set(() => {
      this.handle = null;
      this.setState({ failed: false });
    }, wait);
  }

  componentWillUnmount() {
    if (this.handle !== null) (this.props.timers ?? realTimers).clear(this.handle);
  }

  render() {
    return this.state.failed ? <Message text={OFFLINE} /> : this.props.children;
  }
}

export function DisplayApp({ handle, timers }: Props) {
  // Here, outside the boundary, so that even the fallback sentence is on a dark screen: this page has no AppearanceProvider and is dark in
  // every theme. A layout effect runs before the first paint, so the screen is never light for a frame.
  useLayoutEffect(() => {
    document.title = "Display";
    document.documentElement.setAttribute("data-mode", "dark");
  }, []);
  return (
    <DisplayBoundary timers={timers}>
      <DisplayScreen handle={handle} timers={timers} />
    </DisplayBoundary>
  );
}
