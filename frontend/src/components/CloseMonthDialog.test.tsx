import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { CloseMonthDialog } from "./CloseMonthDialog";

const PATH = "/api/billing/months/2026-09/close";

/** A page with an opener between two other buttons; the dialog closes through `onClose` first, as the Billing page's does. */
function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">before</button>
      <button type="button" onClick={() => setOpen(true)}>Close month…</button>
      {open && <CloseMonthDialog month="2026-09" onClose={() => { onClose?.(); setOpen(false); }} />}
      <button type="button">after</button>
    </>
  );
}

const base: Routes = {
  "GET /api/me": { body: userFor("admin") },
  "GET /api/setup": { body: { needed: false } },
  [`POST ${PATH}`]: { status: 201, body: { closed: { id: 1 } } },
};

async function open(routes: Routes = {}, onClose?: () => void) {
  const calls = mockFetch({ ...base, ...routes });
  const toasts = spyToasts();
  renderWithProviders(<Host onClose={onClose} />, { toasts: toasts.api });
  const opener = screen.getByRole("button", { name: "Close month…" });
  await userEvent.click(opener);
  return { calls, toasts, opener };
}
const posts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST" && c.path === PATH);
const note = () => screen.getByRole("textbox", { name: "Note (optional)" });
const confirm = () => screen.getByRole("button", { name: "Close month" });
const cancel = () => screen.getByRole("button", { name: "Cancel" });

describe("CloseMonthDialog", () => {
  it("is a modal dialog titled with the month, saying what closing does and that it can be undone", async () => {
    await open();
    const dialog = screen.getByRole("dialog", { name: "Close September 2026" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent(
      "Freeze the figures of September 2026 as they are now. Later changes to assets, mappings or rates will not change them. You can reopen the month later, with a reason.",
    );
    expect(confirm()).toHaveClass("primary");
    expect(confirm()).toHaveAttribute("type", "submit");
    expect(cancel()).toHaveAttribute("type", "button");
  });

  it("puts the focus in the note field, and gives it back to the opener when the dialog goes away", async () => {
    const { opener } = await open();
    expect(note()).toHaveFocus();
    await userEvent.click(cancel());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("Escape closes the dialog and nothing else, and sends nothing", async () => {
    const onClose = vi.fn();
    const { calls, opener } = await open({}, onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(posts(calls)).toHaveLength(0);
  });

  it("Tab wraps from the last control to the first and Shift+Tab back, so the page behind is never reached", async () => {
    await open();
    expect(note()).toHaveFocus();
    await userEvent.tab();
    expect(cancel()).toHaveFocus();
    await userEvent.tab();
    expect(confirm()).toHaveFocus();
    await userEvent.tab();
    expect(note()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm()).toHaveFocus();
    expect(screen.getByRole("button", { name: "before" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "after" })).not.toHaveFocus();
  });

  it("closes with a note: the trimmed text is sent, a toast says the month is closed, and the dialog goes", async () => {
    const onClose = vi.fn();
    const { calls, toasts, opener } = await open({}, onClose);
    await userEvent.type(note(), "  First official bill  ");
    await userEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts(calls).map((c) => c.body)).toEqual([{ note: "First official bill" }]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "September 2026 closed" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes without a note: the body carries an empty note", async () => {
    const { calls } = await open();
    await userEvent.click(confirm());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts(calls).map((c) => c.body)).toEqual([{ note: "" }]);
  });

  it("limits the note to 500 characters and counts them without moving anything", async () => {
    await open();
    expect(note()).toHaveAttribute("maxlength", "500");
    expect(screen.getByText("0/500")).toBeInTheDocument();
    await userEvent.type(note(), "abc");
    expect(screen.getByText("3/500")).toBeInTheDocument();
    expect(screen.getByText("3/500")).not.toHaveAttribute("aria-live"); // the count is not an announcer
  });

  it("shows the server's refusal inside the dialog, keeps the dialog and the focus, and a second try works", async () => {
    const onClose = vi.fn();
    let attempt = 0;
    const { calls, toasts } = await open({
      [`POST ${PATH}`]: () => (++attempt === 1 ? { status: 409, body: { detail: "that month is already closed by Sam on 2026-10-14" } } : { status: 201, body: {} }),
    }, onClose);
    await userEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent("that month is already closed by Sam on 2026-10-14");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(confirm()).toHaveFocus(); // the focus never fell to the page
    expect(confirm()).not.toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(toasts.calls).toEqual([]);
    await userEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts(calls)).toHaveLength(2);
    expect(toasts.calls).toEqual([{ kind: "success", text: "September 2026 closed" }]);
  });

  it("keeps a room for the error: the line is in the dialog before any error comes", async () => {
    await open();
    const slot = document.querySelector(".month-slot")!;
    expect(slot).not.toBeNull();
    expect(slot.textContent).toBe("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a double click sends one request, and while it runs the buttons wait with aria-disabled (not disabled) and Escape does not close", async () => {
    const calls = mockFetch({ ...base });
    const held = holdFetch((method, path) => method === "POST" && path === PATH);
    const toasts = spyToasts();
    renderWithProviders(<Host />, { toasts: toasts.api });
    await userEvent.click(screen.getByRole("button", { name: "Close month…" }));
    await userEvent.dblClick(confirm());
    await waitFor(() => expect(confirm()).toHaveAttribute("aria-disabled", "true"));
    expect(confirm()).not.toBeDisabled();
    expect(cancel()).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(cancel());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    held.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts(calls)).toHaveLength(1);
    expect(toasts.calls).toHaveLength(1);
  });
});
