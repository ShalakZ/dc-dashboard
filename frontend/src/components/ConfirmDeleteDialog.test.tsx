import { act, cleanup, render, screen } from "@testing-library/react";
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
