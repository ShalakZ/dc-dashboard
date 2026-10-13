import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";
import { placeTip } from "../lib/placeTip";
import { DependencyPrompt } from "./DependencyPrompt";
import { Modal } from "./Modal";

// jsdom 26 has no PointerEvent; the outside-press listener listens for "pointerdown", which userEvent only sends as a PointerEvent.
const RealPointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
beforeAll(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
  };
});
afterAll(() => { (globalThis as { PointerEvent?: unknown }).PointerEvent = RealPointerEvent; });

interface HostProps {
  onAccept?: () => void;
  onDecline?: () => void;
  items?: string[];
  /** The real parent removes the prompt in both callbacks; `keep` leaves it mounted (the form-submit test clicks both buttons on one card). */
  keep?: boolean;
  /** Stands for the parent's second render: new function identities, the same props otherwise. */
  nonce?: number;
}

/** What EditorForm does: a checkbox in a label, the prompt right after the label, and a field elsewhere in the form. */
function Host({ onAccept = () => {}, onDecline = () => {}, items = [], keep = false, nonce = 0 }: HostProps) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  void nonce;
  return (
    <div>
      <div className="role-perm">
        <label className="check"><input ref={input} type="checkbox" />Change users</label>
        {open && (
          <DependencyPrompt
            anchor={input}
            sentence="Change users also needs See users to show anything."
            items={items}
            acceptLabel="Also tick See users"
            declineLabel="Not now"
            onAccept={() => { if (!keep) setOpen(false); onAccept(); }}
            onDecline={() => { if (!keep) setOpen(false); onDecline(); }}
          />
        )}
      </div>
      <label>Name<input /></label>
    </div>
  );
}

const card = () => screen.getByRole("group");
const checkbox = () => screen.getByRole("checkbox", { name: "Change users" });

