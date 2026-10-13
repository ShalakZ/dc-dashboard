import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { mockFetch, shellRoutes, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { TariffsPage } from "./TariffsPage";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 5, parent_id: 1, name: "LV Panel 1", kind: "panel", sort_order: 0 },
];
const tariff = (id: number, asset_id: number | null, rate: number, from: string) => ({
  id, asset_id, asset_name: asset_id === 5 ? "LV Panel 1" : null, asset_path: asset_id === 5 ? "Site / LV Panel 1" : null,
  rate_per_kwh: rate,
  effective_from: from, created_by: 1, created_at: "2026-10-01T00:00:00Z",
});
type Row = ReturnType<typeof tariff>;

let rows: Row[];
let currency: string | null;
let overrides: Routes;

const routes = (role: string): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "a", role } },
  "GET /api/assets": { body: assets },
  "GET /api/settings/billing": () => ({ body: { currency } }),
  "PUT /api/settings/billing": ({ body }) => {
    currency = (body as { currency: string | null }).currency;
    return { body: { currency } };
  },
  "GET /api/tariffs": () => ({ body: rows }),
  "POST /api/tariffs": ({ body }) => {
    const b = body as { asset_id: number | null; rate_per_kwh: number; effective_from: string };
    const created = tariff(10, b.asset_id, b.rate_per_kwh, b.effective_from);
    rows = [...rows, created];
    return { status: 201, body: created };
  },
  "PATCH /api/tariffs/2": ({ body }) => {
    rows = rows.map((r) => (r.id === 2 ? { ...r, ...(body as Partial<Row>) } : r));
    return { body: rows.find((r) => r.id === 2) };
  },
  "DELETE /api/tariffs/3": () => {
    rows = rows.filter((r) => r.id !== 3);
    return { status: 204 };
  },
  ...overrides,
});
const open = () => {
  const calls = mockFetch(routes("admin"));
  renderWithProviders(<TariffsPage />, { route: "/tariffs", path: "/tariffs" });
  return calls;
};
const fillRate = async (form: HTMLElement, from: string, rate: string) => {
  fireEvent.change(within(form).getByLabelText("Effective from"), { target: { value: from } });
  await userEvent.type(within(form).getByLabelText("Rate per kWh"), rate);
};
const currencyForm = () => screen.getByRole("form", { name: "Site currency" });
// The row menu is a portal on document.body: open it from the row's trigger, then find the item on the page.
const openMenu = (row: HTMLElement) => userEvent.click(within(row).getByRole("button", { name: /^Actions for / }));
const edit = async (row: HTMLElement) => {
  await openMenu(row);
  await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
};
const trash = (row: HTMLElement) => within(row).getByRole("button", { name: /^Delete rate from / });

beforeEach(() => {
  // newest first per scope, as the API returns them: site default rates, then overrides
  rows = [tariff(2, null, 0.15, "2026-10-01"), tariff(1, null, 0.12, "2026-01-01"), tariff(3, 5, 0.09, "2026-10-15")];
  currency = "QAR";
  overrides = {};
});

