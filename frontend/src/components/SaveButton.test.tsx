import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { SaveButton } from "./SaveButton";

const HOLD = 2500;
const FADE = 600;

/** The live line: a sibling of the button that holds "Saved" only while the green is showing. */
const live = (container: HTMLElement) => container.querySelector(".save-live")!;
const button = (name: string | RegExp = "Save") => screen.getByRole("button", { name });
const faces = (root: HTMLElement) => [...root.querySelectorAll(".save-face")];
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function reducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("prefers-reduced-motion"), media: query, addEventListener() {}, removeEventListener() {} }));
}

describe("SaveButton", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("idle: a submit button named Save (or the label it is given), enabled", () => {
    const { rerender } = render(<SaveButton state="idle" />);
    expect(button()).toHaveAttribute("type", "submit");
    expect(button()).toBeEnabled();
    expect(button()).toHaveAttribute("data-phase", "idle");
    rerender(<SaveButton state="idle" label="Save rate" />);
    expect(button("Save rate")).toBeInTheDocument();
  });

  it("carries the class the form used before, next to its own", () => {
    render(<SaveButton state="idle" className="primary" />);
    expect(button()).toHaveClass("save-btn", "primary");
  });

  it("pending: Saving…, disabled, and a click calls nothing", async () => {
    const onClick = vi.fn();
    render(<SaveButton state="pending" onClick={onClick} />);
    const saving = button("Saving…");
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute("data-phase", "saving");
    vi.useRealTimers();
    await userEvent.click(saving);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("calls onClick once per click while idle", async () => {
    vi.useRealTimers();
    const onClick = vi.fn();
    render(<SaveButton state="idle" type="button" onClick={onClick} />);
    expect(button()).toHaveAttribute("type", "button");
    await userEvent.click(button());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("success: green and named Saved for 2.5 s, then it fades for 0.6 s, then it is idle again", () => {
    const { container, rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="pending" />);
    rerender(<SaveButton state="success" />);
    expect(button("Saved")).toHaveAttribute("data-phase", "saved");
    expect(button("Saved")).toBeEnabled();
    expect(live(container)).toHaveTextContent("Saved");
    tick(HOLD - 1);
    expect(button("Saved")).toHaveAttribute("data-phase", "saved");
    tick(1);
    expect(button()).toHaveAttribute("data-phase", "fading");
    expect(live(container)).toBeEmptyDOMElement();
    tick(FADE - 1);
    expect(button()).toHaveAttribute("data-phase", "fading");
    tick(1);
    expect(button()).toHaveAttribute("data-phase", "idle");
    expect(live(container)).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the live line is a sibling of the button (it would otherwise be part of the name) and has no role", () => {
    const { container, rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    const line = live(container);
    expect(line).toHaveAttribute("aria-live", "polite");
    expect(line).not.toHaveAttribute("role");
    expect(line.parentElement).toBe(button("Saved").parentElement);
    expect(button("Saved")).not.toContainElement(line as HTMLElement);
  });

  it("three faces are always drawn and exactly one is exposed: the label, Saving… or the check with Saved", () => {
    const { container, rerender } = render(<SaveButton state="idle" />);
    const exposed = () => faces(container).filter((face) => !face.hasAttribute("aria-hidden")).map((face) => face.textContent);
    expect(faces(container)).toHaveLength(3);
    expect(exposed()).toEqual(["Save"]);
    rerender(<SaveButton state="pending" />);
    expect(exposed()).toEqual(["Saving…"]);
    rerender(<SaveButton state="success" />);
    expect(exposed()).toEqual(["Saved"]);
    expect(faces(container)[2].querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
    tick(HOLD);
    expect(exposed()).toEqual(["Save"]); // fading shows the idle label while the colour fades
    tick(FADE);
    expect(exposed()).toEqual(["Save"]);
    for (const face of faces(container).filter((f) => f.hasAttribute("aria-hidden"))) expect(face).toHaveAttribute("aria-hidden", "true");
  });

  it("ariaLabel is the name in every phase; the state shows in data-phase and the live line", () => {
    const { container, rerender } = render(<SaveButton state="idle" ariaLabel="Save sign-in protection" />);
    expect(button("Save sign-in protection")).toHaveAttribute("data-phase", "idle");
    rerender(<SaveButton state="pending" ariaLabel="Save sign-in protection" />);
    expect(button("Save sign-in protection")).toHaveAttribute("data-phase", "saving");
    rerender(<SaveButton state="success" ariaLabel="Save sign-in protection" />);
    expect(button("Save sign-in protection")).toHaveAttribute("data-phase", "saved");
    expect(live(container)).toHaveTextContent("Saved");
  });

  it("a success that is already there when the button mounts flashes nothing", () => {
    const { container } = render(<SaveButton state="success" />);
    expect(button()).toHaveAttribute("data-phase", "idle");
    expect(live(container)).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a new save during the green drops it at once, and the next success starts a fresh 2.5 s", () => {
    const { rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    tick(2000);
    rerender(<SaveButton state="pending" />);
    expect(button("Saving…")).toHaveAttribute("data-phase", "saving");
    expect(vi.getTimerCount()).toBe(0);
    tick(5000);
    rerender(<SaveButton state="success" />);
    tick(HOLD - 1); // the old timer would have fired long ago
    expect(button("Saved")).toHaveAttribute("data-phase", "saved");
    tick(1);
    expect(button()).toHaveAttribute("data-phase", "fading");
  });

  it("an error after the request ended: idle and enabled, so the form can be used again", () => {
    const { rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="pending" />);
    rerender(<SaveButton state="error" />);
    expect(button()).toBeEnabled();
    expect(button()).toHaveAttribute("data-phase", "idle");
  });

  it("the form editing (the mutation is reset to idle) drops the green at once", () => {
    const { container, rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    rerender(<SaveButton state="idle" />);
    expect(button()).toHaveAttribute("data-phase", "idle");
    expect(live(container)).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an error while the green shows drops it", () => {
    const { rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    tick(1000);
    rerender(<SaveButton state="error" />);
    expect(button()).toHaveAttribute("data-phase", "idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("with reduced motion the green ends in one step: no fading phase, idle after the hold", () => {
    reducedMotion(true);
    const { rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    expect(button("Saved")).toHaveAttribute("data-phase", "saved");
    tick(HOLD);
    expect(button()).toHaveAttribute("data-phase", "idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without matchMedia (jsdom has none) the fade is drawn as usual", () => {
    expect(typeof window.matchMedia).not.toBe("function");
    const { rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    tick(HOLD);
    expect(button()).toHaveAttribute("data-phase", "fading");
  });

  it("a matchMedia that throws is like none", () => {
    vi.stubGlobal("matchMedia", () => { throw new Error("no"); });
    const { rerender } = render(<SaveButton state="idle" />);
    rerender(<SaveButton state="success" />);
    tick(HOLD);
    expect(button()).toHaveAttribute("data-phase", "fading");
  });

  it("holdMs and fadeMs can be shortened (tests only)", () => {
    const { rerender } = render(<SaveButton state="idle" holdMs={100} fadeMs={50} />);
    rerender(<SaveButton state="success" holdMs={100} fadeMs={50} />);
    tick(100);
    expect(button()).toHaveAttribute("data-phase", "fading");
    tick(50);
    expect(button()).toHaveAttribute("data-phase", "idle");
  });

  it("leaves no timer behind when it unmounts during the green or the fade", () => {
    const first = render(<SaveButton state="idle" />);
    first.rerender(<SaveButton state="success" />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const second = render(<SaveButton state="idle" />);
    second.rerender(<SaveButton state="success" />);
    tick(HOLD);
    expect(button()).toHaveAttribute("data-phase", "fading");
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("under StrictMode one success still ends idle after 3.1 s, with a single timer at any time", () => {
    const { rerender } = render(<StrictMode><SaveButton state="idle" /></StrictMode>);
    rerender(<StrictMode><SaveButton state="pending" /></StrictMode>);
    rerender(<StrictMode><SaveButton state="success" /></StrictMode>);
    expect(vi.getTimerCount()).toBe(1);
    tick(HOLD); // two ticks: the fade timer is set by the effect of the render that the hold timer caused
    tick(FADE);
    expect(button()).toHaveAttribute("data-phase", "idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a disabled prop disables the button (the form's own reasons), and Saving… keeps it disabled", () => {
    const { rerender } = render(<SaveButton state="idle" disabled />);
    expect(button()).toBeDisabled();
    rerender(<SaveButton state="idle" />);
    expect(button()).toBeEnabled();
    rerender(<SaveButton state="pending" />);
    expect(button("Saving…")).toBeDisabled();
  });
});
