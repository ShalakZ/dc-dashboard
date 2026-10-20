import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useLocation } from "react-router";
import { useDashboardTemplates } from "../../api/queries";
import { authed, dashboard } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { holdFetch } from "../../test/holdFetch";
import { renderWithProviders } from "../../test/render";
import { spyToasts } from "../../test/toasts";
import { CreateDashboardDialog } from "./CreateDashboardDialog";
import type { TemplateChoice } from "./TemplateGallery";

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}|${JSON.stringify(location.state)}`}</output>;
}
/**
 * An opener button and the dialog it shows, as the Dashboards page has them. `warm` reads the templates first, as the page does for an editor
 * (the opener waits for them), so the dialog opens with the cards already there; a cold host opens at once, with whatever the request has by then.
 */
function Host({ initialChoice, warm = true }: { initialChoice?: TemplateChoice; warm?: boolean }) {
  const [open, setOpen] = useState(false);
  const templates = useDashboardTemplates(warm);
  return (
    <>
      {(!warm || templates.data) && <button type="button" onClick={() => setOpen(true)}>Open it</button>}
      {open && <CreateDashboardDialog initialChoice={initialChoice} onClose={() => setOpen(false)} />}
      <Probe />
    </>
  );
}
async function show(over: Routes = {}, props: { initialChoice?: TemplateChoice; warm?: boolean } = {}) {
  const toasts = spyToasts();
  const calls = mockFetch({
    ...authed("operator"),
    "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Created" }) },
    ...over,
  });
  renderWithProviders(<Host {...props} />, { route: "/dashboards", path: "*", toasts: toasts.api });
  await userEvent.click(await screen.findByRole("button", { name: "Open it" }));
  const dialog = screen.getByRole("dialog", { name: "New dashboard" });
  return { calls, toasts, dialog };
}
const posts = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST");
const card = (dialog: HTMLElement, name: string) => within(dialog).getByRole("button", { name });
/** Step 2 of a template: click its card. */
async function choose(dialog: HTMLElement, name: string) {
  await userEvent.click(card(dialog, name));
  return within(dialog).getByLabelText("Name") as HTMLInputElement;
}
const create = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Create" });

describe("CreateDashboardDialog, step 1: Choose a template", () => {
  it("opens on the gallery with the focus on its first card, a Cancel button and no radios or Start from", async () => {
    const { dialog } = await show();
    expect(within(dialog).getByRole("heading", { name: "Choose a template" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button").map((b) => b.getAttribute("data-template") ?? b.textContent)).toEqual(["power", "cost", "areas", "day", "blank", "Cancel"]);
    expect(card(dialog, "Power")).toHaveFocus();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByText(/start from/i)).toBeNull();
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("draws the Recommended row from the server's list, with Blank last in More templates", async () => {
    const { dialog } = await show();
    expect(within(within(dialog).getByRole("region", { name: "Recommended for this site" })).getAllByRole("button").map((b) => b.getAttribute("data-template"))).toEqual(["power", "cost", "areas"]);
    expect(within(within(dialog).getByRole("region", { name: "More templates" })).getAllByRole("button").map((b) => b.getAttribute("data-template"))).toEqual(["day", "blank"]);
  });

  it("Escape closes the dialog and the focus goes back to the opener; Cancel does the same without a request", async () => {
    const { calls } = await show();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Open it" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    expect(posts(calls)).toEqual([]);
  });

  it("Tab wraps: from Cancel to the first card, and Shift+Tab from the first card to Cancel", async () => {
    const { dialog } = await show();
    expect(card(dialog, "Power")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab();
    expect(card(dialog, "Power")).toHaveFocus();
  });

  it("picks a card with Enter and with Space", async () => {
    const { dialog } = await show();
    await userEvent.keyboard("{Enter}"); // Power has the focus
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "Power");
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to templates" }));
    await userEvent.tab(); // Power has the focus again; on to Cost
    await userEvent.keyboard(" ");
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "Cost");
  });

  it("while the list loads, offers Blank alone with a sentence, and Blank works", async () => {
    mockFetch({ ...authed("operator"), "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Created" }) } });
    const held = holdFetch((method, path) => path === "/api/dashboard-templates" && method === "GET");
    renderWithProviders(<Host warm={false} />, { route: "/dashboards", path: "*" });
    await userEvent.click(screen.getByRole("button", { name: "Open it" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    expect(within(dialog).getByText("Loading templates…")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button").map((b) => b.getAttribute("data-template") ?? b.textContent)).toEqual(["blank", "Cancel"]);
    await userEvent.click(card(dialog, "Blank"));
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    held.release();
    expect(await within(dialog).findByLabelText("Range")).toHaveValue("24h"); // the list landing behind the second step changes nothing there
  });

  it("when the list fails, says so in a sentence and Blank still works", async () => {
    const { dialog, calls } = await show({ "GET /api/dashboard-templates": { status: 500, body: { detail: "boom" } } }, { warm: false });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The templates could not be loaded. A blank dashboard still works.");
    expect(within(dialog).getAllByRole("button").map((b) => b.getAttribute("data-template") ?? b.textContent)).toEqual(["blank", "Cancel"]);
    await userEvent.click(card(dialog, "Blank"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Hall C");
    await userEvent.click(create(dialog));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Hall C", range: "24h" });
  });
});

describe("CreateDashboardDialog, step 2: a template", () => {
  it("choosing a card moves the focus to Name, shows the choice, defaults the range to the template's and the name to its title", async () => {
    const { dialog } = await show();
    const name = await choose(dialog, "Power");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("placeholder", "Power");
    expect(name).toHaveValue("");
    expect(within(dialog).getByLabelText("Range")).toHaveValue("this_month");
    expect(within(dialog).getByText(/This month's energy and cost against last month/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Choose a template" })).toBeNull();
    expect(within(dialog).queryByText("Enter a name.")).toBeNull();
    expect(create(dialog)).not.toHaveAttribute("aria-disabled");
    expect(within(dialog).getAllByRole("button").map((b) => `${b.textContent}:${b.getAttribute("type")}`)).toEqual(["Back to templates:button", "Cancel:button", "Create:submit"]);
  });

  it("Last 24 hours defaults to its own range", async () => {
    const { dialog } = await show();
    await choose(dialog, "Last 24 hours");
    expect(within(dialog).getByLabelText("Range")).toHaveValue("24h");
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "Last 24 hours");
  });

  it("an empty name sends the template's title with its recipe and range, opens the dashboard in view mode and raises one toast", async () => {
    const { calls, toasts, dialog } = await show();
    await choose(dialog, "Cost");
    await userEvent.click(create(dialog));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboards/9|null"));
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Cost", range: "this_month", recipe: "cost" }]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Dashboard created" }]);
  });

  it("sends a typed name trimmed and a range the person changed", async () => {
    const { calls, dialog } = await show();
    await choose(dialog, "Energy by area");
    await userEvent.type(within(dialog).getByLabelText("Name"), "  Halls  ");
    await userEvent.selectOptions(within(dialog).getByLabelText("Range"), "last_month");
    await userEvent.click(create(dialog));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Halls", range: "last_month", recipe: "areas" });
  });

  it("Enter in the Name field creates", async () => {
    const { calls, dialog } = await show();
    await choose(dialog, "Power");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Energy{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Energy", range: "this_month", recipe: "power" });
  });

  it("a taken name shows the server's sentence in the dialog, keeps the typed name, and stays open without navigating", async () => {
    const { calls, toasts, dialog } = await show({ "POST /api/dashboards": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await choose(dialog, "Power");
    await userEvent.click(create(dialog));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("a dashboard with this name already exists");
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Power", range: "this_month", recipe: "power" }]);
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboards|null");
    expect(toasts.calls).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText("Name"), "Power 2"); // the person can try another name
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Power 2");
  });
});

describe("CreateDashboardDialog, step 2: Blank", () => {
  it("has no placeholder, needs a name (Create is aria-disabled, not disabled), and sends exactly name and range, opening in edit mode", async () => {
    const { calls, toasts, dialog } = await show();
    const name = await choose(dialog, "Blank");
    expect(name).toHaveFocus();
    expect(name).not.toHaveAttribute("placeholder");
    expect(within(dialog).getByLabelText("Range")).toHaveValue("24h");
    expect(create(dialog)).toHaveAttribute("aria-disabled", "true");
    expect(create(dialog)).not.toBeDisabled();
    expect(within(dialog).getByText("Enter a name.")).toBeInTheDocument();
    await userEvent.click(create(dialog)); // the click guard: nothing is sent
    expect(posts(calls)).toEqual([]);
    await userEvent.type(name, "  Hall C  ");
    expect(create(dialog)).not.toHaveAttribute("aria-disabled");
    await userEvent.selectOptions(within(dialog).getByLabelText("Range"), "7d");
    await userEvent.click(create(dialog));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: "Hall C", range: "7d" }]);
    expect(Object.keys(posts(calls)[0].body as object)).toEqual(["name", "range"]); // no recipe key
    expect(toasts.calls).toEqual([{ kind: "success", text: "Dashboard created" }]);
  });

  // w27 FA (review finding 9): the hint was in the form from the start and left at the first keystroke, so the dialog shrank by a line and Create moved up 16 px.
  it("keeps the hint's line when the typing starts: the same element stays, its text goes, it describes Name and stays out of Create's name", async () => {
    const { dialog } = await show();
    const name = await choose(dialog, "Blank");
    const hint = within(dialog).getByText("Enter a name.");
    expect(hint).toHaveClass("tpl-hint");
    expect(name).toHaveAccessibleDescription("Enter a name.");
    expect(create(dialog)).toHaveAccessibleName("Create");
    expect(create(dialog)).toHaveAccessibleDescription("");
    await userEvent.type(name, "H");
    expect(hint.isConnected, "the line stays in the form").toBe(true);
    expect(hint).toBeEmptyDOMElement();
    expect(name).toHaveAccessibleDescription("");
    expect(create(dialog)).toHaveAccessibleName("Create");
    await userEvent.clear(name);
    expect(hint).toHaveTextContent("Enter a name.");
  });

  it("a template that names itself has the line too, empty", async () => {
    const { dialog } = await show();
    await choose(dialog, "Power");
    const hint = dialog.querySelector(".tpl-hint");
    expect(hint).not.toBeNull();
    expect(hint).toBeEmptyDOMElement();
  });

  it("Enter in an empty Name does nothing", async () => {
    const { calls, dialog } = await show();
    const name = await choose(dialog, "Blank");
    await userEvent.type(name, "{Enter}");
    expect(posts(calls)).toEqual([]);
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
  });
});

describe("CreateDashboardDialog, Back to templates, Escape and Tab on step 2", () => {
  it("Back returns to the gallery with the focus on the card that was chosen, and the dialog is still open", async () => {
    const { dialog } = await show();
    await choose(dialog, "Cost");
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to templates" }));
    expect(within(dialog).getByRole("heading", { name: "Choose a template" })).toBeInTheDocument();
    expect(card(dialog, "Cost")).toHaveFocus();
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
  });

  it("choosing another card gives that template's range and title, and keeps a name already typed", async () => {
    const { dialog } = await show();
    await choose(dialog, "Power");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Mine");
    await userEvent.selectOptions(within(dialog).getByLabelText("Range"), "7d");
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to templates" }));
    await choose(dialog, "Last 24 hours");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Mine");
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "Last 24 hours");
    expect(within(dialog).getByLabelText("Range")).toHaveValue("24h");
  });

  it("Back forgets an earlier 'name already taken'", async () => {
    const { dialog } = await show({ "POST /api/dashboards": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await choose(dialog, "Power");
    await userEvent.click(create(dialog));
    await within(dialog).findByRole("alert");
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to templates" }));
    await choose(dialog, "Cost");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("Escape on step 2 closes the whole dialog and the focus goes back to the opener", async () => {
    const { calls, dialog } = await show();
    await choose(dialog, "Power");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    expect(posts(calls)).toEqual([]);
  });

  it("Cancel on step 2 closes the dialog without a request", async () => {
    const { calls, dialog } = await show();
    await choose(dialog, "Power");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
    expect(posts(calls)).toEqual([]);
  });

  it("Tab wraps on step 2: from Create to Name, and Shift+Tab from Name to Create", async () => {
    const { dialog } = await show();
    await choose(dialog, "Power");
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(create(dialog)).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    await userEvent.tab(); // Range, Back to templates, Cancel, Create
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(create(dialog)).toHaveFocus();
  });

  it("while the dashboard is being made Create keeps the focus (aria-disabled, never disabled), a second click sends nothing and Back and Cancel wait", async () => {
    const calls = mockFetch({ ...authed("operator"), "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Created" }) } });
    renderWithProviders(<Host />, { route: "/dashboards", path: "*" });
    await userEvent.click(await screen.findByRole("button", { name: "Open it" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    await choose(dialog, "Power");
    const held = holdFetch((method) => method === "POST");
    await userEvent.click(create(dialog));
    await waitFor(() => expect(create(dialog)).toHaveAttribute("aria-disabled", "true"));
    expect(create(dialog)).not.toBeDisabled();
    expect(create(dialog)).toHaveFocus();
    await userEvent.click(create(dialog));
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to templates" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument(); // still on step 2
    held.release();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboards/9|null"));
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("CreateDashboardDialog opened on a card of the empty page (initialChoice)", () => {
  it("opens straight on step 2 with the focus on Name, and Back returns to that card", async () => {
    const { calls, dialog } = await show({}, { initialChoice: "cost" });
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "Cost");
    expect(within(dialog).getByLabelText("Range")).toHaveValue("this_month");
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to templates" }));
    expect(card(dialog, "Cost")).toHaveFocus();
    await userEvent.click(card(dialog, "Cost"));
    await userEvent.click(create(dialog));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: "Cost", range: "this_month", recipe: "cost" });
  });

  it("Blank opens on step 2 in edit mode", async () => {
    const { calls, dialog } = await show({}, { initialChoice: "blank" });
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByLabelText("Range")).toHaveValue("24h");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Hall D");
    await userEvent.click(create(dialog));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
    expect(posts(calls)[0].body).toEqual({ name: "Hall D", range: "24h" });
  });

  it("Escape closes it and the focus goes back to the opener", async () => {
    await show({}, { initialChoice: "power" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
  });
});
