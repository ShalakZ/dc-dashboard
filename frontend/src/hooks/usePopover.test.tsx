import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePopover } from "./usePopover";

function Host() {
  const pop = usePopover({ hover: false });
  return (
    <>
      <button ref={pop.trigger} onClick={() => pop.toggle()}>trigger</button>
      {pop.open && <div ref={pop.panel}>panel</div>}
    </>
  );
}

/** What a Modal does: it listens for Escape on the document, in the bubble phase. */
function listenLikeAModal() {
  const heard = vi.fn();
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") heard(); };
  document.addEventListener("keydown", onKey);
  return { heard, stop: () => document.removeEventListener("keydown", onKey) };
}

describe("usePopover: Escape", () => {
  it("closes an open popover and is not heard by a dialog around it (the first Escape closes the tip, the second the dialog)", async () => {
    const modal = listenLikeAModal();
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "trigger" }));
    expect(screen.getByText("panel")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("panel")).toBeNull();
    expect(modal.heard).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(modal.heard).toHaveBeenCalledTimes(1); // nothing is open now: the key goes on to the dialog
    modal.stop();
  });

  it("does not take the key while it is closed", async () => {
    const modal = listenLikeAModal();
    render(<Host />);
    await userEvent.keyboard("{Escape}");
    expect(modal.heard).toHaveBeenCalledTimes(1);
    modal.stop();
  });

  it("keeps the focus on the trigger after Escape when the focus was inside", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "trigger" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "trigger" })).toHaveFocus();
  });
});

describe("usePopover: Escape on a popover that only a resting mouse opened", () => {
  // jsdom 26 has no PointerEvent: without a stand-in pointerType is undefined and a mouse cannot be told from a touch.
  const RealPointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
  beforeAll(() => {
    (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
    };
  });
  afterAll(() => { (globalThis as { PointerEvent?: unknown }).PointerEvent = RealPointerEvent; });
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function HoverHost() {
    const pop = usePopover({ hover: true });
    return (
      <>
        <button ref={pop.trigger} onClick={() => pop.toggle()} {...pop.triggerHover}>trigger</button>
        {pop.open && <div ref={pop.panel}>panel</div>}
      </>
    );
  }
  const hoverOpen = () => {
    const trigger = screen.getByRole("button", { name: "trigger" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText("panel")).toBeInTheDocument();
    return trigger;
  };

  it("closes, and lets the key go on (the user is typing elsewhere, or leaving the dialog)", () => {
    const modal = listenLikeAModal();
    render(<HoverHost />);
    hoverOpen();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("panel")).toBeNull();
    expect(modal.heard).toHaveBeenCalledTimes(1);
    modal.stop();
  });

  it("is taken once a click has pinned it", () => {
    const modal = listenLikeAModal();
    render(<HoverHost />);
    const trigger = hoverOpen();
    fireEvent.click(trigger, { detail: 1 });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("panel")).toBeNull();
    expect(modal.heard).not.toHaveBeenCalled();
    modal.stop();
  });
});
