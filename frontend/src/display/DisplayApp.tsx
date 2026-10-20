import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "../styles/display-screen.css";
import { installChunkReload, reloadIfServerAnswers } from "../lib/chunkReload";
import { widgetData } from "./displayApi";
import { BACKOFF_CAP_MS, BACKOFF_START_MS, realTimers, startDisplay, type DisplayLoop, type DisplayState, type Timers } from "./displayLoop";
import type { SecretHandle } from "./secretHandle";
import { installWakeEvents } from "./wakeEvents";
import { useWakeLock } from "./wakeLock";
import { createWall } from "./wallController";
import { WallScreen } from "./WallScreen";

// The display screen. It runs OUTSIDE the app: no AuthProvider, no query client, no router, no shell and no /api/me. main.tsx has already
// taken the secret from the address (takeFragment) and hands in a handle on it (never the string: the claim releases it at the first definite
// answer). While the screen is not connected it says so, in large type; once connected it shows the wall (the rotating dashboards), which is
// fed every playlist the loop reads and makes no request of its own but `/api/display/*` (displayApi).

const OFFLINE = "Cannot reach the server. Trying again...";

function sentence(state: Exclude<DisplayState, { kind: "connected" }>): string {
  switch (state.kind) {
    case "connecting":
      return "Connecting...";
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
  /** The clock of the claim and the playlist poll; tests move it by hand. */
  timers?: Timers;
  /** The wall's own clock (rotation, widget requests, wake heartbeat, cursor); real timers by default, tests move it by hand. */
  wallTimers?: Timers;
}

function DisplayScreen({ handle, timers, wallTimers }: Props) {
  const [state, setState] = useState<DisplayState>({ kind: "connecting" });
  const wallClock = wallTimers ?? realTimers;
  // The loop's stop function, with its refresh(): the wall asks for a playlist read through it (it does nothing unless the loop is connected).
  const stopRef = useRef<DisplayLoop | null>(null);
  // One wall for the life of this screen: the loop feeds it, the view draws it.
  const [wall] = useState(() =>
    createWall({
      timers: wallClock,
      fetchWidget: widgetData,
      refreshPlaylist: () => stopRef.current?.refresh(),
      reload: () => void reloadIfServerAnswers(),
      reduceMotion: () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      isHidden: () => document.hidden,
    }),
  );
  // The wall runs only while the page shows it: behind the "revoked" sentence it makes no request (a stopped wall keeps its state and starts again with the next good read).
  const showing = state.kind === "connected";
  useEffect(() => {
    if (!showing) return;
    wall.start();
    return () => wall.stop();
  }, [wall, showing]);
  useEffect(() => {
    const stop = startDisplay(handle, setState, { timers });
    stopRef.current = stop;
    return () => {
      stopRef.current = null;
      stop();
    };
  }, [handle, timers]);
  // Every good read is a new connected state: the wall takes the playlist, the time it arrived and the server's clock.
  useEffect(() => {
    if (state.kind === "connected") wall.feed(state.reply, state.receivedAt, state.serverDate);
  }, [state, wall]);
  useEffect(() => installWakeEvents({ timers: wallClock, now: Date.now, onWake: () => wall.wake() }), [wall, wallClock]);
  // The chunk reload lives here, not in main.tsx's display branch: a wall left open across an update would fail on a lazy chart chunk. The cleanup
  // removes the listener, so StrictMode's double effect leaves one.
  useEffect(() => installChunkReload(), []);
  useWakeLock();
  if (state.kind === "connected") return <WallScreen wall={wall} timers={wallClock} />;
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

export function DisplayApp({ handle, timers, wallTimers }: Props) {
  // Here, outside the boundary, so that even the fallback sentence is on a dark screen: this page has no AppearanceProvider and is dark in
  // every theme. A layout effect runs before the first paint, so the screen is never light for a frame.
  useLayoutEffect(() => {
    document.title = "Display";
    document.documentElement.setAttribute("data-mode", "dark");
  }, []);
  return (
    <DisplayBoundary timers={timers}>
      <DisplayScreen handle={handle} timers={timers} wallTimers={wallTimers} />
    </DisplayBoundary>
  );
}
