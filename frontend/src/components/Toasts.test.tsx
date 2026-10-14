import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { manualTimers } from "../test/manualTimers";
import { spyToasts } from "../test/toasts";
import { ToastContext, ToastProvider, useToast, type ToastApi } from "./Toasts";

// The provider clears its toasts when the signed-in account changes; the account is what these tests move.
const auth = vi.hoisted(() => ({ user: { id: 1 } as { id: number } | null }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ user: auth.user }) }));

/** The injected clock: `manualTimers` for the timers and a `now` that moves with them. No callback of the provider reads `now`, so moving it first is enough. */
function clock() {
  const hand = manualTimers();
  let t = 0;
  return {
    timers: hand.timers,
    now: () => t,
    advance: (ms: number) => act(() => { t += ms; hand.advance(ms); }),
    get pending() { return hand.count; },
  };
}

let api: ToastApi;
const seen: ToastApi[] = [];
function Probe() {
  api = useToast();
  seen.push(api);
  return null;
}

function setup({ strict = false } = {}) {
  const c = clock();
  const tree = (): ReactNode => (
    <ToastProvider timers={c.timers} now={c.now}>
      <Probe />
      <button type="button">outside</button>
    </ToastProvider>
  );
  const view = render(strict ? <StrictMode>{tree()}</StrictMode> : tree());
  return { c, view, tree };
}

const fire = (fn: () => void) => act(fn);
const stack = () => document.querySelector(".toast-stack") as HTMLElement;
const toasts = () => [...stack().querySelectorAll<HTMLElement>(".toast")];
const textOf = (el: HTMLElement) => el.querySelector(".toast-text")!.textContent;
const texts = () => toasts().map(textOf);
const leaving = () => toasts().filter((el) => el.dataset.leaving === "true").map(textOf);
const staying = () => toasts().filter((el) => el.dataset.leaving !== "true").map(textOf);
const toastWith = (text: string) => toasts().find((el) => textOf(el) === text)!;

const reduceMotion = () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener() {}, removeEventListener() {} }),
  });
};

beforeEach(() => {
  auth.user = { id: 1 };
  seen.length = 0;
});
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia; // jsdom has none
});

