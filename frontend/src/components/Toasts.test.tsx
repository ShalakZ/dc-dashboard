import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { manualTimers } from "../test/manualTimers";
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
