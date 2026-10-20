import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useDisplays } from "../../api/queries";
import { authed } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { displaysList, playlist, screenRow } from "./displayFixtures";
import { LINK_WARNING, NewDisplayDialog } from "./NewDisplayDialog";

// A made-up secret for the tests, never printed: the assertions below are booleans so a failure does not echo it.
const SECRET = "Zk3_test-secret-0123456789abcdefghijklmnopq";
const PLAYLISTS = [playlist(1, "Wall A"), playlist(2, "Wall B")];
const CREATED = { display: screenRow(7, "Hall TV", 1, "Wall A"), link_secret: SECRET };

const seen: { client?: QueryClient } = {};
function Host() {
  const [open, setOpen] = useState(false);
  seen.client = useQueryClient();
  useDisplays(); // the page's own query is alive while the dialog is open
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      {open && <NewDisplayDialog playlists={PLAYLISTS} onClose={() => setOpen(false)} />}
    </>
  );
}
async function show(over: Routes = {}) {
  const calls = mockFetch({
    ...authed("admin"),
    "GET /api/displays": { body: displaysList({ playlists: PLAYLISTS }) },
    "POST /api/displays": { status: 201, body: CREATED },
    ...over,
  });
  renderWithProviders(<Host />, { route: "/displays", path: "*" });
  await userEvent.click(await screen.findByRole("button", { name: "Open it" }));
  return { calls, dialog: screen.getByRole("dialog", { name: "New display" }) };
}
const posts = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST");
async function makeIt(dialog: HTMLElement, name = "Hall TV") {
  await userEvent.type(within(dialog).getByLabelText("Name"), name);
  await userEvent.click(within(dialog).getByRole("button", { name: "Create display" }));
  return within(dialog).findByLabelText("Display link") as Promise<HTMLTextAreaElement>;
}
const LINK = () => `${window.location.origin}/display#${SECRET}`;

describe("NewDisplayDialog, step 1", () => {
  it("opens with the focus on Name, a Playlist select holding the playlists, and Create display waiting for a name", async () => {
    const { dialog } = await show();
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Wall A", "Wall B"]);
    expect(within(dialog).getByRole("button", { name: "Create display" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create display" }));
    expect(screen.getByRole("dialog", { name: "New display" })).toBeInTheDocument();
  });

  it("sends the trimmed name and the chosen playlist, as a POST", async () => {
    const { dialog, calls } = await show();
    await userEvent.type(within(dialog).getByLabelText("Name"), "  Hall TV ");
    await userEvent.selectOptions(within(dialog).getByLabelText("Playlist"), "Wall B");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create display" }));
    await within(dialog).findByLabelText("Display link");
    expect(posts(calls).map((c) => [c.path, c.body])).toEqual([["/api/displays", { name: "Hall TV", playlist_id: 2 }]]);
  });

  it("Escape closes it without a request, and the focus goes back to the opener", async () => {
    const { calls } = await show();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    expect(posts(calls)).toEqual([]);
  });

  it("shows the server's refusal inside the dialog and stays on step 1", async () => {
    const { dialog } = await show({ "POST /api/displays": { status: 409, body: { detail: "a display with this name already exists" } } });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Hall TV");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create display" }));
    expect(await within(dialog).findByText("a display with this name already exists")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Display link")).toBeNull();
  });

  it("refreshes the displays and the audit log whether the create worked or not (the page behind may be out of date)", async () => {
    const { dialog, calls } = await show({ "POST /api/displays": { status: 409, body: { detail: "a display with this name already exists" } }, "GET /api/audit": { body: { items: [], total: 0 } } });
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/displays").length;
    const before = reads();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Hall TV");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create display" }));
    await within(dialog).findByText("a display with this name already exists");
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});

