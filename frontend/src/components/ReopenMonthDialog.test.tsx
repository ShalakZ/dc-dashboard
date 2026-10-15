import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { ReopenMonthDialog } from "./ReopenMonthDialog";

const PATH = "/api/billing/months/2026-09/reopen";

function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">before</button>
      <button type="button" onClick={() => setOpen(true)}>Reopen month…</button>
      {open && <ReopenMonthDialog month="2026-09" onClose={() => { onClose?.(); setOpen(false); }} />}
      <button type="button">after</button>
    </>
  );
}

const base: Routes = {
  "GET /api/me": { body: userFor("admin") },
  "GET /api/setup": { body: { needed: false } },
  [`POST ${PATH}`]: { body: { month: "2026-09", reopened_at: "2026-10-15T10:00:00Z" } },
};

async function open(routes: Routes = {}, onClose?: () => void) {
  const calls = mockFetch({ ...base, ...routes });
  const toasts = spyToasts();
  renderWithProviders(<Host onClose={onClose} />, { toasts: toasts.api });
  const opener = screen.getByRole("button", { name: "Reopen month…" });
  await userEvent.click(opener);
  return { calls, toasts, opener };
}
const posts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST" && c.path === PATH);
const reason = () => screen.getByRole("textbox", { name: "Reason" });
const confirm = () => screen.getByRole("button", { name: "Reopen month" });
const cancel = () => screen.getByRole("button", { name: "Cancel" });

describe("ReopenMonthDialog", () => {
  it("is a modal dialog that says what reopening does, with the focus in the reason field", async () => {
    await open();
    const dialog = screen.getByRole("dialog", { name: "Reopen September 2026" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent(
      "Reopen September 2026? The page will show live figures again. The closed figures are kept and the reason is recorded in the audit log.",
    );
    expect(reason()).toHaveFocus();
    expect(reason()).toHaveAttribute("aria-required", "true");
    expect(reason()).toHaveAttribute("maxlength", "500");
    expect(confirm()).toHaveClass("primary");
  });

  it("waits with aria-disabled (never native disabled) until the reason has 5 characters, and a click before that sends nothing", async () => {
    const { calls } = await open();
    expect(confirm()).toHaveAttribute("aria-disabled", "true");
    expect(confirm()).not.toBeDisabled();
    await userEvent.click(confirm());
    expect(posts(calls)).toHaveLength(0);
    await userEvent.type(reason(), "abcd");
    expect(confirm()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(confirm());
    expect(posts(calls)).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.type(reason(), "e");
    expect(confirm()).not.toHaveAttribute("aria-disabled");
  });

  it("counts toward 5 and then toward 500, in the same place", async () => {
    await open();
    const count = () => document.querySelector(".month-count")!;
    expect(count()).toHaveTextContent("0/5");
    await userEvent.type(reason(), "abcd");
    expect(count()).toHaveTextContent("4/5");
    await userEvent.type(reason(), "e");
    expect(count()).toHaveTextContent("5/500");
    expect(count()).not.toHaveAttribute("aria-live"); // the count is not an announcer
    expect(reason()).toHaveAccessibleDescription(/5\/500/);
  });

  it("does not count blanks at the ends: four letters between spaces are four", async () => {
    const { calls } = await open();
    await userEvent.type(reason(), "    abcd    ");
    expect(document.querySelector(".month-count")).toHaveTextContent("4/5");
    expect(confirm()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(confirm());
    expect(posts(calls)).toHaveLength(0);
  });

  it("counts characters, not UTF-16 units: four emoji are four, five are enough", async () => {
    await open();
    await userEvent.type(reason(), "😀😀😀😀");
    expect(document.querySelector(".month-count")).toHaveTextContent("4/5");
    expect(confirm()).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(reason(), "😀");
    expect(document.querySelector(".month-count")).toHaveTextContent("5/500");
    expect(confirm()).not.toHaveAttribute("aria-disabled");
  });

  it("sends the trimmed reason, says so with a toast, closes, and gives the focus back to the opener", async () => {
    const onClose = vi.fn();
    const { calls, toasts, opener } = await open({}, onClose);
    await userEvent.type(reason(), "  Meter replaced in hall A  ");
    await userEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts(calls).map((c) => c.body)).toEqual([{ note: "Meter replaced in hall A" }]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "September 2026 reopened" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("Enter in the field adds a line, it does not send", async () => {
    const { calls } = await open();
    await userEvent.type(reason(), "first line{Enter}second");
    expect(posts(calls)).toHaveLength(0);
    expect(reason()).toHaveValue("first line\nsecond");
  });

  it("Escape closes only the dialog, and Cancel does the same; neither sends", async () => {
    const onClose = vi.fn();
    const { calls, opener } = await open({}, onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await userEvent.click(cancel());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(posts(calls)).toHaveLength(0);
  });

  it("Tab wraps in both directions, also over the waiting confirm button (it can still be reached)", async () => {
    await open();
    expect(reason()).toHaveFocus();
    await userEvent.tab();
    expect(cancel()).toHaveFocus();
    await userEvent.tab();
    expect(confirm()).toHaveFocus(); // aria-disabled, so it is still in the tab order
    await userEvent.tab();
    expect(reason()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm()).toHaveFocus();
    expect(screen.getByRole("button", { name: "after" })).not.toHaveFocus();
  });

  it("shows a refusal inline, keeps the dialog, the text and the focus", async () => {
    const onClose = vi.fn();
    const { toasts } = await open({ [`POST ${PATH}`]: { status: 409, body: { detail: "that month is not closed" } } }, onClose);
    await userEvent.type(reason(), "Wrong meter");
    await userEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent("that month is not closed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(reason()).toHaveValue("Wrong meter");
    expect(confirm()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(toasts.calls).toEqual([]);
  });

  it("a double click sends one request", async () => {
    const calls = mockFetch({ ...base });
    const held = holdFetch((method, path) => method === "POST" && path === PATH);
    renderWithProviders(<Host />, { toasts: spyToasts().api });
    await userEvent.click(screen.getByRole("button", { name: "Reopen month…" }));
    await userEvent.type(reason(), "Wrong meter");
    await userEvent.dblClick(confirm());
    await waitFor(() => expect(confirm()).toHaveAttribute("aria-disabled", "true"));
    held.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts(calls)).toHaveLength(1);
  });
});
