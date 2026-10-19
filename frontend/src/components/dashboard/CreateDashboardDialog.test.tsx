import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useLocation } from "react-router";
import { dashboard } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { spyToasts } from "../../test/toasts";
import { CreateDashboardDialog } from "./CreateDashboardDialog";

// user-event's arrow keys on a radio read window.CSS.escape, which jsdom 26 does not have: stub it here only.
beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
});
afterEach(() => { vi.unstubAllGlobals(); });

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}|${JSON.stringify(location.state)}`}</output>;
}
/** An opener button and the dialog it shows, as the Dashboards page has them. */
function Host({ initialStart }: { initialStart?: "blank" | "power" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      {open && <CreateDashboardDialog initialStart={initialStart} onClose={() => setOpen(false)} />}
      <Probe />
    </>
  );
}
async function show(over: Routes = {}, initialStart?: "blank" | "power") {
  const toasts = spyToasts();
  const calls = mockFetch({ "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Created" }) }, ...over });
  renderWithProviders(<Host initialStart={initialStart} />, { route: "/dashboards", path: "*", toasts: toasts.api });
  await userEvent.click(screen.getByRole("button", { name: "Open it" }));
  const dialog = screen.getByRole("dialog", { name: "New dashboard" });
  return { calls, toasts, dialog };
}
const posts = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST");
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name }) as HTMLInputElement;

describe("CreateDashboardDialog", () => {
  it("offers Start from Blank (chosen) or Power after Range, with the focus on Name", async () => {
    const { dialog } = await show();
    const group = within(dialog).getByRole("group", { name: "Start from" });
    expect(within(group).getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual(["Blank", "Power"]);
    expect(radio(dialog, "Blank").checked).toBe(true);
    expect(radio(dialog, "Power").checked).toBe(false);
    const order = Array.from(dialog.querySelectorAll("input, select, button")).map((e) => e.tagName + (e.getAttribute("type") ?? ""));
    expect(order).toEqual(["INPUT", "SELECT", "INPUTradio", "INPUTradio", "BUTTONbutton", "BUTTONsubmit"]); // Name, Range, Start from, Cancel, Create
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("placeholder");
  });

  it("Blank sends exactly name and range (no recipe key), shows the page in edit mode and needs a name", async () => {
    const { calls, toasts, dialog } = await show();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    expect(within(dialog).getByText("Enter a name.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "  Hall C  ");
    await userEvent.selectOptions(screen.getByLabelText("Range"), "7d");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Hall C", range: "7d" }]);
    expect(Object.keys(posts(calls)[0].body as object)).toEqual(["name", "range"]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Dashboard created" }]);
  });

  it("Power selects This month, hints the name 'Power', allows an empty name and sends Power with the recipe", async () => {
    const { calls, dialog } = await show();
    await userEvent.click(radio(dialog, "Power"));
    expect(radio(dialog, "Power").checked).toBe(true);
    expect(screen.getByLabelText("Range")).toHaveValue("this_month");
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Power");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
    expect(within(dialog).queryByText("Enter a name.")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Power", range: "this_month", recipe: "power" });
  });

  it("Power sends a typed name trimmed, and opens the new dashboard in view mode (no edit state)", async () => {
    const { calls, toasts, dialog } = await show();
    await userEvent.click(radio(dialog, "Power"));
    await userEvent.type(screen.getByLabelText("Name"), "  Energy  ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboards/9|null"));
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Energy", range: "this_month", recipe: "power" }]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Dashboard created" }]);
  });

  it("keeps a range the person changed after choosing Power, and choosing Blank again does not reset the range", async () => {
    const { calls, dialog } = await show();
    await userEvent.click(radio(dialog, "Power"));
    await userEvent.selectOptions(screen.getByLabelText("Range"), "last_month");
    await userEvent.click(radio(dialog, "Blank"));
    expect(screen.getByLabelText("Range")).toHaveValue("last_month");
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("placeholder");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled(); // Blank needs a name again
    expect(within(dialog).getByText("Enter a name.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Back to blank");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Back to blank", range: "last_month" }); // no recipe key after going back
    expect(Object.keys(posts(calls)[0].body as object)).toEqual(["name", "range"]);
  });

  it("opens with Power preselected, and This month with it, when initialStart is power", async () => {
    const { calls, dialog } = await show({}, "power");
    expect(radio(dialog, "Power").checked).toBe(true);
    expect(radio(dialog, "Blank").checked).toBe(false);
    expect(screen.getByLabelText("Range")).toHaveValue("this_month");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Power");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Power", range: "this_month", recipe: "power" });
  });

  it("a taken name (a second Power with an empty name too) shows the server's sentence and keeps the dialog open", async () => {
    const { calls, toasts, dialog } = await show({ "POST /api/dashboards": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await userEvent.click(radio(dialog, "Power"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("a dashboard with this name already exists");
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Power", range: "this_month", recipe: "power" }]);
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboards|null"); // it did not navigate
    expect(toasts.calls).toEqual([]);
    expect(screen.getByLabelText("Name")).toHaveValue(""); // the person can type another name and try again
  });

  it("moves the choice with the arrow keys, and Create then sends the recipe", async () => {
    const { calls, dialog } = await show();
    radio(dialog, "Blank").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(radio(dialog, "Power")).toHaveFocus();
    expect(radio(dialog, "Power").checked).toBe(true);
    expect(screen.getByLabelText("Range")).toHaveValue("this_month");
    await userEvent.keyboard("{ArrowUp}");
    expect(radio(dialog, "Blank")).toHaveFocus();
    expect(radio(dialog, "Blank").checked).toBe(true);
    await userEvent.keyboard("{ArrowRight}");
    expect(radio(dialog, "Power").checked).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ recipe: "power" });
  });

  it("Escape closes the dialog and the focus goes back to the opener; Cancel does the same without a request", async () => {
    const { calls } = await show();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Open it" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    expect(posts(calls)).toEqual([]);
  });

  it("every button in the form is type button except Create", async () => {
    const { dialog } = await show();
    const types = within(dialog).getAllByRole("button").map((b) => `${b.textContent}:${b.getAttribute("type")}`);
    expect(types).toEqual(["Cancel:button", "Create:submit"]);
  });
});