describe("DependencyPrompt: what it draws", () => {
  it("is a group named by its sentence, with two type=button buttons and the accept one primary", () => {
    render(<Host />);
    expect(screen.getByRole("group", { name: "Change users also needs See users to show anything." })).toHaveClass("dep-prompt");
    const accept = screen.getByRole("button", { name: "Also tick See users" });
    const decline = screen.getByRole("button", { name: "Not now" });
    expect(accept).toHaveAttribute("type", "button");
    expect(decline).toHaveAttribute("type", "button");
    expect(accept).toHaveClass("primary");
    expect(decline).not.toHaveClass("primary");
    expect(card().querySelector("p")).toHaveTextContent("Change users also needs See users to show anything.");
  });

  it("draws the list only when there are items, and the group is described by it (R11)", () => {
    const { unmount } = render(<Host />);
    expect(card().querySelector("ul")).toBeNull();
    expect(card()).not.toHaveAttribute("aria-describedby");
    unmount();
    render(<Host items={["See the Assets Tree", "See scans and the graph"]} />);
    const list = card().querySelector("ul")!;
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["See the Assets Tree", "See scans and the graph"]);
    expect(card()).toHaveAttribute("aria-describedby", list.id);
    expect(list.id).not.toBe("");
  });

  it("never submits the form it sits in (type=button on both buttons)", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Host keep /></form>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Also tick See users" }));
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("DependencyPrompt: focus and the two buttons", () => {
  it("puts the focus on the accept button when it opens", () => {
    render(<Host />);
    expect(screen.getByRole("button", { name: "Also tick See users" })).toHaveFocus();
  });

  it("accept: calls onAccept, then the focus goes back to the checkbox", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(<Host onAccept={onAccept} onDecline={onDecline} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Also tick See users" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
    expect(checkbox()).toHaveFocus();
  });

  it("the decline button: calls onDecline once, then the focus goes back to the checkbox", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(<Host onAccept={onAccept} onDecline={onDecline} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Not now" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(checkbox()).toHaveFocus();
  });

  it("Enter on the focused primary button accepts (the keyboard path)", async () => {
    const onAccept = vi.fn();
    render(<Host onAccept={onAccept} />);
    await userEvent.setup().keyboard("{Enter}");
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(checkbox()).toHaveFocus();
  });

  it("Tab goes from the accept button to the decline button, Shift+Tab back to the checkbox without closing", async () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(checkbox()).toHaveFocus();
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toBeInTheDocument();
  });
});

describe("DependencyPrompt: Escape", () => {
  /** The editor's shape: the Modal is up first, the prompt appears after a click on a checkbox. */
  function InModal({ onClose, onDecline }: { onClose: () => void; onDecline: () => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <Modal title="Edit" onClose={onClose}>
        <label className="check"><input ref={input} type="checkbox" onChange={() => setOpen(true)} />Change users</label>
        {open && (
          <DependencyPrompt
            anchor={input}
            sentence="Change users also needs See users to show anything."
            items={[]}
            acceptLabel="Also tick See users"
            declineLabel="Not now"
            onAccept={() => setOpen(false)}
            onDecline={() => { setOpen(false); onDecline(); }}
          />
        )}
      </Modal>
    );
  }

  it.each([["plain", false], ["in StrictMode (the effects mount twice)", true]])("closes only the prompt, %s: onDecline once, onClose not at all, the focus back on the checkbox", async (_name, strict) => {
    const onClose = vi.fn();
    const onDecline = vi.fn();
    const tree = <InModal onClose={onClose} onDecline={onDecline} />;
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Change users" }));
    expect(screen.getByRole("button", { name: "Also tick See users" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Change users" })).toHaveFocus();
    await user.keyboard("{Escape}"); // no prompt any more: this one is the dialog's
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });
});

describe("DependencyPrompt: leaving it", () => {
  it("a press outside declines once; the focus was in the card, so it goes to the checkbox first (R6)", async () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    fireEvent.pointerDown(screen.getByLabelText("Name"));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(checkbox()).toHaveFocus();
  });

  it("a press outside leaves the focus alone when it was not in the card (the browser then moves it to what was pressed)", () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    act(() => checkbox().focus());
    act(() => checkbox().blur());
    expect(document.body).toHaveFocus();
    fireEvent.pointerDown(screen.getByLabelText("Name"));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(document.body).toHaveFocus();
  });

  it("a real click on a field outside declines exactly once and ends with the field focused", async () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    await userEvent.setup().click(screen.getByLabelText("Name"));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("a press inside the card does nothing", () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    fireEvent.pointerDown(screen.getByText("Change users also needs See users to show anything."));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Not now" }));
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toBeInTheDocument();
  });

  it("a mouse press on the sentence is cancelled (the focus stays, R9); on a button it is not", () => {
    render(<Host />);
    const onText = createEvent.mouseDown(screen.getByText("Change users also needs See users to show anything."));
    fireEvent(screen.getByText("Change users also needs See users to show anything."), onText);
    expect(onText.defaultPrevented).toBe(true);
    for (const name of ["Also tick See users", "Not now"]) {
      const onButton = createEvent.mouseDown(screen.getByRole("button", { name }));
      fireEvent(screen.getByRole("button", { name }), onButton);
      expect(onButton.defaultPrevented, name).toBe(false);
    }
  });

  it("the focus moving to something outside declines and is left where it went", () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    act(() => screen.getByLabelText("Name").focus());
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("the focus going back to the checkbox does not decline", () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    act(() => checkbox().focus());
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toBeInTheDocument();
  });

  it("other keys do nothing", async () => {
    const onDecline = vi.fn();
    render(<Host onDecline={onDecline} />);
    await userEvent.setup().keyboard("a");
    expect(onDecline).not.toHaveBeenCalled();
  });
});

describe("DependencyPrompt: where it sits", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  /** jsdom measures nothing: the card is 200 x 80 and the label is wherever the test says (and the scrolling box, when a test has one). */
  function measure(labelAt: { current: DOMRect }, scroller?: DOMRect) {
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("dep-prompt")) return rect(0, 0, 200, 80);
      if (this.tagName === "LABEL") return labelAt.current;
      if (scroller && this.dataset.testid === "scroller") return scroller;
      return rect(0, 0, 0, 0);
    });
  }
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  it("is put where placeTip says, under the checkbox's label, before the first paint", () => {
    const labelAt = { current: rect(100, 200, 140, 30) };
    measure(labelAt);
    render(<Host />);
    const expected = placeTip(labelAt.current, { width: 200, height: 80 }, viewport);
    expect(expected.placement).toBe("below");
    expect(card().style.top).toBe(`${expected.top}px`);
    expect(card().style.left).toBe(`${expected.left}px`);
  });

  it("flips above the label near the bottom of the window and stays inside on the right", () => {
    const labelAt = { current: rect(900, 720, 110, 30) };
    measure(labelAt);
    render(<Host />);
    const expected = placeTip(labelAt.current, { width: 200, height: 80 }, viewport);
    expect(expected.placement).toBe("above");
    expect(card().style.top).toBe(`${expected.top}px`);
    expect(card().style.left).toBe(`${expected.left}px`);
  });

  it("follows its checkbox when the page scrolls (the window, or any box inside it) and when the window is resized", () => {
    const labelAt = { current: rect(100, 200, 140, 30) };
    measure(labelAt);
    render(<Host />);
    const top = () => card().style.top;
    expect(top()).toBe("236px");
    labelAt.current = rect(100, 150, 140, 30);
    act(() => { fireEvent.scroll(window); });
    expect(top()).toBe("186px");
    labelAt.current = rect(100, 120, 140, 30);
    act(() => { fireEvent.scroll(screen.getByLabelText("Name").parentElement!); }); // a scroll in a box inside the page reaches the capturing listener too
    expect(top()).toBe("156px");
    labelAt.current = rect(100, 100, 140, 30);
    act(() => { fireEvent(window, new Event("resize")); });
    expect(top()).toBe("136px");
  });

  it("stays inside the scrolling box around its checkbox: near the box's bottom it goes above, although the window has room below (whole-wave review I-1)", () => {
    // The box is 100 to 400; the label ends at 370, so the card (80 high) would end at 456 below it: past the box, inside the window.
    const labelAt = { current: rect(100, 340, 140, 30) };
    measure(labelAt, rect(0, 100, 600, 300));
    render(<div data-testid="scroller" style={{ overflowY: "auto" }}><Host /></div>);
    const withoutBounds = placeTip(labelAt.current, { width: 200, height: 80 }, viewport);
    expect(withoutBounds.placement, "the window alone would put it below").toBe("below");
    const top = parseFloat(card().style.top);
    expect(top).toBe(340 - 6 - 80);
    expect(top + 80).toBeLessThanOrEqual(400);
    expect(top).toBeGreaterThanOrEqual(100);
  });

  it("pins itself to the scrolling box's edge when its checkbox has scrolled out of the box (the parked M-9)", () => {
    const labelAt = { current: rect(100, 450, 140, 30) }; // below the box, which ends at 400
    measure(labelAt, rect(0, 100, 600, 300));
    render(<div data-testid="scroller" style={{ overflowY: "auto" }}><Host /></div>);
    expect(parseFloat(card().style.top) + 80).toBe(400);
    labelAt.current = rect(100, 20, 140, 30); // and above it
    act(() => { fireEvent.scroll(window); });
    expect(parseFloat(card().style.top)).toBe(100);
  });

  it("puts the card where the window rule puts it when nothing is measured (jsdom's zero rectangles give no usable band, so no bounds)", () => {
    render(<div data-testid="scroller" style={{ overflowY: "auto" }}><Host /></div>); // no stub: every rectangle is 0 x 0
    const zero = { left: 0, top: 0, right: 0, bottom: 0 };
    const expected = placeTip(zero, { width: 0, height: 0 }, viewport);
    expect(expected.top, "bounds would have clamped this to 8").toBe(6);
    expect(card().style.top).toBe(`${expected.top}px`);
    expect(card().style.left).toBe(`${expected.left}px`);
  });

  it("removes its window listeners when it goes away", () => {
    measure({ current: rect(100, 200, 140, 30) });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Host />);
    const added = (type: string) => add.mock.calls.filter((call) => call[0] === type).map((call) => call[1]);
    const removed = (type: string) => remove.mock.calls.filter((call) => call[0] === type).map((call) => call[1]);
    expect(added("scroll")).toHaveLength(1);
    expect(added("resize")).toHaveLength(1);
    unmount();
    expect(removed("scroll")).toEqual(added("scroll"));
    expect(removed("resize")).toEqual(added("resize"));
  });
});