describe("the stack", () => {
  it("is one live region with no role, there from the first render, and holds toasts as plain elements", () => {
    setup();
    expect(stack()).toBeInTheDocument();
    expect(stack().getAttribute("aria-live")).toBe("polite");
    expect(stack().getAttribute("aria-relevant")).toBe("additions text"); // text too: a repeat that collapses into the count badge changes text, not nodes, and is announced
    expect(stack().hasAttribute("role")).toBe(false);
    expect(toasts()).toHaveLength(0);
    fire(() => api.success("Asset created"));
    expect(texts()).toEqual(["Asset created"]);
    expect(toasts()[0].hasAttribute("role")).toBe(false); // a role="status" per toast would collide with the page's own status lookups
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives an error toast role=alert, and only an error", () => {
    setup();
    fire(() => { api.info("Heads up"); api.error("It broke"); });
    expect(within(stack()).getByRole("alert")).toHaveTextContent("It broke");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("is the same element after toasts come and go (the live region is never rebuilt)", () => {
    const { c } = setup();
    const before = stack();
    fire(() => api.success("One"));
    c.advance(4150);
    expect(toasts()).toHaveLength(0);
    expect(stack()).toBe(before);
  });

  it("puts the newest toast last, so the bottom-anchored stack shows it nearest the corner", () => {
    setup();
    fire(() => { api.success("First"); api.success("Second"); });
    expect(texts()).toEqual(["First", "Second"]);
  });

  it("never takes focus", () => {
    setup();
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    fire(() => { api.success("Quiet"); api.error("Loud"); });
    expect(document.activeElement).toBe(outside);
  });
});

describe("leaving by itself", () => {
  it("a success leaves at 4000 ms (fading 150 ms), an info the same, an error at 8000 ms", () => {
    const { c } = setup();
    fire(() => { api.success("Done"); api.info("FYI"); api.error("Oops"); });
    c.advance(3999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Done", "FYI"]);
    expect(texts()).toEqual(["Done", "FYI", "Oops"]); // still mounted for the fade
    c.advance(150);
    expect(texts()).toEqual(["Oops"]);
    c.advance(3849);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Oops"]);
    c.advance(150);
    expect(texts()).toEqual([]);
    expect(c.pending).toBe(0);
  });

  it("removal is by the injected timers, not by an animation event", () => {
    const { c } = setup();
    fire(() => api.success("Done"));
    c.advance(4000);
    fireEvent.transitionEnd(toastWith("Done"));
    fireEvent.animationEnd(toastWith("Done"));
    expect(texts()).toEqual(["Done"]);
    c.advance(150);
    expect(texts()).toEqual([]);
  });

  it("under reduced motion a toast is gone as soon as the timers run (no fade to wait for)", () => {
    reduceMotion();
    const { c } = setup();
    fire(() => { api.success("Done"); api.error("Oops"); });
    c.advance(4000);
    expect(texts()).toEqual(["Oops"]);
    fire(() => fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" })));
    c.advance(0);
    expect(texts()).toEqual([]);
  });

  it("every toast has a close button, and Dismiss starts the leave at once", () => {
    const { c } = setup();
    fire(() => { api.error("Oops"); api.success("Done"); });
    const buttons = screen.getAllByRole("button", { name: "Dismiss notification" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(leaving()).toEqual(["Oops"]);
    c.advance(150);
    expect(texts()).toEqual(["Done"]);
    expect(c.pending).toBe(1); // only the other toast's own timer is left
  });
});

describe("hover and focus pause the timer", () => {
  it("hover at 3000 ms keeps a success past 4000 ms; leaving resumes with the rest", () => {
    const { c } = setup();
    fire(() => api.success("Reading"));
    c.advance(3000);
    fireEvent.mouseEnter(toastWith("Reading"));
    c.advance(2000);
    expect(leaving()).toEqual([]);
    fireEvent.mouseLeave(toastWith("Reading"));
    c.advance(999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Reading"]);
    c.advance(150);
    expect(texts()).toEqual([]);
  });

  it("resumes with at least 1000 ms, however little was left", () => {
    const { c } = setup();
    fire(() => api.success("Nearly gone"));
    c.advance(3950);
    fireEvent.mouseEnter(toastWith("Nearly gone"));
    c.advance(500);
    fireEvent.mouseLeave(toastWith("Nearly gone"));
    c.advance(999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Nearly gone"]);
  });

  it("focus inside the toast pauses it too, and the pause lasts until both hover and focus are gone", () => {
    const { c } = setup();
    fire(() => api.success("Held"));
    const close = within(toastWith("Held")).getByRole("button", { name: "Dismiss notification" });
    c.advance(1000);
    fireEvent.focus(close);
    fireEvent.mouseEnter(toastWith("Held"));
    c.advance(10_000);
    fireEvent.mouseLeave(toastWith("Held"));
    c.advance(10_000);
    expect(leaving()).toEqual([]); // still focused
    fireEvent.blur(close);
    c.advance(2999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Held"]);
  });

  it("pauses only the toast under the pointer", () => {
    const { c } = setup();
    fire(() => api.success("Held"));
    c.advance(100);
    fire(() => api.success("Free"));
    fireEvent.mouseEnter(toastWith("Held"));
    c.advance(4000); // "Free" is due at 4100 ms and fades out; "Held" would have been due at 4000 ms
    expect(leaving()).toEqual(["Free"]);
    c.advance(150);
    expect(texts()).toEqual(["Held"]);
  });
});

describe("the cap of three", () => {
  it("a fourth toast sends the oldest away, and the fade is part of it", () => {
    const { c } = setup();
    fire(() => { api.success("A"); api.success("B"); api.success("C"); });
    expect(leaving()).toEqual([]);
    fire(() => api.success("D"));
    expect(leaving()).toEqual(["A"]);
    expect(staying()).toEqual(["B", "C", "D"]);
    c.advance(150);
    expect(texts()).toEqual(["B", "C", "D"]);
  });

  it("an eight-second error is not pushed out by quick successes: the oldest non-error goes first", () => {
    const { c } = setup();
    fire(() => { api.error("E"); api.success("S1"); api.success("S2"); api.success("S3"); });
    expect(leaving()).toEqual(["S1"]);
    c.advance(150);
    expect(texts()).toEqual(["E", "S2", "S3"]);
  });

  it("with only errors on screen the oldest error goes, and a new success is never the one sent away", () => {
    const { c } = setup();
    fire(() => { api.error("E1"); api.error("E2"); api.error("E3"); api.success("S"); });
    expect(leaving()).toEqual(["E1"]);
    c.advance(150);
    expect(texts()).toEqual(["E2", "E3", "S"]);
  });

  it("a toast that is already leaving does not count against the cap", () => {
    const { c } = setup();
    fire(() => { api.success("A"); api.success("B"); api.success("C"); });
    fireEvent.click(within(toastWith("A")).getByRole("button", { name: "Dismiss notification" }));
    fire(() => api.success("D"));
    expect(leaving()).toEqual(["A"]);
    expect(staying()).toEqual(["B", "C", "D"]);
    c.advance(150);
    expect(texts()).toEqual(["B", "C", "D"]);
  });
});

describe("the same message twice", () => {
  it("within 1500 ms of the previous one collapses into it: a count badge, and the timer restarts", () => {
    const { c } = setup();
    fire(() => api.success("Rate added"));
    c.advance(1000);
    fire(() => api.success("Rate added"));
    expect(texts()).toEqual(["Rate added"]);
    expect(toastWith("Rate added").querySelector(".toast-count")).toHaveTextContent("2");
    c.advance(3999); // 4999 ms after the first, 3999 after the second
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Rate added"]);
  });

  it("counts every collapse, each one inside 1500 ms of the one before", () => {
    const { c } = setup();
    fire(() => api.success("Saved row"));
    c.advance(1400);
    fire(() => api.success("Saved row"));
    c.advance(1400);
    fire(() => api.success("Saved row"));
    expect(texts()).toEqual(["Saved row"]);
    expect(toastWith("Saved row").querySelector(".toast-count")).toHaveTextContent("3");
  });

  it("after 1500 ms it is a second toast", () => {
    const { c } = setup();
    fire(() => api.success("Rate added"));
    c.advance(1501);
    fire(() => api.success("Rate added"));
    expect(texts()).toEqual(["Rate added", "Rate added"]);
    expect(stack().querySelector(".toast-count")).toBeNull();
  });

  it("only the previous toast counts: A, B, A inside a second is three toasts", () => {
    const { c } = setup();
    fire(() => api.success("A"));
    c.advance(300);
    fire(() => api.success("B"));
    c.advance(300);
    fire(() => api.success("A"));
    expect(texts()).toEqual(["A", "B", "A"]);
  });

  it("needs the same kind as well as the same text", () => {
    setup();
    fire(() => { api.success("Same words"); api.info("Same words"); });
    expect(toasts()).toHaveLength(2);
  });

  it("never collapses into a toast that is leaving", () => {
    const { c } = setup();
    fire(() => api.success("A"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    fire(() => api.success("A"));
    expect(texts()).toEqual(["A", "A"]);
    expect(leaving()).toEqual(["A"]);
    c.advance(150);
    expect(texts()).toEqual(["A"]);
    expect(stack().querySelector(".toast-count")).toBeNull();
  });

  it("a collapse into a toast under the pointer keeps it paused, with a fresh full life ahead", () => {
    const { c } = setup();
    fire(() => api.success("Held"));
    c.advance(500);
    fireEvent.mouseEnter(toastWith("Held"));
    c.advance(500);
    fire(() => api.success("Held"));
    c.advance(30_000);
    expect(leaving()).toEqual([]);
    fireEvent.mouseLeave(toastWith("Held"));
    c.advance(3999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Held"]);
  });
});

/** An action that records how often it ran. */
function undo(label = "Undo") {
  const onAction = vi.fn();
  return { onAction, options: { action: { label, onAction } } };
}
const actionOf = (el: HTMLElement) => within(el).getByRole("button", { name: /^(?!Dismiss notification$)/ });

describe("a toast with an action (W7p)", () => {
  it("shows a real button after the text and before the dismiss button, and the text stays the message", () => {
    setup();
    fire(() => api.success("Moved 3 assets to Row A", undo().options));
    const toast = toastWith("Moved 3 assets to Row A");
    const buttons = within(toast).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Undo", "Dismiss notification"]);
    expect(buttons[0]).toHaveAttribute("type", "button");
    expect(buttons[0].className).toContain("toast-action");
    const order = [...toast.children].map((el) => el.className.split(" ")[0]);
    expect(order).toEqual(["toast-icon", "toast-text", "toast-action", "icon-btn"]);
    expect(textOf(toast)).toBe("Moved 3 assets to Row A"); // the label is not part of the message
  });

  it("an action's title is the button's hover text and description, and its name stays exactly the label", () => {
    setup();
    fire(() => api.success("Moved 3 assets to Row A", { action: { label: "Undo", title: "Undo (Ctrl+Z)", onAction: vi.fn() } }));
    const toast = toastWith("Moved 3 assets to Row A");
    const button = within(toast).getByRole("button", { name: "Undo" }); // an exact string name: the title did not become part of it
    expect(button).toHaveAttribute("title", "Undo (Ctrl+Z)");
    expect(button).toHaveAccessibleDescription("Undo (Ctrl+Z)");
    fire(() => api.success("Plain", { action: { label: "Undo", onAction: vi.fn() } }));
    expect(actionOf(toastWith("Plain"))).not.toHaveAttribute("title"); // no title unless one is given
  });

  it("a toast without an action has no action button, exactly as before", () => {
    setup();
    fire(() => api.success("Plain"));
    expect(stack().querySelector(".toast-action")).toBeNull();
    expect(within(toastWith("Plain")).getAllByRole("button")).toHaveLength(1);
  });

  it("is in the tab order: Tab reaches the action, then the dismiss button", async () => {
    setup();
    const user = userEvent.setup({ delay: null });
    fire(() => api.success("Moved 1 asset to Row A", undo().options));
    await user.tab(); // outside
    await user.tab();
    expect(document.activeElement).toBe(actionOf(toastWith("Moved 1 asset to Row A")));
    await user.tab();
    expect(document.activeElement).toBe(within(toastWith("Moved 1 asset to Row A")).getByRole("button", { name: "Dismiss notification" }));
  });

  it("the action runs once and dismisses the toast; a second click while it fades does nothing", () => {
    const { c } = setup();
    const a = undo();
    fire(() => api.success("Moved", a.options));
    const button = actionOf(toastWith("Moved"));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(a.onAction).toHaveBeenCalledTimes(1);
    expect(leaving()).toEqual(["Moved"]);
    c.advance(150);
    expect(texts()).toEqual([]);
    expect(c.pending).toBe(0);
  });

  it("Enter and Space on the focused action work like a click (it is a native button)", async () => {
    setup();
    const user = userEvent.setup({ delay: null });
    const a = undo();
    fire(() => api.info("Keyboard", a.options));
    actionOf(toastWith("Keyboard")).focus();
    await user.keyboard("{Enter}");
    expect(a.onAction).toHaveBeenCalledTimes(1);
  });

  it("dismiss does not run the action, and a late click on a toast that is already leaving does not either", () => {
    setup();
    const a = undo();
    fire(() => api.success("Moved", a.options));
    const toast = toastWith("Moved");
    fireEvent.click(within(toast).getByRole("button", { name: "Dismiss notification" }));
    fireEvent.click(actionOf(toast));
    expect(a.onAction).not.toHaveBeenCalled();
  });

  it("the toast is already leaving when the action runs, so a toast the action raises is a normal new one", () => {
    const { c } = setup();
    fire(() => api.success("Moved", { action: { label: "Undo", onAction: () => api.success("Undone") } }));
    fireEvent.click(actionOf(toastWith("Moved")));
    expect(leaving()).toEqual(["Moved"]);
    expect(staying()).toEqual(["Undone"]);
    c.advance(150);
    expect(texts()).toEqual(["Undone"]);
  });

  it("works on an error toast (role=alert) and keeps the error's own life", () => {
    const { c } = setup();
    const a = undo("Retry");
    fire(() => api.error("Could not save", a.options));
    expect(within(stack()).getByRole("alert")).toHaveTextContent("Could not save");
    c.advance(7999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Could not save"]);
  });

  it("focus on the action holds the toast like focus on the dismiss button, and the resume floor is unchanged", () => {
    const { c } = setup();
    fire(() => api.success("Moved", { ...undo().options, durationMs: 8000 }));
    const button = actionOf(toastWith("Moved"));
    c.advance(7900);
    fireEvent.focus(button);
    c.advance(60_000);
    expect(leaving()).toEqual([]);
    fireEvent.blur(button);
    c.advance(999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Moved"]);
  });

  it("is announced once: the action is part of the one toast node added to the one live region", async () => {
    setup();
    const watch = new MutationObserver(() => {});
    watch.observe(stack(), { childList: true, subtree: true });
    fire(() => api.success("Moved 2 assets to Row B", undo().options));
    const added = () => watch.takeRecords().flatMap((r) => [...r.addedNodes].filter((n): n is HTMLElement => n instanceof HTMLElement).map((n) => n.className.split(" ")[0]));
    // The toast arrives whole (icon, text, action and close inside it): nothing is added to the live region around it or after it, so there is no second message.
    expect(added()).toEqual(["toast"]);
    await act(async () => { await Promise.resolve(); });
    expect(added()).toEqual([]);
    watch.disconnect();
    expect(stack().querySelectorAll("[aria-live], [role=status]")).toHaveLength(0);
    expect(stack().getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Escape on the action does nothing new: the toast stays and nothing runs", async () => {
    setup();
    const user = userEvent.setup({ delay: null });
    const a = undo();
    fire(() => api.success("Moved", a.options));
    actionOf(toastWith("Moved")).focus();
    await user.keyboard("{Escape}");
    expect(a.onAction).not.toHaveBeenCalled();
    expect(staying()).toEqual(["Moved"]);
  });
});

describe("a life of its own (durationMs, W7p)", () => {
  it("replaces the default life of that toast: a success lasts 8000 ms, an error 2000 ms", () => {
    const { c } = setup();
    fire(() => { api.success("Long", { durationMs: 8000 }); api.error("Short", { durationMs: 2000 }); });
    c.advance(1999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Short"]);
    c.advance(150);
    expect(texts()).toEqual(["Long"]);
    c.advance(5849); // 7999 ms
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Long"]);
  });

  it("hover holds it and leaving gives at least 1000 ms, as for any toast", () => {
    const { c } = setup();
    fire(() => api.success("Long", { durationMs: 8000 }));
    c.advance(7950);
    fireEvent.mouseEnter(toastWith("Long"));
    c.advance(5000);
    expect(leaving()).toEqual([]);
    fireEvent.mouseLeave(toastWith("Long"));
    c.advance(999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Long"]);
  });

  it("a nonsense duration (0, negative, NaN) falls back to the default life", () => {
    const { c } = setup();
    fire(() => { api.success("Zero", { durationMs: 0 }); api.success("Negative", { durationMs: -5 }); api.success("Nan", { durationMs: Number.NaN }); });
    c.advance(3999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Zero", "Negative", "Nan"]);
  });

  it("under reduced motion it is still removed as soon as its own timer runs", () => {
    reduceMotion();
    const { c } = setup();
    fire(() => api.success("Long", { durationMs: 8000 }));
    c.advance(7999);
    expect(texts()).toEqual(["Long"]);
    c.advance(1);
    expect(texts()).toEqual([]);
  });

  it("a collapse into a toast uses the life of the newest arrival", () => {
    const { c } = setup();
    fire(() => api.success("Again"));
    c.advance(500);
    fire(() => api.success("Again", { durationMs: 6000 }));
    expect(texts()).toEqual(["Again"]);
    c.advance(5999);
    expect(leaving()).toEqual([]);
    c.advance(1);
    expect(leaving()).toEqual(["Again"]);
  });
});

describe("collapse and eviction with an action (W7p, review I12)", () => {
  it("the same text with an action never collapses: two quick Moved toasts stay two, each with its own handler", () => {
    setup();
    const first = undo();
    const second = undo();
    fire(() => { api.success("Moved 1 asset to Row A", first.options); api.success("Moved 1 asset to Row A", second.options); });
    expect(texts()).toEqual(["Moved 1 asset to Row A", "Moved 1 asset to Row A"]);
    expect(stack().querySelector(".toast-count")).toBeNull();
    fireEvent.click(actionOf(toasts()[1]));
    expect(second.onAction).toHaveBeenCalledTimes(1);
    expect(first.onAction).not.toHaveBeenCalled();
    fireEvent.click(actionOf(toasts()[0]));
    expect(first.onAction).toHaveBeenCalledTimes(1);
  });

  it("different action labels never collapse either", () => {
    setup();
    fire(() => { api.success("Same words", undo("Undo").options); api.success("Same words", undo("Redo").options); });
    expect(toasts()).toHaveLength(2);
  });

  it("an action toast does not collapse into a plain one with the same text", () => {
    setup();
    fire(() => { api.success("Same", undo().options); api.success("Same"); });
    expect(texts()).toEqual(["Same", "Same"]);
    expect(toasts()[0].querySelector(".toast-action")).not.toBeNull();
    expect(toasts()[1].querySelector(".toast-action")).toBeNull();
    expect(stack().querySelector(".toast-count")).toBeNull();
  });

  it("and nothing collapses into a toast with an action: a plain one, then the same text with an action, is two", () => {
    setup();
    fire(() => { api.info("Same"); api.info("Same", undo().options); });
    expect(texts()).toEqual(["Same", "Same"]);
    expect(toasts()[1].querySelector(".toast-action")).not.toBeNull();
    expect(stack().querySelector(".toast-count")).toBeNull();
  });

  it("a plain repeat still collapses (the one-argument behaviour is untouched)", () => {
    setup();
    fire(() => { api.success("Plain"); api.success("Plain"); });
    expect(texts()).toEqual(["Plain"]);
    expect(toastWith("Plain").querySelector(".toast-count")).toHaveTextContent("2");
  });

  it("when the cap of three evicts, a toast with an action goes last among the non-errors: three quick toasts do not push an Undo out", () => {
    const { c } = setup();
    fire(() => { api.success("Moved", undo().options); api.success("B"); api.success("C"); });
    fire(() => api.success("D"));
    expect(leaving()).toEqual(["B"]);
    fire(() => api.success("E"));
    expect(leaving()).toEqual(["B", "C"]);
    expect(staying()).toEqual(["Moved", "D", "E"]);
    c.advance(150);
    expect(texts()).toEqual(["Moved", "D", "E"]);
  });

  it("with only action toasts on screen the oldest leaves first, as today", () => {
    setup();
    fire(() => { api.success("A", undo().options); api.success("B", undo().options); api.success("C", undo().options); api.success("D"); });
    expect(leaving()).toEqual(["A"]);
  });

  it("an error is still kept over a toast with an action", () => {
    setup();
    fire(() => { api.error("E"); api.success("A", undo().options); api.success("B", undo().options); api.success("C"); });
    expect(leaving()).toEqual(["A"]);
    expect(staying()).toEqual(["E", "B", "C"]);
  });

  it("the toast just raised is never the one sent away, even if it is the only one without an action", () => {
    setup();
    fire(() => { api.success("A", undo().options); api.success("B", undo().options); api.success("C", undo().options); api.success("Plain"); });
    expect(staying()).toEqual(["B", "C", "Plain"]);
  });
});

describe("spyToasts (W7p)", () => {
  it("records the options only when a call gave some, so the one-argument assertions keep their exact shape", () => {
    const { api: spy, calls } = spyToasts();
    const onAction = () => {};
    spy.success("Plain");
    spy.success("Moved", { action: { label: "Undo", onAction }, durationMs: 8000 });
    spy.error("Oops", {});
    expect(calls).toEqual([
      { kind: "success", text: "Plain" },
      { kind: "success", text: "Moved", options: { action: { label: "Undo", onAction }, durationMs: 8000 } },
      { kind: "error", text: "Oops", options: {} },
    ]);
    expect(Object.keys(calls[0])).toEqual(["kind", "text"]);
  });
});

describe("the hook", () => {
  it("does nothing, and throws nothing, outside a provider", () => {
    render(<Probe />);
    expect(() => { api.success("a"); api.info("b"); api.error("c"); }).not.toThrow();
    expect(document.querySelector(".toast-stack")).toBeNull();
  });

  it("keeps its identity across renders of the provider", () => {
    const { view, tree } = setup();
    view.rerender(tree());
    fire(() => api.success("Something"));
    view.rerender(tree());
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(1);
  });

  it("is what a ToastContext.Provider hands out", () => {
    const calls: string[] = [];
    const spy: ToastApi = { success: (t) => { calls.push(`success:${t}`); }, info: (t) => { calls.push(`info:${t}`); }, error: (t) => { calls.push(`error:${t}`); } };
    render(<ToastContext.Provider value={spy}><Probe /></ToastContext.Provider>);
    api.success("a");
    api.error("b");
    expect(calls).toEqual(["success:a", "error:b"]);
  });
});

describe("lifetime", () => {
  it("unmounting clears every timer: nothing runs afterwards", () => {
    const { c, view } = setup();
    fire(() => { api.success("A"); api.error("B"); });
    c.advance(4000); // A is leaving: its removal timer is armed too
    expect(c.pending).toBeGreaterThan(0);
    view.unmount();
    expect(c.pending).toBe(0);
    expect(() => c.advance(20_000)).not.toThrow();
  });

  it("works under StrictMode's double mount: one toast, one timer, gone on time", () => {
    const { c } = setup({ strict: true });
    fire(() => api.success("Once"));
    expect(texts()).toEqual(["Once"]);
    expect(c.pending).toBe(1);
    c.advance(4000);
    expect(leaving()).toEqual(["Once"]);
    c.advance(150);
    expect(texts()).toEqual([]);
    expect(c.pending).toBe(0);
  });

  it("drops the toasts of an account that is no longer signed in, and keeps them while the same one stays", () => {
    const { c, view, tree } = setup();
    fire(() => { api.success("For the first"); api.error("Also for the first"); });
    view.rerender(tree());
    expect(texts()).toEqual(["For the first", "Also for the first"]);
    auth.user = { id: 2 };
    view.rerender(tree());
    expect(texts()).toEqual([]);
    expect(c.pending).toBe(0);
    fire(() => api.success("For the second"));
    auth.user = null;
    view.rerender(tree());
    expect(texts()).toEqual([]);
  });
});

describe("main.tsx", () => {
  it("mounts the ToastProvider inside the Appearance provider and around the router", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    const at = (needle: string) => main.indexOf(needle);
    expect(at("<ToastProvider>"), "<ToastProvider> is mounted").toBeGreaterThan(-1);
    expect(at("<AppearanceProvider>")).toBeLessThan(at("<ToastProvider>"));
    expect(at("<ToastProvider>")).toBeLessThan(at("<RouterProvider"));
    expect(at("<RouterProvider")).toBeLessThan(at("</ToastProvider>"));
    expect(at("</ToastProvider>")).toBeLessThan(at("</AppearanceProvider>"));
  });
});