describe("TariffsPage", () => {
  it("lists the site default rates and the asset overrides, and shows the currency", async () => {
    open();
    const defaults = await screen.findByRole("table", { name: "Site default rates" });
    expect(within(defaults).getAllByRole("row")).toHaveLength(3); // header and two rates
    expect(within(defaults).getByText("0.15")).toBeInTheDocument();
    expect(within(defaults).getByText("2026-01-01")).toBeInTheDocument();
    const perAsset = screen.getByRole("table", { name: "Asset overrides" });
    expect(within(perAsset).getByText("LV Panel 1")).toBeInTheDocument();
    expect(within(perAsset).getByText("0.09")).toBeInTheDocument();
    expect(await screen.findByLabelText("Currency")).toHaveValue("QAR");
    expect(screen.queryByText(/No currency is set/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Set the currency first/)).not.toBeInTheDocument();
  });

  it("opens with the shared page header (one h1 in a .page-head), the tables in .table-wrap and the notes in the header", async () => {
    open();
    const defaults = await screen.findByRole("table", { name: "Site default rates" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Tariffs" }).closest("header")).toHaveClass("page-head");
    expect(defaults.closest(".table-wrap")).not.toBeNull();
    expect(screen.getByRole("table", { name: "Asset overrides" }).closest(".table-wrap")).not.toBeNull();
    // the explanation of how a rate applies is said once, in the header
    expect(screen.getAllByText(/A rate applies from its effective date/)).toHaveLength(1);
    expect(screen.getByText(/A rate applies from its effective date/).closest(".page-head")).not.toBeNull();
  });

  it("gives each rate a three-dot menu (Edit only) and a trash button, and has at most one primary button", async () => {
    open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    const trigger = within(row).getByRole("button", { name: "Actions for rate from 2026-10-01 (site default)" });
    expect(trigger).toHaveClass("row-menu-btn");
    expect(trash(row)).toHaveClass("trash-btn");
    expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument(); // Edit lives in the menu now
    await userEvent.click(trigger);
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Edit"]); // Delete is the trash, never a menu item
    // the page has no primary button: the two Add rate buttons and the currency Save are plain (none is invented here)
    expect(document.querySelectorAll(".primary").length).toBeLessThanOrEqual(1);
    expect(document.querySelectorAll(".primary")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Add rate" })).toHaveLength(2);
  });

  it("names every menu and trash button by the rate and, for an override, its asset", async () => {
    open();
    const defaults = await screen.findByRole("table", { name: "Site default rates" });
    expect(within(defaults).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Actions for rate from 2026-10-01 (site default)", "Delete rate from 2026-10-01 (site default)",
      "Actions for rate from 2026-01-01 (site default)", "Delete rate from 2026-01-01 (site default)",
    ]);
    const overrides = screen.getByRole("table", { name: "Asset overrides" });
    expect(within(overrides).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Actions for rate from 2026-10-15 for LV Panel 1", "Delete rate from 2026-10-15 for LV Panel 1",
    ]);
  });

  it("gives each section a head: an icon, the unchanged h2 and a one-line purpose, and adds no heading", async () => {
    open();
    await screen.findByRole("table", { name: "Site default rates" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Currency", "Site default rate", "Asset overrides"]);
    const purposes = [
      ["Currency", "The unit costs are shown in. Set it first: every rate below is in this currency."],
      ["Site default rate", "The price per kWh used for every asset that has no override on itself or on an asset above it. A new rate counts from its effective date."],
      ["Asset overrides", "A different price per kWh for one asset and everything under it (unless a lower asset has its own), from its effective date."],
    ];
    for (const [title, text] of purposes) {
      const head = screen.getByRole("heading", { level: 2, name: title }).closest(".sect-head")!;
      expect(head).not.toBeNull();
      expect(head.parentElement).toHaveClass("page-card");
      expect(head.querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
      expect(head.querySelector("h2 svg")).toBeNull(); // the icon sits beside the heading, not in its name
      const purpose = within(head as HTMLElement).getByText(text);
      expect(purpose).toHaveClass("sect-purpose", "muted");
    }
  });

  it("explains the fields with tips that sit beside the labels, not inside them", async () => {
    open();
    const tips = (scope: HTMLElement) => within(scope).getAllByRole("button", { name: "What does this mean?" });
    const currency = await screen.findByRole("form", { name: "Site currency" });
    const siteForm = screen.getByRole("form", { name: "Add site default rate" });
    const overrideForm = screen.getByRole("form", { name: "Add asset override" });
    expect(tips(currency)).toHaveLength(1);
    expect(tips(siteForm)).toHaveLength(2);
    expect(tips(overrideForm)).toHaveLength(3);
    expect(document.querySelectorAll("label .tip")).toHaveLength(0);
    expect(document.querySelectorAll(".has-tip > label + .tip")).toHaveLength(6);
    const cases: [HTMLElement, number, string][] = [
      [currency, 0, "A three-letter code such as QAR."],
      [siteForm, 0, "The first day (site time) this rate counts. Readings before that day keep the rate that applied then."],
      [siteForm, 1, "The price of one kilowatt-hour in the site currency, for example 0.18."],
      [overrideForm, 0, "This asset and the assets under it are charged this rate."],
      [overrideForm, 1, "The first day (site time) this rate counts. Readings before that day keep the rate that applied then."],
      [overrideForm, 2, "The price of one kilowatt-hour in the site currency, for example 0.18."],
    ];
    for (const [form, index, text] of cases) {
      const button = tips(form)[index];
      await userEvent.click(button);
      expect(screen.getByRole("note")).toHaveTextContent(text);
      await userEvent.click(button); // pinned by the click: a second click closes it
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    }
  });

  it("keeps the label of each field its own (a tip never changes a field's name)", async () => {
    open();
    const form = await screen.findByRole("form", { name: "Add asset override" });
    for (const name of ["Asset", "Effective from", "Rate per kWh"]) expect(within(form).getByLabelText(name)).toBeInTheDocument();
    expect(await screen.findByLabelText("Currency")).toBeInTheDocument();
  });

  it("puts the one currency message in an info banner that keeps role status, in the Currency card beside the form", async () => {
    currency = null;
    open();
    const note = await screen.findByText(/No currency is set/);
    expect(note).toHaveClass("banner", "banner-info");
    expect(note).toHaveAttribute("role", "status");
    const card = screen.getByRole("heading", { level: 2, name: "Currency" }).closest(".page-card")!;
    expect(card.contains(note)).toBe(true);
    expect(card.contains(currencyForm())).toBe(true);
    expect(note.closest(".currency-row")).not.toBeNull();
    expect(note.closest(".currency-row")).toBe(currencyForm().closest(".currency-row")); // one row: the field, Save and the message
  });

  it("lays the page out as a Currency card across the page over the two rate cards, each with its own add form", async () => {
    open();
    await screen.findByRole("table", { name: "Site default rates" });
    const grid = document.querySelector(".tariffs-page > .page-grid")!;
    expect(grid).not.toBeNull();
    const cards = [...grid.children] as HTMLElement[];
    expect(cards.map((c) => c.querySelector("h2")?.textContent)).toEqual(["Currency", "Site default rate", "Asset overrides"]);
    for (const card of cards) expect(card.tagName === "SECTION" && card.classList.contains("page-card")).toBe(true);
    expect(cards[0]).toHaveClass("span-all");
    expect(cards[1]).not.toHaveClass("span-all");
    expect(cards[2]).not.toHaveClass("span-all");
    expect(within(cards[0]).getByRole("form", { name: "Site currency" })).toBeInTheDocument();
    const siteForm = within(cards[1]).getByRole("form", { name: "Add site default rate" });
    const overrideForm = within(cards[2]).getByRole("form", { name: "Add asset override" });
    expect(within(cards[1]).getByRole("table", { name: "Site default rates" })).toBeInTheDocument();
    expect(within(cards[2]).getByRole("table", { name: "Asset overrides" })).toBeInTheDocument();
    // the add form closes its card (the table is above it) and is not a bordered surface of its own
    expect(cards[1].lastElementChild).toBe(siteForm);
    expect(cards[2].lastElementChild).toBe(overrideForm);
    expect(siteForm).toHaveClass("inline-form", "add-form");
    expect(overrideForm).toHaveClass("inline-form", "add-form");
    expect(within(cards[0]).getByRole("form", { name: "Site currency" })).not.toHaveClass("add-form");
    expect(document.querySelector(".tariffs-page .empty, .tariffs-page .banner:not(.banner-info)")).toBeNull();
  });

  it("puts the Asset field of the override form first and the Effective from, Rate and Add rate after it", async () => {
    open();
    const form = await screen.findByRole("form", { name: "Add asset override" });
    const labels = [...form.querySelectorAll("label")].map((l) => l.firstChild?.textContent?.trim());
    expect(labels).toEqual(["Asset", "Effective from", "Rate per kWh"]);
    expect(form.querySelector(".asset-field")).toBe(form.firstElementChild);
    expect([...form.querySelectorAll("button")].filter((b) => !b.classList.contains("icon-btn")).map((b) => b.textContent)).toEqual(["Add rate"]);
  });

  it("shows empty states when there are no rates and no overrides", async () => {
    rows = [];
    open();
    expect(await screen.findByText(
      "No site default rate yet. Until one is set, assets with no override show a dash for cost. Add a rate below.",
    )).toBeInTheDocument();
    expect(screen.getByText("No overrides. Every asset uses the site default rate.")).toBeInTheDocument();
    // compact notes inside their cards: the sentence is the paragraph's own text, the icon is decoration
    for (const [text, title] of [[/No site default rate yet/, "Site default rate"], [/No overrides/, "Asset overrides"]] as const) {
      const note = screen.getByText(text).closest(".empty-note")!;
      expect(note).not.toBeNull();
      expect(note.querySelector(".empty-note-icon")).toHaveAttribute("aria-hidden", "true");
      expect(note.closest(".page-card")).toBe(screen.getByRole("heading", { level: 2, name: title }).closest(".page-card"));
    }
    expect(document.querySelector(".empty, .empty-icon")).toBeNull(); // the large dashed box is gone
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("asks for a currency when none is set and saves it in capitals", async () => {
    currency = null;
    const calls = open();
    expect(await screen.findByText(/No currency is set/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Currency"), "qar");
    await userEvent.click(within(currencyForm()).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ currency: "QAR" });
    await waitFor(() => expect(screen.queryByText(/No currency is set/)).not.toBeInTheDocument());
  });

  it("says the currency once: the second banner (Set the currency first) is not rendered, the first is, and Save removes it", async () => {
    currency = null;
    open();
    expect(await screen.findByText(/No currency is set/)).toBeInTheDocument();
    await screen.findByRole("table", { name: "Site default rates" }); // the tables are in: the second banner would be above them by now
    expect(screen.queryByText(/Set the currency first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rates are in the site currency/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    await userEvent.type(screen.getByLabelText("Currency"), "QAR");
    await userEvent.click(within(currencyForm()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText(/No currency is set/)).not.toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps both rate forms enabled while no currency is set (nothing is locked), and Add rate still POSTs", async () => {
    currency = null;
    const calls = open();
    expect(await screen.findByText(/No currency is set/)).toBeInTheDocument();
    const siteForm = await screen.findByRole("form", { name: "Add site default rate" });
    const overrideForm = screen.getByRole("form", { name: "Add asset override" });
    expect(document.querySelector("fieldset")).toBeNull();
    for (const form of [siteForm, overrideForm]) {
      expect(within(form).getByRole("button", { name: "Add rate" })).toBeEnabled();
      expect(within(form).getByLabelText("Effective from")).toBeEnabled();
      expect(within(form).getByLabelText("Rate per kWh")).toBeEnabled();
    }
    expect(within(overrideForm).getByLabelText("Asset")).toBeEnabled();
    await fillRate(siteForm, "2026-11-01", "0.2");
    await userEvent.click(within(siteForm).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
      .toEqual({ asset_id: null, rate_per_kwh: 0.2, effective_from: "2026-11-01" }));
    await userEvent.selectOptions(within(overrideForm).getByLabelText("Asset"), "LV Panel 1");
    await fillRate(overrideForm, "2026-12-01", "0.3");
    await userEvent.click(within(overrideForm).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toContainEqual(
      { asset_id: 5, rate_per_kwh: 0.3, effective_from: "2026-12-01" },
    ));
    expect(screen.getByText(/No currency is set/)).toBeInTheDocument(); // adding a rate does not touch the currency message
  });

  it("rejects a malformed currency without calling the API, and clears it when the field is emptied", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = open();
    const input = await screen.findByLabelText("Currency");
    const save = within(currencyForm()).getByRole("button", { name: "Save" });
    await userEvent.clear(input);
    await userEvent.type(input, "ab");
    await userEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent(/three-letter/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(window.confirm).not.toHaveBeenCalled(); // nothing to confirm for a value that is refused
    await userEvent.clear(input);
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ currency: null }));
    expect(window.confirm).toHaveBeenCalledTimes(1); // removing an existing currency is a change too
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Remove the currency QAR"));
  });

  it("asks before changing an existing currency, because it relabels every past figure", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const calls = open();
    const input = await screen.findByLabelText("Currency");
    const save = within(currencyForm()).getByRole("button", { name: "Save" });
    await userEvent.clear(input);
    await userEvent.type(input, "usd");
    await userEvent.click(save);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/QAR.*USD/));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("relabels all past figures"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("no conversion is applied"));
    expect(calls.some((c) => c.method === "PUT")).toBe(false); // declined: nothing is sent
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ currency: "USD" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
  });

  it("does not ask when the currency is saved unchanged", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const calls = open();
    await screen.findByLabelText("Currency");
    await userEvent.click(within(currencyForm()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ currency: "QAR" }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("adds a site default rate and shows it", async () => {
    const calls = open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-11-01", "0.2");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
      .toEqual({ asset_id: null, rate_per_kwh: 0.2, effective_from: "2026-11-01" }));
    expect(await within(screen.getByRole("table", { name: "Site default rates" })).findByText("2026-11-01")).toBeInTheDocument();
  });

  it("steps both rate inputs by cents, the add forms' and an edit row's", async () => {
    open();
    for (const name of ["Add site default rate", "Add asset override"]) {
      const form = await screen.findByRole("form", { name });
      expect(within(form).getByLabelText("Rate per kWh")).toHaveAttribute("step", "0.01");
    }
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await edit(row);
    expect(within(row).getByLabelText("Rate per kWh")).toHaveAttribute("step", "0.01");
  });

  it("still submits a rate of six decimals although the input steps by cents (the form is not validated by the browser)", async () => {
    const calls = open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-11-01", "0.123456");
    expect(within(form).getByLabelText("Rate per kWh")).toHaveValue(0.123456);
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
      .toEqual({ asset_id: null, rate_per_kwh: 0.123456, effective_from: "2026-11-01" }));
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("adds an override for the chosen asset and refuses to submit without one", async () => {
    const calls = open();
    const form = await screen.findByRole("form", { name: "Add asset override" });
    await fillRate(form, "2026-11-01", "0.1");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Choose an asset.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.selectOptions(within(form).getByLabelText("Asset"), "LV Panel 1");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
      .toEqual({ asset_id: 5, rate_per_kwh: 0.1, effective_from: "2026-11-01" }));
  });

  describe("assets that share a name", () => {
    // two rooms each have a child "PDU A"; asset 7 and 8 are twins under one parent
    const twins = [
      { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
      { id: 2, parent_id: 1, name: "Room 1", kind: "room", sort_order: 0 },
      { id: 3, parent_id: 2, name: "PDU A", kind: "pdu", sort_order: 0 },
      { id: 4, parent_id: 1, name: "Room 2", kind: "room", sort_order: 1 },
      { id: 5, parent_id: 4, name: "PDU A", kind: "pdu", sort_order: 0 },
      { id: 6, parent_id: 4, name: "Rack", kind: "rack", sort_order: 1 },
      { id: 7, parent_id: 6, name: "Meter", kind: "meter", sort_order: 0 },
      { id: 8, parent_id: 6, name: "Meter", kind: "meter", sort_order: 1 },
    ];
    const override = (id: number, asset_id: number, rate: number) => ({
      id, asset_id, asset_name: "PDU A", asset_path: asset_id === 3 ? "Site / Room 1 / PDU A" : "Site / Room 2 / PDU A",
      rate_per_kwh: rate, effective_from: "2026-10-15", created_by: 1, created_at: "2026-10-01T00:00:00Z",
    });
    beforeEach(() => {
      rows = [override(20, 3, 0.31), override(21, 5, 0.32)];
      overrides = { "GET /api/assets": { body: twins } };
    });

    it("tells the same-named assets apart in the picker and sends the id of the one chosen", async () => {
      const calls = open();
      const form = await screen.findByRole("form", { name: "Add asset override" });
      const picker = within(form).getByLabelText("Asset");
      await within(form).findByRole("option", { name: "PDU A (Site / Room 1)" });
      expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Choose an asset…", "Site", "Room 1", "PDU A (Site / Room 1)", "Room 2", "PDU A (Site / Room 2)",
        "Rack", "Meter (Site / Room 2 / Rack) #7", "Meter (Site / Room 2 / Rack) #8",
      ]);
      await fillRate(form, "2026-11-01", "0.25");
      await userEvent.selectOptions(picker, "PDU A (Site / Room 2)");
      await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
      await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
        .toEqual({ asset_id: 5, rate_per_kwh: 0.25, effective_from: "2026-11-01" }));
    });

    it("names the right asset in the override table and in the delete question", async () => {
      open();
      const table = await screen.findByRole("table", { name: "Asset overrides" });
      const body = within(table).getAllByRole("row").slice(1);
      expect(body.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["PDU A (Site / Room 1)", "PDU A (Site / Room 2)"]);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      await userEvent.click(within(body[1]).getByRole("button", { name: "Delete rate from 2026-10-15 for PDU A (Site / Room 2)" }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("for PDU A (Site / Room 2)?"));
    });
  });

  it("names the asset of an override by the API's path when the asset is not in the asset list", async () => {
    rows = [{ ...tariff(30, 99, 0.4, "2026-10-15"), asset_name: "Panel", asset_path: "Room 1 / Panel" }];
    open();
    const table = await screen.findByRole("table", { name: "Asset overrides" });
    const cells = within(within(table).getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[0].textContent).toBe("Room 1 / Panel");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(within(table).getByRole("button", { name: "Delete rate from 2026-10-15 for Room 1 / Panel" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("for Room 1 / Panel?"));
  });

  it("refuses a missing date and a negative rate without calling the API", async () => {
    const calls = open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await userEvent.type(within(form).getByLabelText("Rate per kWh"), "0.2");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(/date the rate takes effect/);
    fireEvent.change(within(form).getByLabelText("Effective from"), { target: { value: "2026-11-01" } });
    await userEvent.clear(within(form).getByLabelText("Rate per kWh"));
    await userEvent.type(within(form).getByLabelText("Rate per kWh"), "-1");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Enter a rate of zero or more.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows the server's reason when the date already has a rate (409)", async () => {
    overrides = {
      "POST /api/tariffs": { status: 409, body: { detail: "a rate for this asset (or the site default) already starts on that date" } },
    };
    open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-10-01", "0.2");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("a rate for this asset (or the site default) already starts on that date");
  });

  it("shows a readable message for a validation error (422)", async () => {
    overrides = {
      "POST /api/tariffs": {
        status: 422,
        body: { detail: [{ loc: ["body", "rate_per_kwh"], msg: "Value error, rate_per_kwh can have at most 6 decimals" }] },
      },
    };
    open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-11-01", "0.1234567");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("rate_per_kwh: rate_per_kwh can have at most 6 decimals");
    expect(alert).not.toHaveTextContent("Value error");
  });

  it("edits a rate and sends only the changed field", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await edit(row);
    const rate = within(row).getByLabelText("Rate per kWh");
    await userEvent.clear(rate);
    await userEvent.type(rate, "0.18");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ rate_per_kwh: 0.18 }));
    expect(await within(row).findByText("0.18")).toBeInTheDocument();
  });

  it("edits the effective date and sends only that", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await edit(row);
    fireEvent.change(within(row).getByLabelText("Effective from"), { target: { value: "2026-10-05" } });
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ effective_from: "2026-10-05" }));
    expect(await within(row).findByText("2026-10-05")).toBeInTheDocument();
  });

  it("shows the server's reason in the row when an edit is refused", async () => {
    overrides = {
      "PATCH /api/tariffs/2": { status: 409, body: { detail: "a rate for this asset (or the site default) already starts on that date" } },
    };
    open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await edit(row);
    fireEvent.change(within(row).getByLabelText("Effective from"), { target: { value: "2026-01-01" } });
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("already starts on that date");
  });

  it("leaves the rate alone when an edit is cancelled", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await edit(row);
    await userEvent.type(within(row).getByLabelText("Rate per kWh"), "9");
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).getByText("0.15")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("Escape ends an edit like Cancel: no request, the old rate shown, the focus back on the menu button", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await edit(row);
    await userEvent.type(within(row).getByLabelText("Rate per kWh"), "9");
    await userEvent.keyboard("{Escape}");
    expect(within(row).getByText("0.15")).toBeInTheDocument();
    expect(within(row).queryByLabelText("Rate per kWh")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(within(row).getByRole("button", { name: "Actions for rate from 2026-10-01 (site default)" })).toHaveFocus();
  });

  it("Escape on a row that is not being edited does nothing", async () => {
    open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    within(row).getByRole("button", { name: "Actions for rate from 2026-10-01 (site default)" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(within(row).getByText("0.15")).toBeInTheDocument();
  });

  it("puts the focus on the Effective from input when Edit is chosen, and gives it back to the menu button after Cancel and after Save", async () => {
    open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    const trigger = () => within(row).getByRole("button", { name: "Actions for rate from 2026-10-01 (site default)" });
    await edit(row);
    expect(within(row).getByLabelText("Effective from")).toHaveFocus(); // the menu button is gone, so the first field takes it
    expect(within(row).queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument(); // Save and Cancel replace the menu and the trash
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(trigger()).toHaveFocus();
    await edit(row);
    const rate = within(row).getByLabelText("Rate per kWh");
    await userEvent.clear(rate);
    await userEvent.type(rate, "0.18");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(row).getByText("0.18")).toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });

  it("deletes an override only after confirmation", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-15")).closest("tr")!;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(trash(row));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("LV Panel 1"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(trash(row));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/tariffs/3")).toBe(true));
    expect(await screen.findByText(/No overrides/)).toBeInTheDocument();
  });

  it("shows the error when the tariffs cannot be read", async () => {
    overrides = { "GET /api/tariffs": { status: 403, body: { detail: "insufficient role" } } };
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient role");
  });

  it("says why the asset list is empty when it cannot be read, next to the override form", async () => {
    overrides = { "GET /api/assets": { status: 500, body: { detail: "assets unavailable" } } };
    open();
    const form = await screen.findByRole("form", { name: "Add asset override" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the assets: assets unavailable");
    expect(form.contains(alert)).toBe(true);
    expect(screen.getAllByRole("alert")).toHaveLength(1); // the tariffs themselves loaded fine
    expect(within(form).getAllByRole("option")).toHaveLength(1); // only "Choose an asset…"
  });

  it("never asks for tariffs or the currency when a non-admin opens the route", async () => {
    const calls = mockFetch({ ...shellRoutes, ...routes("operator") }); // the app shell asks for its chip and clock too
    renderWithProviders(<App />, { route: "/tariffs", path: "*" });
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs" || c.path === "/api/settings/billing")).toBe(false);
  });
});

