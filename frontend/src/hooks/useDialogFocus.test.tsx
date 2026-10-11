import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { useDialogFocus } from "./useDialogFocus";

function Dialog({ label, onClose, busy = false }: { label: string; onClose: () => void; busy?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const preferred = useRef<HTMLInputElement>(null);
  useDialogFocus(root, onClose, { busy, initial: preferred });
  return (
    <div ref={root} role="dialog" aria-label={label}>
      <button>{label} first</button>
      <input aria-label={`${label} preferred`} ref={preferred} />
    </div>
  );
}

describe("useDialogFocus", () => {
  it("moves focus to the preferred control and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Dialog label="a" onClose={onClose} />);
    expect(screen.getByLabelText("a preferred")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while busy", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog label="a" onClose={onClose} busy />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Dialog label="a" onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls focus back inside when it escapes, and gives it back to the opener when the dialog goes away", () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    try {
      opener.focus();
      render(<Dialog label="a" onClose={vi.fn()} />);
      outside.focus();
      expect(screen.getByRole("button", { name: "a first" })).toHaveFocus();
      cleanup();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
      outside.remove();
    }
  });

  it("lets only the top-most of two open dialogs trap focus and take Escape", async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const { rerender } = render(<><Dialog label="a" onClose={closeA} /><Dialog label="b" onClose={closeB} /></>);
      expect(screen.getByLabelText("b preferred")).toHaveFocus();
      outside.focus();
      expect(screen.getByRole("dialog", { name: "b" })).toContainElement(document.activeElement as HTMLElement);
      await userEvent.keyboard("{Escape}");
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeA).not.toHaveBeenCalled();
      rerender(<><Dialog label="a" onClose={closeA} /></>);
      await userEvent.keyboard("{Escape}");
      expect(closeA).toHaveBeenCalledTimes(1);
    } finally {
      outside.remove();
    }
  });

  it("wraps Tab between the first and the last control, and lets the browser move on inside", async () => {
    render(<Dialog label="a" onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "a first" });
    const last = screen.getByLabelText("a preferred");
    expect(last).toHaveFocus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(first).toHaveFocus();
    await userEvent.tab();
    expect(last).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("brings the focus back in on Tab when it was lost to the body, and wraps only in the top-most of two dialogs", async () => {
    const { rerender } = render(<><Dialog label="a" onClose={vi.fn()} /><Dialog label="b" onClose={vi.fn()} /></>);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "b first" })).toHaveFocus();
    await userEvent.tab({ shift: true }); // the first of b goes to the last of b, not into a
    expect(screen.getByLabelText("b preferred")).toHaveFocus();
    rerender(<><Dialog label="a" onClose={vi.fn()} /></>);
    expect(screen.getByRole("dialog", { name: "a" })).toContainElement(document.activeElement as HTMLElement);
  });
});