describe("NewDisplayDialog, step 2: the link, once", () => {
  it("shows the link in a read-only field, the warning and Done, with the focus on Copy link", async () => {
    const { dialog } = await show();
    const field = await makeIt(dialog);
    expect(field.value === LINK()).toBe(true);
    expect(field).toHaveAttribute("readonly");
    expect(field.tagName).toBe("TEXTAREA");
    expect(within(dialog).getByRole("button", { name: "Copy link" })).toHaveFocus();
    expect(within(dialog).getByText(LINK_WARNING)).toBeInTheDocument();
    expect(LINK_WARNING).toBe("Anyone who has this link can see these dashboards without signing in. It is shown only now: copy it before you close this window.");
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("Tab wraps inside the dialog in both directions", async () => {
    const { dialog } = await show();
    await makeIt(dialog);
    const done = within(dialog).getByRole("button", { name: "Done" });
    await userEvent.tab(); // Copy link -> Done
    expect(done).toHaveFocus();
    await userEvent.tab(); // Done -> the link field (the first control)
    expect(within(dialog).getByLabelText("Display link")).toHaveFocus();
    await userEvent.tab({ shift: true }); // the first control -> Done
    expect(done).toHaveFocus();
  });

  it("a click on the backdrop does not close it (the link is shown only once)", async () => {
    const { dialog } = await show();
    await makeIt(dialog);
    await userEvent.click(dialog.parentElement!);
    expect(screen.getByRole("dialog", { name: "New display" })).toBeInTheDocument();
  });

  describe("Copy link", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
      delete (document as unknown as Record<string, unknown>).execCommand;
    });

    it("puts the link on the clipboard and says Copied in the one live region", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const { dialog } = await show();
      const field = await makeIt(dialog);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true }); // after user-event's own stub is in place
      await userEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0] === LINK()).toBe(true);
      await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Copied"));
      expect(within(dialog).getAllByRole("status")).toHaveLength(1);
      expect(field.value === LINK()).toBe(true);
    });

    it("over plain http, where the browser has no clipboard API, copies the selected text the old way", async () => {
      const exec = vi.fn(() => true);
      const { dialog } = await show();
      await makeIt(dialog);
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      (document as unknown as { execCommand: unknown }).execCommand = exec;
      await userEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      expect(exec).toHaveBeenCalledWith("copy");
      await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Copied"));
    });

    it("when neither way works, leaves the text selected and says to press Ctrl+C", async () => {
      const { dialog } = await show();
      const field = await makeIt(dialog);
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      (document as unknown as { execCommand: unknown }).execCommand = () => false;
      await userEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Press Ctrl+C to copy"));
      expect(field).toHaveFocus();
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(field.value.length);
    });
  });

  /** Where a secret could be left: the mutation cache, the query cache, the page, and every field. Booleans, so a failure never prints it. */
  const leftBehind = () => {
    const client = seen.client!;
    const mutations = client.getMutationCache().getAll().some((m) => JSON.stringify(m.state).includes(SECRET));
    const queries = client.getQueryCache().getAll().some((q) => JSON.stringify(q.state).includes(SECRET));
    const page = document.body.innerHTML.includes(SECRET);
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).some((f) => f.value.includes(SECRET));
    return { mutations, queries, page, fields };
  };

  it("holds the secret nowhere once Done is pressed: not in the mutation cache, the query cache, the page or a field", async () => {
    const { dialog } = await show();
    await makeIt(dialog);
    // The secret is on the page now (so this test is not vacuous), and the create mutation is already given up.
    expect(leftBehind().page || leftBehind().fields).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(leftBehind()).toEqual({ mutations: false, queries: false, page: false, fields: false })); // gcTime 0: dropped on the next tick
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
  });

  it("never lets the query cache or the mutation cache hold it, even while the link is shown", async () => {
    const { dialog } = await show();
    await makeIt(dialog);
    await waitFor(() => expect(leftBehind().mutations).toBe(false));
    expect(leftBehind().queries).toBe(false);
  });

  it("Escape does what Done does: the dialog closes, the secret is dropped, and nothing else is sent", async () => {
    const { dialog, calls } = await show();
    await makeIt(dialog);
    const before = calls.length;
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(leftBehind()).toEqual({ mutations: false, queries: false, page: false, fields: false }));
    expect(posts(calls)).toHaveLength(1); // the create only
    expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
  });
});