describe("DependencyPrompt: listeners", () => {
  const kinds = ["keydown", "pointerdown", "focusin"];
  const count = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((call) => kinds.includes(call[0] as string)).length;

  it("registers the three document listeners once; a parent re-rendering with new functions neither re-registers nor re-focuses (the callbacks are read through a ref)", () => {
    const add = vi.spyOn(document, "addEventListener");
    const first = { accept: vi.fn(), decline: vi.fn() };
    const second = { accept: vi.fn(), decline: vi.fn() };
    const { rerender } = render(<Host keep onAccept={first.accept} onDecline={first.decline} />);
    expect(count(add)).toBe(3);
    act(() => checkbox().focus()); // the user moved on to the checkbox; a re-run of the mount effect would pull the focus back to the button
    rerender(<Host keep nonce={1} onAccept={second.accept} onDecline={second.decline} />);
    expect(count(add)).toBe(3);
    expect(checkbox()).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Also tick See users" }));
    expect(second.accept).toHaveBeenCalledTimes(1);
    expect(first.accept).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(second.decline).toHaveBeenCalledTimes(1);
    expect(first.decline).not.toHaveBeenCalled();
  });

  it("removes what it added, also after React StrictMode mounted it twice, and answers a key once", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const onDecline = vi.fn();
    const { unmount } = render(<StrictMode><Host keep onDecline={onDecline} /></StrictMode>);
    expect(count(add) - count(remove), "one set is live").toBe(3);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDecline).toHaveBeenCalledTimes(1);
    unmount();
    expect(count(add)).toBe(count(remove));
  });
});
