import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

function open(onConfirm: () => Promise<unknown> = async () => undefined) {
  const onCancel = vi.fn();
  render(<ConfirmDeleteDialog title='Delete "Site"?' message="4 assets will be deleted." onConfirm={onConfirm} onCancel={onCancel} />);
  return { onCancel, onConfirm };
}

describe("ConfirmDeleteDialog", () => {
  it("is a labelled modal dialog that states the message, with Cancel and a destructive Delete anyway", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: 'Delete "Site"?' });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("4 assets will be deleted.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete anyway" })).toHaveClass("danger");
  });

  it("starts on Cancel, and Cancel and Escape cancel without confirming", async () => {
    const { onCancel, onConfirm } = open(vi.fn(async () => undefined));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Delete anyway confirms once, and the buttons stay disabled while it runs", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { onCancel } = open(onConfirm);
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}"); // not while the request is in flight
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeEnabled();
  });

  it("shows why the confirmed request failed and stays open", async () => {
    const { onCancel } = open(async () => { throw new ApiError(403, "admin role required"); });
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("admin role required");
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeEnabled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // W7r fix wave: Remove and Clear unmapped are plain dialogs (no choice) that are refused more often than not (a scan runs: 409; every listed source
  // was kept). Chrome drops the focus of the confirm button the moment it is disabled for the request, so the dialog stayed open with the focus on <body>.
  it("a refused request leaves the focus on a control inside the dialog, not on the body (a dialog without a choice too)", async () => {
    let refuse!: (error: Error) => void;
    // What Chrome does to a focused button that becomes disabled: the focus is gone. jsdom ignores a blur on a disabled element, so the blur is done
    // here, at the start of the request, while the button is still enabled in the DOM (React has not committed busy yet).
    const onConfirm = vi.fn(() => { (document.activeElement as HTMLElement).blur(); return new Promise<void>((_resolve, reject) => { refuse = reject; }); });
    const { onCancel } = open(onConfirm);
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(document.activeElement).toBe(document.body);
    await act(async () => refuse(new ApiError(409, "A scan is running")));
    expect(screen.getByRole("alert")).toHaveTextContent("A scan is running");
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // the harmless first control, as when the dialog opened
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps focus inside, and gives it back to where it was when it goes away", () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    opener.focus();
    try {
      open();
      expect(opener).not.toHaveFocus();
      outside.focus();
      expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
      cleanup();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
      outside.remove();
    }
  });

  describe("the Tab key wraps inside the dialog (it sits last in the body, so the browser would leave the page for its own chrome)", () => {
    // A control on the page behind, before the dialog in document order. `leaks` counts every time focus reached it, even for an instant
    // (a leak that keepFocus pulls back at once is still a leak: the screen reader announced the page behind).
    let behind: HTMLButtonElement;
    let leaks: number;
    const note = (event: FocusEvent) => { if (event.target === behind) leaks += 1; };
    beforeEach(() => {
      behind = document.createElement("button");
      document.body.prepend(behind);
      leaks = 0;
      document.addEventListener("focusin", note);
    });
    afterEach(() => {
      document.removeEventListener("focusin", note);
      behind.remove();
    });

    it("Tab from the last button goes to the first, and Shift+Tab from the first goes to the last, without ever touching the page behind", async () => {
      open();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const confirm = screen.getByRole("button", { name: "Delete anyway" });
      expect(cancel).toHaveFocus();
      await userEvent.tab();
      expect(confirm).toHaveFocus();
      await userEvent.tab(); // from the last: round to the first
      expect(cancel).toHaveFocus();
      await userEvent.tab({ shift: true }); // from the first: round to the last
      expect(confirm).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(cancel).toHaveFocus();
      expect(leaks).toBe(0);
    });

    it("cancels the browser's own move only at the edges (a cancelled keydown is what stops the browser from moving the focus itself)", () => {
      open();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const confirm = screen.getByRole("button", { name: "Delete anyway" });
      expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true); // middle: the browser moves on to the confirm button
      confirm.focus();
      expect(fireEvent.keyDown(confirm, { key: "Tab" })).toBe(false); // last, forwards
      expect(cancel).toHaveFocus();
      expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(false); // first, backwards
      expect(confirm).toHaveFocus();
      expect(fireEvent.keyDown(confirm, { key: "Tab", shiftKey: true })).toBe(true); // middle again
    });

    it("skips a disabled confirm button: with only Cancel usable, Tab and Shift+Tab stay on it", async () => {
      render(<ConfirmDeleteDialog title="t" message="" onConfirm={async () => {}} onCancel={() => {}} loading />);
      const cancel = screen.getByRole("button", { name: "Cancel" });
      expect(screen.getByRole("button", { name: "Delete anyway" })).toBeDisabled();
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(cancel).toHaveFocus();
      expect(leaks).toBe(0);
    });

    it("counts the confirm button as the last control as soon as it is enabled", async () => {
      const props = { title: "t", message: "", onConfirm: async () => {}, onCancel: () => {} };
      const { rerender } = render(<ConfirmDeleteDialog {...props} loading />);
      rerender(<ConfirmDeleteDialog {...props} confirmLabel="Delete" />);
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
      expect(leaks).toBe(0);
    });

    it("keeps the focus away from the page behind while the confirmed request runs and both buttons are disabled", async () => {
      let finish!: () => void;
      open(() => new Promise<void>((resolve) => { finish = resolve; }));
      await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
      expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(false); // nothing to move to, and the page behind is not an option
      await act(async () => finish());
    });
  });

  it("labels the confirm button with confirmLabel and keeps 'Delete anyway' by default", () => {
    const props = { title: "t", message: "m", onConfirm: async () => {}, onCancel: () => {} };
    const { rerender } = render(<ConfirmDeleteDialog {...props} />);
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    rerender(<ConfirmDeleteDialog {...props} confirmLabel="Save and delete" />);
    expect(screen.getByRole("button", { name: "Save and delete" })).toBeInTheDocument();
  });

  describe("while the server is still being asked what the delete takes (loading)", () => {
    const props = { title: 'Delete "Site"?', message: "", onConfirm: async () => {}, onCancel: () => {} };

    it("says it is checking, in the polite region the dialog is described by, and shows no message yet", () => {
      render(<ConfirmDeleteDialog {...props} message="4 assets will be deleted." loading />);
      const dialog = screen.getByRole("dialog", { name: 'Delete "Site"?' });
      const line = screen.getByText("Checking what this deletes…");
      expect(line.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
      expect(line.closest("[aria-live]")).not.toHaveAttribute("role"); // a role="status" here would join every existing status lookup
      expect(dialog).toHaveAttribute("aria-describedby", line.closest("[aria-live]")!.id);
      expect(screen.queryByText("4 assets will be deleted.")).not.toBeInTheDocument();
    });

    it("keeps the confirm button disabled and Cancel usable; Escape cancels", async () => {
      const onCancel = vi.fn();
      const onConfirm = vi.fn(async () => {});
      render(<ConfirmDeleteDialog {...props} onConfirm={onConfirm} onCancel={onCancel} loading />);
      expect(screen.getByRole("button", { name: "Delete anyway" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
      expect(onConfirm).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("the same polite region then carries the message, and the confirm button comes alive", () => {
      const { rerender } = render(<ConfirmDeleteDialog {...props} loading />);
      const region = screen.getByText("Checking what this deletes…").closest("[aria-live]")!;
      rerender(<ConfirmDeleteDialog {...props} message="This can't be undone." confirmLabel="Delete" />);
      expect(screen.queryByText("Checking what this deletes…")).not.toBeInTheDocument();
      expect(screen.getByText("This can't be undone.").closest("[aria-live]")).toBe(region); // one region: the sentence is announced when it arrives
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-describedby", region.id);
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });
  });

  // W18 R4: a second paragraph of its own under the message, in the same polite region (so it is part of what the dialog is described by), not drawn
  // while the numbers load and not drawn when empty.
  describe("a note under the message", () => {
    const props = { title: 'Delete "Site"?', message: "4 assets will be deleted.", onConfirm: async () => {}, onCancel: () => {} };

    it("is its own paragraph inside the region the dialog is described by, after the message, with no role of its own", () => {
      render(<ConfirmDeleteDialog {...props} note="Close the month first." />);
      const dialog = screen.getByRole("dialog", { name: 'Delete "Site"?' });
      const described = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
      const note = screen.getByText("Close the month first.");
      expect(note.tagName).toBe("P");
      expect(note).toHaveClass("confirm-note");
      expect(described).toContainElement(note);
      expect(described).toHaveAttribute("aria-live", "polite");
      expect(note).not.toHaveAttribute("role");
      expect(described.querySelectorAll("[aria-live], [role]")).toHaveLength(0); // still one live region
      const paragraphs = Array.from(described.querySelectorAll("p"));
      expect(paragraphs.map((p) => p.textContent)).toEqual(["4 assets will be deleted.", "Close the month first."]); // the message is untouched
    });

    it("is not drawn while the numbers load", () => {
      render(<ConfirmDeleteDialog {...props} message="" note="Close the month first." loading />);
      expect(screen.queryByText("Close the month first.")).not.toBeInTheDocument();
      expect(screen.getByText("Checking what this deletes…")).toBeInTheDocument();
    });

    it("is not drawn when it is empty or absent", () => {
      const { rerender } = render(<ConfirmDeleteDialog {...props} note="" />);
      expect(document.querySelector(".confirm-note")).toBeNull();
      rerender(<ConfirmDeleteDialog {...props} />);
      expect(document.querySelector(".confirm-note")).toBeNull();
      expect(screen.getByRole("dialog")).toHaveTextContent("4 assets will be deleted.");
    });
  });

  describe("when the preview could not be loaded (loadError)", () => {
    it("shows the error, keeps the confirm button disabled, and Cancel still closes", async () => {
      const onCancel = vi.fn();
      const onConfirm = vi.fn(async () => {});
      render(<ConfirmDeleteDialog title="t" message="" onConfirm={onConfirm} onCancel={onCancel} loadError="Asset 7 not found" />);
      expect(screen.getByRole("alert")).toHaveTextContent("Asset 7 not found");
      expect(screen.getByRole("button", { name: "Delete anyway" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
      expect(onConfirm).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("blocked (it can never be confirmed from here)", () => {
    const props = { title: 'Delete the kind "Rack"?', message: "", onConfirm: async () => {}, onCancel: () => {}, loadError: '12 assets use "Rack", so it can\'t be deleted. Change their kind first.' };

    it("has no confirm button at all, says why, and offers Close in place of Cancel", async () => {
      const onCancel = vi.fn();
      const onConfirm = vi.fn(async () => {});
      render(<ConfirmDeleteDialog {...props} onConfirm={onConfirm} onCancel={onCancel} blocked />);
      expect(screen.getByRole("alert")).toHaveTextContent('12 assets use "Rack", so it can\'t be deleted.');
      expect(screen.queryByRole("button", { name: "Delete anyway" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
      await userEvent.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledTimes(2);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("keeps the message text, and does not change a dialog that is not blocked", () => {
      const { rerender } = render(<ConfirmDeleteDialog {...props} loadError={undefined} message="Nothing else uses it." blocked />);
      expect(screen.getByText("Nothing else uses it.")).toBeInTheDocument();
      rerender(<ConfirmDeleteDialog {...props} loadError={undefined} message="Nothing else uses it." />);
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete anyway" })).toBeEnabled();
    });

    it("moves the focus to Close when the dialog turns blocked while open (the confirm button it was on is gone)", () => {
      const { rerender } = render(<ConfirmDeleteDialog {...props} loadError={undefined} message="m" />);
      screen.getByRole("button", { name: "Delete anyway" }).focus();
      rerender(<ConfirmDeleteDialog {...props} blocked />);
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
  });

  it("gives the focus back to its opener even when the browser took it off already (a page disables its controls while a dialog is open)", async () => {
    function Page() {
      const [asked, setAsked] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      // What Chrome does to a focused button that becomes disabled: the focus is gone before the dialog's own effects run. (jsdom ignores
      // blur() on a disabled element, so the button here stays enabled and is blurred by hand at the same point.)
      useLayoutEffect(() => { if (asked) trigger.current?.blur(); }, [asked]);
      return (
        <>
          <button type="button" ref={trigger} onClick={() => setAsked(true)}>trash</button>
          {asked && <ConfirmDeleteDialog title="t" message="m" onConfirm={async () => {}} onCancel={() => setAsked(false)} />}
        </>
      );
    }
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "trash" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "trash" })).toHaveFocus();
  });

  // W7o: the delete of a kind in use asks where its assets go. The choice is the dialog's `children`, and the confirm button waits for it.
  describe("a choice slot (children) and confirmDisabled", () => {
    const props = { title: 'Delete the kind "Rack"?', message: '12 assets use "Rack".', confirmLabel: "Delete", onCancel: () => {} };
    const choice = <label>Move the assets to<select defaultValue=""><option value="">Choose a kind…</option><option value="2">Pump</option></select></label>;

    it("renders the children between the message and the buttons, OUTSIDE the polite region the dialog is described by", () => {
      render(<ConfirmDeleteDialog {...props} onConfirm={async () => {}}>{choice}</ConfirmDeleteDialog>);
      const select = screen.getByLabelText("Move the assets to");
      const body = screen.getByText('12 assets use "Rack".').closest("[aria-live]")!;
      expect(select.closest("[aria-live]")).toBeNull(); // a select inside it would be announced again with every change and read into the description
      expect(body.contains(select)).toBe(false);
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-describedby", body.id);
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription('12 assets use "Rack".');
      const position = (a: Element, b: Element) => a.compareDocumentPosition(b);
      expect(position(body, select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(position(select, screen.getByRole("button", { name: "Cancel" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("draws no slot when there are no children (the dialog is as it was)", () => {
      render(<ConfirmDeleteDialog {...props} onConfirm={async () => {}} />);
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Delete"]);
    });

    it("keeps the confirm button off while confirmDisabled, starts on Cancel, and a click confirms nothing", async () => {
      const onConfirm = vi.fn(async () => {});
      const { rerender } = render(<ConfirmDeleteDialog {...props} onConfirm={onConfirm} confirmDisabled>{choice}</ConfirmDeleteDialog>);
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // initial focus is Cancel, so the native disabled costs the focus nothing
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(onConfirm).not.toHaveBeenCalled();
      rerender(<ConfirmDeleteDialog {...props} onConfirm={onConfirm}>{choice}</ConfirmDeleteDialog>);
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("Tab walks the choice, then Cancel, and wraps (the confirm button is skipped while it is off)", async () => {
      render(<ConfirmDeleteDialog {...props} onConfirm={async () => {}} confirmDisabled>{choice}</ConfirmDeleteDialog>);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByLabelText("Move the assets to")).toHaveFocus(); // wrapped: Cancel is the last control while Delete is off
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });

    it("hands the focus to the choice when the dialog turns into one that needs it while a request was running (the button it was on is off)", async () => {
      let finish!: () => void;
      const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const { rerender } = render(<ConfirmDeleteDialog {...props} onConfirm={onConfirm} />);
      await userEvent.click(screen.getByRole("button", { name: "Delete" })); // the focus is on Delete, which the running request switches off
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
      // The server answered "assets joined": the page now asks for a target. The dialog is still busy until the request has been settled.
      rerender(<ConfirmDeleteDialog {...props} onConfirm={onConfirm} confirmDisabled>{choice}</ConfirmDeleteDialog>);
      await act(async () => finish());
      expect(screen.getByLabelText("Move the assets to")).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
    });

    it("gives the focus back to the choice after a request that left the choice made and the confirm button enabled (a stale count, a 422): Chrome dropped it with the disabled button", async () => {
      let finish!: () => void;
      // What Chrome does to a focused button that becomes disabled: the focus is gone. jsdom ignores a blur on a disabled element, so the blur is done
      // here, at the start of the request, while the button is still enabled in the DOM (React has not committed busy yet).
      const onConfirm = vi.fn(() => { (document.activeElement as HTMLElement).blur(); return new Promise<void>((resolve) => { finish = resolve; }); });
      render(<ConfirmDeleteDialog {...props} onConfirm={onConfirm}>{choice}</ConfirmDeleteDialog>);
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(document.activeElement).toBe(document.body);
      await act(async () => finish());
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(screen.getByLabelText("Move the assets to")).toHaveFocus();
    });

    it("leaves the focus alone when it is still inside and enabled (somebody tabbing through the choice is not pulled back)", async () => {
      render(<ConfirmDeleteDialog {...props} onConfirm={async () => {}} confirmDisabled>{choice}</ConfirmDeleteDialog>);
      screen.getByLabelText("Move the assets to").focus();
      await userEvent.selectOptions(screen.getByLabelText("Move the assets to"), "2");
      expect(screen.getByLabelText("Move the assets to")).toHaveFocus();
    });
  });

  // W7o fix wave: the opener's one line for "what you saw has changed" (the count moved under the dialog). It is the error line of the dialog, not
  // a second announcer, and unlike an error it does not switch the confirm button off: the question is still answerable.
  describe("notice (a line from the opener, in the error slot)", () => {
    const props = { title: 'Delete the kind "Rack"?', message: '12 assets use "Rack".', confirmLabel: "Delete", onCancel: () => {} };
    const choice = <label>Move the assets to<select defaultValue="2"><option value="">Choose a kind…</option><option value="2">Pump</option></select></label>;

    it("shows the line as the dialog's alert, outside the polite region, and leaves the confirm button on", () => {
      render(<ConfirmDeleteDialog {...props} onConfirm={async () => {}} notice="14 assets use this kind now. Check the new count and try again.">{choice}</ConfirmDeleteDialog>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("14 assets use this kind now. Check the new count and try again.");
      expect(alert).toHaveClass("error");
      expect(alert.closest("[aria-live]")).toBeNull(); // the description stays the sentence about the delete
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription('12 assets use "Rack".');
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });

    it("draws nothing without one and goes as soon as the opener drops it", () => {
      const { rerender } = render(<ConfirmDeleteDialog {...props} onConfirm={async () => {}}>{choice}</ConfirmDeleteDialog>);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      rerender(<ConfirmDeleteDialog {...props} onConfirm={async () => {}} notice="Changed.">{choice}</ConfirmDeleteDialog>);
      expect(screen.getByRole("alert")).toHaveTextContent("Changed.");
      rerender(<ConfirmDeleteDialog {...props} onConfirm={async () => {}}>{choice}</ConfirmDeleteDialog>);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("tone", () => {
    const props = { title: "t", message: "m", onConfirm: async () => {}, onCancel: () => {} };
    it("is danger by default and primary on request (a currency change is not a destruction)", () => {
      const { rerender } = render(<ConfirmDeleteDialog {...props} />);
      expect(screen.getByRole("button", { name: "Delete anyway" })).toHaveClass("danger");
      rerender(<ConfirmDeleteDialog {...props} tone="primary" confirmLabel="Change currency" />);
      const confirm = screen.getByRole("button", { name: "Change currency" });
      expect(confirm).toHaveClass("primary");
      expect(confirm).not.toHaveClass("danger");
    });
  });

  describe("where it lives in the DOM", () => {
    const props = { title: "t", message: "m", onCancel: () => {} };
    it("is rendered into the body, outside whatever form, table row or menu opened it", () => {
      render(<table><tbody><tr><td><ConfirmDeleteDialog {...props} onConfirm={async () => {}} /></td></tr></tbody></table>);
      const backdrop = screen.getByRole("dialog").closest(".dialog-backdrop")!;
      expect(backdrop.parentElement).toBe(document.body);
      expect(document.querySelector("tr .dialog-backdrop")).toBeNull();
    });

    it("has plain buttons: confirming or cancelling inside a form does not submit it", async () => {
      const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
      const onConfirm = vi.fn(async () => {});
      render(<form onSubmit={submit}><ConfirmDeleteDialog {...props} onConfirm={onConfirm} /></form>);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("type", "button");
      expect(screen.getByRole("button", { name: "Delete anyway" })).toHaveAttribute("type", "button");
      await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });
  });
});
