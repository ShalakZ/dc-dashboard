import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
