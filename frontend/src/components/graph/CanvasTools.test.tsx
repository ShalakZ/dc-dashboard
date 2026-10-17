import { ReactFlowProvider } from "@xyflow/react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import type { FindEntry, FindResult } from "../../lib/graphFind";
import { CanvasTools } from "./CanvasTools";

const ENTRIES: FindEntry[] = [
  { id: "src:1", kind: "source", label: "Plant OPC", context: "source", text: "plant opc", icon: "protoOpcua" },
  { id: "pt:3", kind: "point", label: "LVP01 kW", context: "point in LVP01", text: "lvp01 kw", icon: "rate" },
];
const search = (q: string): FindResult => ({ items: ENTRIES.filter((e) => e.text.includes(q.toLowerCase())), more: 0 });

function mount(props: { snap?: boolean } = {}) {
  const onChoose = vi.fn();
  const onSnapChange = vi.fn();
  const openRef: RefObject<{ open(): void } | null> = { current: null };
  const view = render(
    <ReactFlowProvider>
      <CanvasTools search={search} onChoose={onChoose} snap={props.snap ?? true} onSnapChange={onSnapChange} openRef={openRef} />
    </ReactFlowProvider>,
  );
  return { onChoose, onSnapChange, openRef, ...view };
}
const find = () => screen.getByRole("button", { name: "Find" });
const snap = () => screen.getByRole("button", { name: "Snap to grid" });

describe("CanvasTools", () => {
  it("is the top-right panel with a Find button and a Snap to grid toggle, both type=button; the card is closed", () => {
    mount();
    expect(document.querySelector(".graph-tools")).toHaveClass("react-flow__panel", "top", "right");
    expect(find()).toHaveAttribute("type", "button");
    expect(snap()).toHaveAttribute("type", "button");
    expect(find()).toHaveAttribute("aria-expanded", "false");
    expect(find()).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it.each([[true], [false]])("Snap to grid reports its state in aria-pressed (snap=%s) and a click asks for the opposite", async (on) => {
    const { onSnapChange } = mount({ snap: on });
    expect(snap()).toHaveAttribute("aria-pressed", String(on));
    await userEvent.click(snap());
    expect(onSnapChange).toHaveBeenCalledWith(!on);
  });

  it("the Find button opens the card with the focus in its field; the button's aria-expanded and aria-controls follow", async () => {
    mount();
    await userEvent.click(find());
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    expect(find()).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(find().getAttribute("aria-controls")!)).toContainElement(input);
    expect(document.getElementById(find().getAttribute("aria-controls")!)).toHaveClass("graph-find");
  });

  it("a second click on Find closes the card (a press on the trigger is not an outside press that reopens it)", async () => {
    mount();
    await userEvent.click(find());
    await userEvent.click(find());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(find()).toHaveAttribute("aria-expanded", "false");
  });

  it("Escape closes the card and the focus returns to the Find button", async () => {
    mount();
    await userEvent.click(find());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(find()).toHaveFocus();
  });

  it("choosing a result closes the card, focuses the Find button and reports the entry", async () => {
    const { onChoose } = mount();
    await userEvent.click(find());
    await userEvent.type(screen.getByRole("combobox"), "lvp{Enter}");
    expect(onChoose).toHaveBeenCalledWith(ENTRIES[1]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("openRef.open() opens the card (what Ctrl+K calls); called again while open it brings the focus back to the field and selects its text", async () => {
    const { openRef } = mount();
    act(() => openRef.current!.open());
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input).toHaveFocus();
    await userEvent.type(input, "lvp");
    snap().focus();
    expect(input).not.toHaveFocus();
    act(() => openRef.current!.open());
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it("the handle goes away with the component", () => {
    const { openRef, unmount } = mount();
    expect(openRef.current).not.toBeNull();
    unmount();
    expect(openRef.current).toBeNull();
  });

  it("the Find button names its shortcut for assistive technology without putting it in the name", () => {
    mount();
    expect(find()).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
  });
});
