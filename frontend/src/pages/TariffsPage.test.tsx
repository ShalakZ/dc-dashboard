import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { TariffsPage } from "./TariffsPage";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 5, parent_id: 1, name: "LV Panel 1", kind: "panel", sort_order: 0 },
];
const tariff = (id: number, asset_id: number | null, rate: number, from: string) => ({
  id, asset_id, asset_name: asset_id === 5 ? "LV Panel 1" : null, rate_per_kwh: rate,
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

  it("shows empty states when there are no rates and no overrides", async () => {
    rows = [];
    open();
    expect(await screen.findByText(/No site default rate yet/)).toBeInTheDocument();
    expect(screen.getByText(/No overrides/)).toBeInTheDocument();
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

  it("tells the admin to set the currency first, above the rate forms, until one is set", async () => {
    currency = null;
    open();
    const prompt = await screen.findByText(/Set the currency first/);
    expect(prompt).toHaveAttribute("role", "status");
    const forms = [screen.getByRole("form", { name: "Add site default rate" }), screen.getByRole("form", { name: "Add asset override" })];
    for (const form of forms) {
      expect(prompt.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await userEvent.type(screen.getByLabelText("Currency"), "QAR");
    await userEvent.click(within(currencyForm()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText(/Set the currency first/)).not.toBeInTheDocument());
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
      id, asset_id, asset_name: "PDU A", rate_per_kwh: rate, effective_from: "2026-10-15", created_by: 1, created_at: "2026-10-01T00:00:00Z",
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
      await userEvent.click(within(body[1]).getByRole("button", { name: "Delete" }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("for PDU A (Site / Room 2)?"));
    });
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
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
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
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
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
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(row).getByLabelText("Effective from"), { target: { value: "2026-01-01" } });
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("already starts on that date");
  });

  it("leaves the rate alone when an edit is cancelled", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    await userEvent.type(within(row).getByLabelText("Rate per kWh"), "9");
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).getByText("0.15")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("deletes an override only after confirmation", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-15")).closest("tr")!;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("LV Panel 1"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/tariffs/3")).toBe(true));
    expect(await screen.findByText(/No overrides/)).toBeInTheDocument();
  });

  it("shows the error when the tariffs cannot be read", async () => {
    overrides = { "GET /api/tariffs": { status: 403, body: { detail: "insufficient role" } } };
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient role");
  });

  it("never asks for tariffs or the currency when a non-admin opens the route", async () => {
    const calls = mockFetch(routes("operator"));
    renderWithProviders(<App />, { route: "/tariffs", path: "*" });
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs" || c.path === "/api/settings/billing")).toBe(false);
  });
});
