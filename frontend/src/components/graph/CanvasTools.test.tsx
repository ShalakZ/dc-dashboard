import { ReactFlowProvider } from "@xyflow/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import type { FindEntry, FindResult } from "../../lib/graphFind";
import { CanvasTools } from "./CanvasTools";

const ENTRIES: FindEntry[] = [
  { id: "src:1", kind: "source", label: "Plant OPC", context: "source", text: "plant opc", icon: "protoOpcua" },
  { id: "pt:3", kind: "point", label: "LVP01 kW", context: "point in LVP01", text: "lvp01 kw", icon: "rate" },
];
const search = (q: string): FindResult => ({ items: ENTRIES.filter((e) => e.text.includes(q.toLowerCase())), more: 0 });

/** The bar's Find button stands outside the canvas; the page owns the open state, so the test does too. */
function mount(open = true) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  const triggerRef = createRef<HTMLButtonElement>();
  const tree = (isOpen: boolean) => (
    <>
      <button type="button" ref={triggerRef}>Find</button>
      <ReactFlowProvider>
        <CanvasTools search={search} onChoose={onChoose} open={isOpen} onClose={onClose} triggerRef={triggerRef} cardId="find-card" />
      </ReactFlowProvider>
    </>
  );
  const view = render(tree(open));
  return { ...view, onChoose, onClose, triggerRef, rerender: (isOpen: boolean) => view.rerender(tree(isOpen)) };
}
const trigger = () => screen.getByRole("button", { name: "Find" });

describe("CanvasTools (the Find card's panel)", () => {
  it("draws nothing while the card is closed", () => {
    mount(false);
    expect(document.querySelector(".graph-tools")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("is the top-right panel with the card in it and no button of its own (Find and Snap live in the bar)", () => {
    mount();
    const panel = document.querySelector(".graph-tools") as HTMLElement;
    expect(panel).toHaveClass("react-flow__panel", "top", "right");
    expect(panel.querySelector(".graph-find")).toHaveAttribute("id", "find-card");
    expect(panel.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Snap to grid" })).toBeNull();
    expect(screen.getAllByRole("button")).toEqual([trigger()]); // the only button is the test's stand-in for the bar's
  });

  it("opens with the focus in the card's field", () => {
    mount();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("the card appears and goes with `open`", () => {
    const { rerender } = mount(false);
    rerender(true);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    rerender(false);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector(".graph-tools")).toBeNull();
  });

  it("Escape asks to close and the focus returns to the bar's Find button", async () => {
    const { onClose } = mount();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger()).toHaveFocus();
  });

  it("choosing a result reports the entry, asks to close and the focus returns to the Find button", async () => {
    const { onChoose, onClose } = mount();
    await userEvent.type(screen.getByRole("combobox"), "lvp{Enter}");
    expect(onChoose).toHaveBeenCalledWith(ENTRIES[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger()).toHaveFocus();
  });

  it("a press outside the card asks to close it, but a press on the Find button does not (its click toggles)", async () => {
    const { onClose } = mount();
    await userEvent.pointer({ keys: "[MouseLeft>]", target: trigger() });
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.pointer({ keys: "[/MouseLeft]", target: trigger() });
    await userEvent.pointer({ keys: "[MouseLeft]", target: document.body });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
