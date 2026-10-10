import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { Modal, useModalBusy } from "./Modal";

/** A page with an opener button between two other buttons; the modal shows `children` and closes through `onClose` first. */
function Host({ children, onClose }: { children?: ReactNode; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button>before</button>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal title="Edit thing" onClose={() => { onClose?.(); setOpen(false); }}>
          {children ?? <input aria-label="First" />}
        </Modal>
      )}
      <button>after</button>
    </>
  );
}

/** Content whose field is not there yet when the dialog mounts (as the connector list of the Add source form). */
function LateField() {
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 20); return () => clearTimeout(t); }, []);
  return ready ? <input aria-label="Late" /> : <p>loading</p>;
}

/** A child that reports itself busy while it is toggled on (each press of its button flips it). */
function BusyChild() {
  const [busy, setBusy] = useState(false);
  useModalBusy(busy);
  return <button onClick={() => setBusy((b) => !b)}>toggle busy</button>;
}

describe("Modal", () => {
  it("is a modal dialog named by its title", () => {
    render(<Modal title="Add asset" onClose={() => {}}><p>body</p></Modal>);
    const dialog = screen.getByRole("dialog", { name: "Add asset" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Add asset" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("body");
  });

  it("puts focus on the first field", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByLabelText("First")).toHaveFocus();
  });

  it("Escape calls onClose", async () => {
    const onClose = vi.fn();
    render(<Modal title="t" onClose={onClose}><input aria-label="First" /></Modal>);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape after a re-render calls the new onClose, not the first one", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Modal title="t" onClose={first}><input aria-label="First" /></Modal>);
    rerender(<Modal title="t" onClose={second}><input aria-label="First" /></Modal>);
    await userEvent.keyboard("{Escape}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a re-render does not move focus out of the field the user is in", async () => {
    const { rerender } = render(<Modal title="t" onClose={() => {}}><input aria-label="First" /><input aria-label="Second" /></Modal>);
    await userEvent.click(screen.getByLabelText("Second"));
    rerender(<Modal title="t" onClose={() => {}}><input aria-label="First" /><input aria-label="Second" /></Modal>);
    expect(screen.getByLabelText("Second")).toHaveFocus();
  });

  it("returns focus to the opener when it goes away", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);
    expect(screen.getByLabelText("First")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("still returns focus to the opener under StrictMode", async () => {
    render(<StrictMode><Host /></StrictMode>);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);
    expect(screen.getByLabelText("First")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("focus stays inside when Tab and Shift+Tab leave the last and the first control", async () => {
    render(<Host><input aria-label="First" /><button>Save</button></Host>);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog");
    expect(screen.getByLabelText("First")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await userEvent.tab(); // would be "after"
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.tab({ shift: true }); // would be "Open"
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("content that appears after mount: focus is on the dialog first, and Tab then stays inside", async () => {
    render(<Host><LateField /></Host>);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus(); // nothing to focus yet: the dialog itself holds focus, not the button behind it
    const late = await screen.findByLabelText("Late");
    await userEvent.tab();
    expect(late).toHaveFocus();
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  describe("while a child reports busy", () => {
    it("Escape does nothing, and works again once the child is no longer busy", async () => {
      const onClose = vi.fn();
      render(<Modal title="t" onClose={onClose}><BusyChild /></Modal>);
      await userEvent.click(screen.getByRole("button", { name: "toggle busy" }));
      await userEvent.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "toggle busy" }));
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("stays busy until every busy child is done", async () => {
      const onClose = vi.fn();
      render(<Modal title="t" onClose={onClose}><BusyChild /><BusyChild /></Modal>);
      const [one, two] = screen.getAllByRole("button", { name: "toggle busy" });
      await userEvent.click(one);
      await userEvent.click(two);
      await userEvent.click(one);
      await userEvent.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.click(two);
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("is a no-op outside a Modal", () => {
      function Alone() { useModalBusy(true); return <p>alone</p>; }
      render(<Alone />);
      expect(screen.getByText("alone")).toBeInTheDocument();
    });
  });

  describe("Tab inside the dialog", () => {
    const three = <><input aria-label="First" /><input aria-label="Middle" /><button>Last</button></>;

    it("from the last control goes to the first, and the browser's own move is cancelled", async () => {
      render(<Host>{three}</Host>);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      const last = screen.getByRole("button", { name: "Last" });
      last.focus();
      expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false); // false = default prevented
      expect(screen.getByLabelText("First")).toHaveFocus();
    });

    it("Shift+Tab from the first control lands on the last, not on the page behind", async () => {
      render(<Host>{three}</Host>);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      expect(screen.getByLabelText("First")).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    });

    it("Shift+Tab from the dialog itself lands on the last control", async () => {
      render(<Host>{three}</Host>);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      screen.getByRole("dialog").focus();
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    });

    it("in the middle is left to the browser: not intercepted, and a real Tab moves on one control", async () => {
      render(<Host>{three}</Host>);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      const middle = screen.getByLabelText("Middle");
      middle.focus();
      expect(fireEvent.keyDown(middle, { key: "Tab" })).toBe(true);
      expect(fireEvent.keyDown(middle, { key: "Tab", shiftKey: true })).toBe(true);
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    });

    it("a full Tab then Shift+Tab round trip with real key presses", async () => {
      render(<Host>{three}</Host>);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      await userEvent.tab();
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByLabelText("First")).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    });
  });
});
