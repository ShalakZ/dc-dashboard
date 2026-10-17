import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutsBubble } from "./ShortcutsBubble";

type Handle = { open(): void } | null;
const NAME = "Keyboard shortcuts and controls";
const button = () => screen.getByRole("button", { name: NAME });
const bubble = () => screen.queryByRole("dialog", { name: NAME });

/** The bubble beside a stand-in for the canvas (a focusable element that is not the button), the way the page uses it. */
function setup() {
  const openRef = createRef<Handle>() as { current: Handle };
  const view = render(
    <>
      <div tabIndex={0} data-testid="canvas">canvas</div>
      <ShortcutsBubble openRef={openRef} />
      <button type="button">after</button>
    </>,
  );
  return { openRef, canvas: screen.getByTestId("canvas"), ...view };
}

describe("ShortcutsBubble", () => {
  it("is one closed button with the named attributes, and the bubble is not in the page", () => {
    setup();
    expect(button()).toHaveAttribute("type", "button");
    expect(button()).toHaveAttribute("aria-haspopup", "dialog");
    expect(button()).toHaveAttribute("aria-expanded", "false");
    expect(button()).toHaveAttribute("aria-keyshortcuts", "?");
    expect(button()).not.toHaveAttribute("aria-controls");
    expect(button().querySelector("svg.i")).not.toBeNull();
    expect(bubble()).toBeNull();
    expect(screen.queryByText("Move and select")).toBeNull();
  });

  it("opens on a click: a dialog portaled on the body, named, not modal, with the focus inside it", async () => {
    setup();
    await userEvent.click(button());
    const box = bubble()!;
    expect(box).not.toBeNull();
    expect(box.parentElement).toBe(document.body);
    expect(box).toHaveClass("gkeys");
    expect(box).not.toHaveAttribute("aria-modal");
    expect(box).toHaveAttribute("tabindex", "-1");
    expect(box).toHaveFocus();
    expect(button()).toHaveAttribute("aria-expanded", "true");
    expect(button()).toHaveAttribute("aria-controls", box.id);
    await userEvent.click(button());
    expect(bubble()).toBeNull();
    expect(button()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens from the ? path through openRef, and the handle is gone after unmount", () => {
    const { openRef, canvas, unmount } = setup();
    canvas.focus();
    expect(openRef.current).not.toBeNull();
    act(() => openRef.current!.open());
    expect(bubble()).toHaveFocus();
    expect(button()).toHaveAttribute("aria-expanded", "true");
    unmount();
    expect(openRef.current).toBeNull();
  });

  it("lists six groups with a visible title each, and the keys as key caps", async () => {
    setup();
    await userEvent.click(button());
    const box = bubble()!;
    const titles = Array.from(box.querySelectorAll("h3")).map((h) => h.textContent);
    expect(titles).toEqual(["Move and select", "Camera", "Find", "Menus", "Mapping", "Navigation"]);
    const caps = Array.from(box.querySelectorAll("kbd")).map((k) => k.textContent);
    for (const key of ["Alt", "Option", "Shift", "Ctrl", "Cmd", "K", "Shift", "F10", "Enter", "Space", "Escape", "Z", "?", "Menu"]) expect(caps).toContain(key);
    for (const k of Array.from(box.querySelectorAll("kbd"))) expect(k).toHaveClass("gkeys-key");
    // the plan's wording, spot checks: one line from each group
    expect(box).toHaveTextContent("Alt or Option + drag");
    expect(box).toHaveTextContent("Scroll to zoom");
    expect(box).toHaveTextContent("Fit view");
    expect(box).toHaveTextContent("Right-click");
    expect(box).toHaveTextContent("Create assets");
    expect(box).toHaveTextContent("Undo the last mapping change");
    expect(box).toHaveTextContent("a mapped point shows its last value");
  });

  it("Escape closes it and gives the focus back to the button when the button opened it", async () => {
    setup();
    await userEvent.click(button());
    await userEvent.keyboard("{Escape}");
    expect(bubble()).toBeNull();
    expect(button()).toHaveFocus();
    expect(button()).toHaveAttribute("aria-expanded", "false");
  });

  it("Escape gives the focus back to the element that had it before ? opened the bubble", () => {
    const { openRef, canvas } = setup();
    canvas.focus();
    act(() => openRef.current!.open());
    expect(bubble()).toHaveFocus();
    fireEvent.keyDown(bubble()!, { key: "Escape" });
    expect(bubble()).toBeNull();
    expect(canvas).toHaveFocus();
  });

  it("falls back to the button when the element that opened it is gone", () => {
    const { openRef } = setup();
    const outside = document.body.appendChild(document.createElement("div")); // not React's: React would trip over losing a node of its own
    outside.tabIndex = 0;
    outside.focus();
    act(() => openRef.current!.open());
    outside.remove();
    fireEvent.keyDown(bubble()!, { key: "Escape" });
    expect(bubble()).toBeNull();
    expect(button()).toHaveFocus();
  });

  it("Escape closes only the bubble: the key is swallowed before a listener on the document (a dialog) sees it", async () => {
    setup();
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    try {
      await userEvent.click(button());
      seen.mockClear();
      await userEvent.keyboard("{Escape}");
      expect(bubble()).toBeNull();
      expect(seen).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}"); // closed now: the next Escape belongs to whoever is below
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", seen);
    }
  });

  it("Tab and Shift+Tab inside it close it and land on the opener, never on the body", async () => {
    const { openRef, canvas } = setup();
    canvas.focus();
    act(() => openRef.current!.open());
    expect(bubble()).toHaveFocus();
    await userEvent.tab();
    expect(bubble()).toBeNull();
    expect(canvas).toHaveFocus();
    await userEvent.click(button());
    expect(bubble()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(bubble()).toBeNull();
    expect(button()).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("a press outside closes it, a press on its own button or on the bubble does not", async () => {
    setup();
    await userEvent.click(button());
    fireEvent.pointerDown(bubble()!);
    fireEvent.pointerDown(button());
    expect(bubble()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText("canvas"));
    expect(bubble()).toBeNull();
  });

  it("two opens in a row do not stack, and the second does not make the bubble its own opener", () => {
    const { openRef, canvas } = setup();
    canvas.focus();
    act(() => openRef.current!.open());
    act(() => openRef.current!.open());
    expect(screen.getAllByRole("dialog", { name: NAME })).toHaveLength(1);
    expect(bubble()).toHaveFocus();
    fireEvent.keyDown(bubble()!, { key: "Escape" });
    expect(canvas).toHaveFocus();
  });

  it("a click on the bubble does not reach a handler of the element around it (React events cross a portal)", async () => {
    const outer = vi.fn();
    render(<div onClick={outer}><ShortcutsBubble openRef={{ current: null }} /></div>);
    await userEvent.click(button());
    outer.mockClear();
    await userEvent.click(bubble()!);
    expect(outer).not.toHaveBeenCalled();
  });

  describe("scrolling and resizing", () => {
    let clock = 10_000;
    beforeEach(() => { clock = 10_000; vi.spyOn(performance, "now").mockImplementation(() => clock); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("closes on a scroll outside it and on a resize, because the fixed bubble would be left behind", async () => {
      setup();
      await userEvent.click(button());
      clock += 500;
      fireEvent.scroll(window);
      expect(bubble()).toBeNull();
      await userEvent.click(button());
      expect(bubble()).not.toBeNull();
      fireEvent(window, new Event("resize"));
      expect(bubble()).toBeNull();
    });

    it("a scroll inside the bubble (it scrolls at a small window) does not close it", async () => {
      setup();
      await userEvent.click(button());
      clock += 500;
      fireEvent.scroll(bubble()!);
      expect(bubble()).not.toBeNull();
    });
  });
});
