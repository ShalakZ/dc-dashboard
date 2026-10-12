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

  it("opens on a click, pinned: the note is next to the button and the button points at it", async () => {
    render(<InfoTip>The disk size.</InfoTip>);
    await userEvent.click(button());
    expect(note()).toHaveTextContent("The disk size.");
    expect(note()).toHaveClass("tip-bubble");
    expect(button().parentElement).toContainElement(note());
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

  it("does not close on a scroll (the bubble is part of the page and moves with it)", async () => {
    render(<InfoTip>Hint</InfoTip>);
    await userEvent.click(button());
    fireEvent.scroll(window);
    expect(note()).not.toBeNull();
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

  it("opens leftwards when the bubble would run off the right edge of the window", async () => {
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const right = this.getAttribute("role") === "note" ? 1100 : 1000; // jsdom's window is 1024 wide
      return { x: 0, y: 0, top: 0, bottom: 0, left: right - 100, right, width: 100, height: 0, toJSON: () => ({}) };
    });
    render(<InfoTip>Hint</InfoTip>);
    await userEvent.click(button());
    expect(note()).toHaveAttribute("data-align", "end");
    spy.mockRestore();
    await userEvent.click(button());
    await userEvent.click(button());
    expect(note()).toHaveAttribute("data-align", "start");
  });

  it("opening a tip closes another one", async () => {
    render(<><InfoTip label="First">one</InfoTip><InfoTip label="Second">two</InfoTip></>);
    await userEvent.click(screen.getByRole("button", { name: "First" }));
    await userEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getAllByRole("note")).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent("two");
  });
});
