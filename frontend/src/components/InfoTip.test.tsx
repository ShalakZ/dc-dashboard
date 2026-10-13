import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTip } from "./InfoTip";

const button = () => screen.getByRole("button", { name: "What does this mean?" });
const note = () => screen.queryByRole("note");

// jsdom 26 has no PointerEvent: without a stand-in pointerType is undefined and a mouse cannot be told from a touch.
const RealPointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
beforeAll(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
  };
});
afterAll(() => { (globalThis as { PointerEvent?: unknown }).PointerEvent = RealPointerEvent; });

describe("InfoTip", () => {
  it("is a closed button with a generic name, and the bubble is not in the page", () => {
    render(<InfoTip>The disk size.</InfoTip>);
    expect(button()).toHaveAttribute("type", "button");
    expect(button()).toHaveClass("icon-btn", "tip-btn");
    expect(button()).toHaveAttribute("aria-expanded", "false");
    expect(button()).not.toHaveAttribute("aria-controls");
    expect(button().closest(".tip")).not.toBeNull();
    expect(note()).toBeNull();
    expect(screen.queryByText("The disk size.")).toBeNull();
  });

  it("takes a different name when asked", () => {
    render(<InfoTip label="About retention">x</InfoTip>);
    expect(screen.getByRole("button", { name: "About retention" })).toBeInTheDocument();
  });

  it("opens on a click, pinned: the note is a portal on the body (no scrolling box around the button can clip it) and the button points at it", async () => {
    render(<InfoTip>The disk size.</InfoTip>);
    await userEvent.click(button());
    expect(note()).toHaveTextContent("The disk size.");
    expect(note()).toHaveClass("tip-bubble");
    expect(note()!.parentElement).toBe(document.body);
    expect(button().parentElement).not.toContainElement(note());
    expect(button()).toHaveAttribute("aria-expanded", "true");
    expect(button()).toHaveAttribute("aria-controls", note()!.id);
    await userEvent.click(button());
    expect(note()).toBeNull();
  });

  it("opens from the keyboard with Enter or Space, and Escape closes it with the focus on the button", async () => {
    render(<InfoTip>Hint</InfoTip>);
    button().focus();
    await userEvent.keyboard("{Enter}");
    expect(note()).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(note()).toBeNull();
    expect(button()).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(note()).not.toBeNull();
  });

  it("a press outside closes it, a press on its own button or bubble does not", async () => {
    render(<><InfoTip>Hint</InfoTip><p>elsewhere</p></>);
    await userEvent.click(button());
    fireEvent.pointerDown(note()!);
    fireEvent.pointerDown(button());
    expect(note()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(note()).toBeNull();
  });

  describe("scrolling", () => {
    let clock = 10_000;
    beforeEach(() => { clock = 10_000; vi.spyOn(performance, "now").mockImplementation(() => clock); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("closes on a scroll, because the fixed bubble would be left behind when its button moves", async () => {
      render(<InfoTip>Hint</InfoTip>);
      await userEvent.click(button());
      clock += 500; // past the settle time of the popover hook
      fireEvent.scroll(window);
      expect(note()).toBeNull();
    });

    it("closes on a scroll of a box around the button (the Roles grid's own scrolling box)", async () => {
      render(<div className="table-wrap"><InfoTip>Hint</InfoTip></div>);
      await userEvent.click(button());
      clock += 500;
      fireEvent.scroll(document.querySelector(".table-wrap")!);
      expect(note()).toBeNull();
    });
  });

  describe("with a mouse", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

    it("opens after the pointer rests on the button, closes when it leaves, and a click pins it", () => {
      render(<InfoTip>Hint</InfoTip>);
      fireEvent.pointerEnter(button(), { pointerType: "mouse" });
      fireEvent.pointerMove(button(), { pointerType: "mouse" });
      advance(200);
      expect(note()).not.toBeNull();
      fireEvent.pointerLeave(button(), { pointerType: "mouse" });
      advance(150);
      expect(note()).toBeNull();

      fireEvent.pointerEnter(button(), { pointerType: "mouse" });
      fireEvent.pointerMove(button(), { pointerType: "mouse" });
      advance(200);
      fireEvent.click(button(), { detail: 1 });
      fireEvent.pointerLeave(button(), { pointerType: "mouse" });
      advance(1000);
      expect(note()).not.toBeNull();
    });

    it("stays open while the pointer is on the bubble", () => {
      render(<InfoTip>Hint</InfoTip>);
      fireEvent.pointerEnter(button(), { pointerType: "mouse" });
      fireEvent.pointerMove(button(), { pointerType: "mouse" });
      advance(200);
      fireEvent.pointerLeave(button(), { pointerType: "mouse" });
      advance(100);
      fireEvent.pointerEnter(note()!, { pointerType: "mouse" });
      advance(1000);
      expect(note()).not.toBeNull();
    });
  });

  describe("where the bubble goes (window coordinates; jsdom's window is 1024 by 768)", () => {
    // The button is a 24 px square at (left, top); the bubble measures 300 by 60.
    const mockBoxes = (left: number, top: number) =>
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("role") === "note") return { x: 0, y: 0, top: 0, bottom: 60, left: 0, right: 300, width: 300, height: 60, toJSON: () => ({}) };
        return { x: left, y: top, top, bottom: top + 24, left, right: left + 24, width: 24, height: 24, toJSON: () => ({}) };
      });
    afterEach(() => { vi.restoreAllMocks(); });

    it("under the button, left edges aligned", async () => {
      mockBoxes(100, 100);
      render(<InfoTip>Hint</InfoTip>);
      await userEvent.click(button());
      expect(note()).toHaveStyle({ top: "130px", left: "100px" });
    });

    it("right edges aligned when the bubble would run off the right of the window", async () => {
      mockBoxes(900, 100); // 900 + 300 is past the 8 px margin of a 1024 window
      render(<InfoTip>Hint</InfoTip>);
      await userEvent.click(button());
      expect(note()).toHaveStyle({ left: `${900 + 24 - 300}px` });
    });

    it("never closer than 8 px to the window's edge, even for a button flush against it", async () => {
      mockBoxes(1000, 100); // right edge at 1024: aligning the right edges would put the bubble's edge at the window's
      render(<InfoTip>Hint</InfoTip>);
      await userEvent.click(button());
      expect(note()).toHaveStyle({ left: `${1024 - 8 - 300}px` });
    });

    it("above the button when there is no room below", async () => {
      mockBoxes(100, 740);
      render(<InfoTip>Hint</InfoTip>);
      await userEvent.click(button());
      expect(note()).toHaveStyle({ top: `${740 - 6 - 60}px` });
    });
  });

  it("opening a tip closes another one", async () => {
    render(<><InfoTip label="First">one</InfoTip><InfoTip label="Second">two</InfoTip></>);
    await userEvent.click(screen.getByRole("button", { name: "First" }));
    await userEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getAllByRole("note")).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent("two");
  });
});