describe("TariffsPage while its lists load (W7f)", () => {
  const mount = (held: string) => {
    mockFetch(routes("admin"));
    const hold = holdFetch((_method, path) => path === held);
    renderWithProviders(<TariffsPage />, { route: "/tariffs", path: "/tariffs" });
    return hold;
  };

  it("keeps the real header and section heads and shows a one-row bar skeleton for the currency while it is held", async () => {
    const hold = mount("/api/settings/billing");
    expect(screen.getByRole("heading", { level: 1, name: "Tariffs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Currency" })).toBeInTheDocument();
    const region = screen.getByText("Loading the currency").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelector(".inline-form")).not.toBeNull();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Site currency" })).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("form", { name: "Site currency" })).toBeInTheDocument();
    expect(screen.queryByText("Loading the currency")).not.toBeInTheDocument();
  });

  it("shows a table skeleton for the tariffs while they are held, then the two tables and no region", async () => {
    const hold = mount("/api/tariffs");
    await screen.findByRole("form", { name: "Site currency" }); // the currency is in; the rates are not
    const region = screen.getByText("Loading tariffs").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelector(".sk-table")).not.toBeNull();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/No site default rate yet/)).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("table", { name: "Site default rates" })).toBeInTheDocument();
    expect(screen.queryByText("Loading tariffs")).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("draws both rate cards' real heads and purpose lines outside any region while the rates are held, and keeps them when the rates arrive (the skeleton must sit where the table will)", async () => {
    const hold = mount("/api/tariffs");
    await screen.findByRole("form", { name: "Site currency" });
    const siteHead = screen.getByRole("heading", { level: 2, name: "Site default rate" });
    const overridesHead = screen.getByRole("heading", { level: 2, name: "Asset overrides" });
    expect(screen.getByText(/The price per kWh used for every asset that has no override/)).toBeInTheDocument();
    expect(screen.getByText(/A different price per kWh for one asset and everything under it/)).toBeInTheDocument();
    const region = screen.getByText("Loading tariffs").parentElement!;
    expect(siteHead.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING, "the head comes before the skeleton").toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Currency", "Site default rate", "Asset overrides"]);
    for (const head of [siteHead, overridesHead]) expect(region.contains(head), "a head is real, never inside the region").toBe(false);
    hold.release();
    await screen.findByRole("table", { name: "Site default rates" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Currency", "Site default rate", "Asset overrides"]);
  });

  it("puts the one region round the left table only: nothing grey in the right card, and the Currency card keeps its real head", async () => {
    const hold = mount("/api/tariffs");
    await screen.findByRole("form", { name: "Site currency" });
    const siteCard = screen.getByRole("heading", { level: 2, name: "Site default rate" }).closest(".page-card")!;
    const overridesCard = screen.getByRole("heading", { level: 2, name: "Asset overrides" }).closest(".page-card")!;
    const currencyCard = screen.getByRole("heading", { level: 2, name: "Currency" }).closest(".page-card")!;
    expect(document.querySelectorAll(".sk-region")).toHaveLength(1);
    expect(siteCard.querySelector(".sk-region")).not.toBeNull();
    expect(siteCard.querySelectorAll(".sk-table")).toHaveLength(1);
    expect(overridesCard.querySelector(".sk, .sk-region, .sk-table")).toBeNull();
    expect(currencyCard.querySelector(".sk, .sk-region")).toBeNull(); // the currency has arrived: its real form, not a shape
    expect([...document.querySelector(".tariffs-page > .page-grid")!.children]).toEqual([currencyCard, siteCard, overridesCard]);
    hold.release();
    await screen.findByRole("table", { name: "Site default rates" });
  });

  it("draws the currency skeleton in the Currency card, under its real head, while the currency is held", async () => {
    const hold = mount("/api/settings/billing");
    const card = screen.getByRole("heading", { level: 2, name: "Currency" }).closest(".page-card")!;
    expect(card.querySelector(".sect-purpose")).toHaveTextContent("The unit costs are shown in.");
    expect(card.contains(screen.getByText("Loading the currency"))).toBe(true);
    expect(card.querySelector(".inline-form")).not.toBeNull();
    hold.release();
    const form = await screen.findByRole("form", { name: "Site currency" });
    expect(card.contains(form)).toBe(true);
  });

  it("ends with the errors as alerts, never a region, when the lists fail", async () => {
    overrides = { "GET /api/tariffs": { status: 500, body: { detail: "rates are down" } }, "GET /api/settings/billing": { status: 500, body: { detail: "settings are down" } } };
    mockFetch(routes("admin"));
    renderWithProviders(<TariffsPage />, { route: "/tariffs", path: "/tariffs" });
    expect(await screen.findByText("rates are down")).toBeInTheDocument();
    expect(await screen.findByText("settings are down")).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the empty looks when there are no rates", async () => {
    rows = [];
    open();
    expect(await screen.findByText(/No site default rate yet/)).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});
