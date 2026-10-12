import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIELD_HELP, TILE_HELP } from "../lib/storageHelp";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { checkRange, FIELDS, sizeText, StoragePage, validate } from "./StoragePage";

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "a", role: "admin" } },
};
const settings = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
const settingsOut = { ...settings, factory: { ...settings } };
const stats = {
  database_bytes: 5 * 1024 ** 3, readings_bytes_uncompressed: 4 * 1024 ** 3, readings_bytes_compressed: 1 * 1024 ** 3,
  readings_bytes_total: 2 * 1024 ** 3, rollup_1m_bytes: 1024 ** 2, rollup_1h_bytes: 1024 ** 2,
  rows_per_day: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, rows: 1000 * (i + 1) })),
  growth_bytes_per_day: 100 * 1024 ** 2, disk_capacity_bytes: 100 * 1024 ** 3, used_pct: 5, days_until_full: 972.8, warn: false, settings,
};

describe("StoragePage", () => {
  it("shows sizes, projection and rows per day", async () => {
    mockFetch({ ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settingsOut } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByText(/5\.0 GiB/)).toBeInTheDocument();
    expect(screen.getByText(/973 days/)).toBeInTheDocument();
    expect(screen.getByText("7,000")).toBeInTheDocument();
    expect(screen.getByText(/capacity is a setting/i)).toBeInTheDocument();
  });

  it("saves settings and rejects invalid combinations", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/storage": { body: stats },
      "GET /api/settings/storage": { body: settingsOut },
      "PUT /api/settings/storage": (req) => ({ body: { ...settings, ...(req.body as object) } }),
    });
    const put = () => calls.filter((c) => c.method === "PUT");
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    const compress = screen.getByLabelText(/compress after/i);
    await userEvent.clear(compress);
    await userEvent.type(compress, "20");
    await userEvent.clear(raw);
    await userEvent.type(raw, "15");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/raw retention must be at least one day longer/i)).toBeInTheDocument();
    expect(put()).toHaveLength(0);
    await userEvent.clear(raw);
    await userEvent.type(raw, "45");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(put()).toHaveLength(1));
    expect((put()[0].body as { raw_retention_days: number }).raw_retention_days).toBe(45);
  });

  it("sends exactly the five settings on Save and never the factory values the server also returns", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/storage": { body: stats },
      "GET /api/settings/storage": { body: settingsOut },
      "PUT /api/settings/storage": (req) => ({ body: { ...settings, ...(req.body as object) } }),
    });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    const sent = calls.find((c) => c.method === "PUT")!.body as object;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(settings).sort());
    expect(sent).toEqual(settings);
    expect(sent).not.toHaveProperty("factory");
  });

  it("refuses a raw retention under 8 days before asking the server, like the server does", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/storage": { body: stats },
      "GET /api/settings/storage": { body: { ...settingsOut, compress_after_days: 1 } },
      "PUT /api/settings/storage": (req) => ({ body: { ...settings, ...(req.body as object) } }),
    });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "7");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("raw retention must be at least 8 days, one more than the 7-day rollup refresh window")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.clear(raw);
    await userEvent.type(raw, "8");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    expect((calls.find((c) => c.method === "PUT")!.body as { raw_retention_days: number }).raw_retention_days).toBe(8);
  });

  it("says full when capacity is exhausted and not growing only when growth is zero", async () => {
    mockFetch({
      ...base,
      "GET /api/storage": { body: { ...stats, used_pct: 104.5, days_until_full: null, warn: true } },
      "GET /api/settings/storage": { body: settingsOut },
    });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByText("full")).toBeInTheDocument();  // the tile's figure is the word alone (the caption "Projected full" is not an exact match)
    expect(screen.queryByText(/not growing/)).not.toBeInTheDocument();
  });

  it("says not growing when growth is zero and capacity remains", async () => {
    mockFetch({
      ...base,
      "GET /api/storage": { body: { ...stats, growth_bytes_per_day: 0, days_until_full: null } },
      "GET /api/settings/storage": { body: settingsOut },
    });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByText(/not growing/)).toBeInTheDocument();
  });

  it("shows the warning when the threshold is crossed", async () => {
    mockFetch({
      ...base,
      "GET /api/storage": { body: { ...stats, used_pct: 91, warn: true } },
      "GET /api/settings/storage": { body: settingsOut },
    });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/91/);
  });
});

describe("validate", () => {
  const ok = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
  it("needs a raw retention of at least 8 days, one more than the rollup refresh window, however short the compression delay", () => {
    expect(validate({ ...ok, compress_after_days: 1, raw_retention_days: 7 })).toMatch(/at least 8 days/);
    expect(validate({ ...ok, compress_after_days: 1, raw_retention_days: 8 })).toBeNull();
  });
  it("keeps the other rules", () => {
    expect(validate({ ...ok, compress_after_days: 20, raw_retention_days: 15 })).toMatch(/one day longer than compression delay/);
    expect(validate({ ...ok, rollup_1m_retention_days: 29 })).toMatch(/must not be shorter than raw retention/);
    expect(validate({ ...ok, disk_capacity_gb: 0 })).toMatch(/must be positive/);
    expect(validate(ok)).toBeNull();
  });
});

const SITE_DEFAULT = { raw_retention_days: 60, compress_after_days: 10, rollup_1m_retention_days: 365, disk_capacity_gb: 500, warn_threshold_pct: 70 };
const withDefault = { ...settingsOut, site_default: SITE_DEFAULT };
const routes = (extra = {}, out: object = settingsOut) => ({
  ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: out }, ...extra,
});

describe("StoragePage defaults, resets and the confirmation", () => {
  it("Reset to factory settings fills the form with the factory values and sends nothing", async () => {
    const calls = mockFetch(routes({}, { ...withDefault, raw_retention_days: 45 }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    expect(raw).toHaveValue(45);
    await userEvent.click(screen.getByRole("button", { name: /reset to factory settings/i }));
    expect(raw).toHaveValue(30);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Reset to default fills the form with the site default when one is set", async () => {
    const calls = mockFetch(routes({}, withDefault));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.click(screen.getByRole("button", { name: /^reset to default$/i }));
    expect(raw).toHaveValue(60);
    expect(screen.getByLabelText(/disk capacity/i)).toHaveValue(500);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Reset to default falls back to the factory values when no site default is set, and says so", async () => {
    mockFetch(routes({}, { ...settingsOut, raw_retention_days: 45 }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    expect(screen.getByText(/no site default has been set/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^reset to default$/i }));
    expect(raw).toHaveValue(30);
  });

  it("Set as default sends the form to the default route, not to the live settings, and says it is not in use yet", async () => {
    const calls = mockFetch(routes({ "PUT /api/settings/storage/default": (req: { body: unknown }) => ({ body: req.body as object }) }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "60");
    await userEvent.click(screen.getByRole("button", { name: /set as default/i }));
    expect(await screen.findByText(/not in use yet/i)).toBeInTheDocument();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe("/api/settings/storage/default");
    expect(puts[0].body).toEqual({ ...settings, raw_retention_days: 60 });
  });

  it("Set as default refuses invalid values before asking the server", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "3");
    await userEvent.click(screen.getByRole("button", { name: /set as default/i }));
    expect(await screen.findByText(/at least 8 days/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  const lossReply = {
    status: 409,
    body: { detail: "Saving these settings deletes stored readings now: 5 chunks of raw readings (7 days each, 2026-08-06 to 2026-09-10, 0.3 MB). Repeat the request with confirm=true to go ahead.", deletes_now: true, shorter: false },
  };

  it("asks before a save that deletes data and repeats the request with confirm=true", async () => {
    const urls: string[] = [];
    mockFetch(routes({
      "PUT /api/settings/storage": (req: { url: string; body: unknown }) => {
        urls.push(req.url);
        return req.url.includes("confirm=true") ? { body: { ...settings, ...(req.body as object) } } : lossReply;
      },
    }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/5 chunks of raw readings/);
    expect(dialog).not.toHaveTextContent(/confirm=true/);  // the API hint is for scripts, not for the person at the page
    expect(urls).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: /save and delete/i }));
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain("confirm=true");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel in that dialog sends nothing more", async () => {
    const urls: string[] = [];
    mockFetch(routes({ "PUT /api/settings/storage": (req: { url: string }) => { urls.push(req.url); return lossReply; } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(urls).toHaveLength(1);
  });

  it("words the dialog for a shorter limit that deletes nothing yet", async () => {
    mockFetch(routes({
      "PUT /api/settings/storage": { status: 409, body: { detail: "These settings shorten how long readings are kept. Nothing stored today is old enough to be deleted.", deletes_now: false, shorter: true } },
    }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    const dialog = await screen.findByRole("dialog", { name: "Shorten retention?" });
    expect(within(dialog).getByRole("button", { name: "Shorten and save" })).toBeInTheDocument();
  });

  it("shows another error from the server as text, not as the confirmation", async () => {
    mockFetch(routes({ "PUT /api/settings/storage": { status: 422, body: { detail: "raw retention must be at least 8 days" } } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/raw retention must be at least 8 days/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a banner while retention is paused and none otherwise", async () => {
    mockFetch({ ...routes(), "GET /api/storage": { body: { ...stats, retention_paused: true } } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByText(/retention is paused/i)).toBeInTheDocument();
  });

  it("shows no banner while retention is armed", async () => {
    mockFetch({ ...routes(), "GET /api/storage": { body: { ...stats, retention_paused: false } } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
    expect(screen.queryByText(/retention is paused/i)).not.toBeInTheDocument();
  });
});

describe("validate bounds", () => {
  const ok = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
  it("refuses what the server refuses", () => {
    expect(validate({ ...ok, raw_retention_days: 3651, rollup_1m_retention_days: 5000 })).toMatch(/3650/);
    expect(validate({ ...ok, compress_after_days: 0 })).toMatch(/between 1 and 365/);
    expect(validate({ ...ok, compress_after_days: 366, raw_retention_days: 400 })).toMatch(/between 1 and 365/);
    expect(validate({ ...ok, rollup_1m_retention_days: 36501 })).toMatch(/36500/);
    expect(validate({ ...ok, raw_retention_days: 8, compress_after_days: 1, rollup_1m_retention_days: 20 })).toMatch(/between 30 and 36500/);
    expect(validate({ ...ok, disk_capacity_gb: 1_000_001 })).toMatch(/1,000,000/);
    expect(validate({ ...ok, warn_threshold_pct: 49 })).toMatch(/between 50 and 99/);
    expect(validate({ ...ok, warn_threshold_pct: 100 })).toMatch(/between 50 and 99/);
  });
  it("accepts the bounds themselves", () => {
    expect(validate({ ...ok, raw_retention_days: 3650, rollup_1m_retention_days: 3650 })).toBeNull();
    expect(validate({ ...ok, compress_after_days: 365, raw_retention_days: 366 })).toBeNull();
    expect(validate({ ...ok, rollup_1m_retention_days: 36500 })).toBeNull();
    expect(validate({ ...ok, raw_retention_days: 8, compress_after_days: 1, rollup_1m_retention_days: 30 })).toBeNull();
    expect(validate({ ...ok, disk_capacity_gb: 1_000_000 })).toBeNull();
    expect(validate({ ...ok, warn_threshold_pct: 50 })).toBeNull();
    expect(validate({ ...ok, warn_threshold_pct: 99 })).toBeNull();
  });
  it("wants whole numbers where the server wants integers, and any number for the capacity", () => {
    expect(validate({ ...ok, raw_retention_days: 30.5 })).toMatch(/whole number/);
    expect(validate({ ...ok, warn_threshold_pct: 80.5 })).toMatch(/whole number/);
    expect(validate({ ...ok, disk_capacity_gb: 0.5 })).toBeNull();
    expect(validate({ ...ok, disk_capacity_gb: Number.NaN })).toMatch(/must be a number/);
  });
});

describe("StoragePage summary tiles and explanations", () => {
  const tileOf = (caption: string) => screen.getByText(caption).closest(".tile") as HTMLElement;
  const CAPTIONS = { database: "Database size", readings: "Readings (raw)", rollups: "Rollups", growth: "Growth per day", projected: "Projected full" } as const;

  it("shows the five figures in tiles and no longer in a key/value list", async () => {
    mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByText("Database size");
    expect(tileOf("Database size")).toHaveTextContent("5.0 GiB");
    expect(tileOf("Readings (raw)")).toHaveTextContent("2.0 GiB");
    expect(tileOf("Readings (raw)")).toHaveTextContent("compressed 1.0 GiB of 4.0 GiB, ratio 0.25");
    expect(tileOf("Rollups")).toHaveTextContent("1 min 1.0 MiB, 1 h 1.0 MiB"); // under 1 GiB: MiB
    expect(tileOf("Growth per day")).toHaveTextContent("100.0 MiB / day");
    expect(tileOf("Projected full")).toHaveTextContent("973 days");
    expect(tileOf("Projected full")).toHaveTextContent("5% of 100.0 GiB");
    expect(document.querySelector(".storage-page dl")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("reads a small database in MiB, not as 0.0 GiB, and groups the digits of a long projection", async () => {
    mockFetch({ ...routes(), "GET /api/storage": { body: { ...stats, database_bytes: 40 * 1024 ** 2, growth_bytes_per_day: 0, days_until_full: 71_615.4, used_pct: 0.01 } } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByText("Database size");
    expect(tileOf("Database size")).toHaveTextContent("40.0 MiB");
    expect(tileOf("Database size")).not.toHaveTextContent("GiB");
    expect(tileOf("Growth per day")).toHaveTextContent("0.0 MiB / day");
    expect(tileOf("Projected full")).toHaveTextContent("71,615 days");
  });

  it("sizeText: MiB below 1 GiB, GiB from there, and never 1024.0 MiB", () => {
    expect(sizeText(0)).toBe("0.0 MiB");
    expect(sizeText(5 * 1024 ** 2)).toBe("5.0 MiB");
    expect(sizeText(1024 ** 3 - 1024 ** 2)).toBe("1023.0 MiB");
    expect(sizeText(1024 ** 3 - 1024 ** 2 / 100)).toBe("1.0 GiB"); // 1023.99 MiB
    expect(sizeText(1024 ** 3)).toBe("1.0 GiB");
    expect(sizeText(5 * 1024 ** 3)).toBe("5.0 GiB");
  });

  it("says nothing is compressed yet instead of a ratio when no chunk is compressed", async () => {
    mockFetch({ ...routes(), "GET /api/storage": { body: { ...stats, readings_bytes_compressed: 0, readings_bytes_uncompressed: 0 } } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByText("Database size");
    expect(tileOf("Readings (raw)")).toHaveTextContent("nothing compressed yet");
    expect(tileOf("Readings (raw)")).not.toHaveTextContent(/ratio/);
  });

  it("each tile has a tip that opens with its sentence", async () => {
    mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByText("Database size");
    for (const [key, caption] of Object.entries(CAPTIONS) as [keyof typeof CAPTIONS, string][]) {
      const button = within(tileOf(caption)).getByRole("button", { name: "What does this mean?" });
      await userEvent.click(button);
      expect(screen.getByRole("note"), caption).toHaveTextContent(TILE_HELP[key]);  // one tip is open at a time
    }
  });

  it("each retention and capacity field has a tip beside its label, never inside it, with the sentence from storageHelp", async () => {
    mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
    for (const [key, label] of FIELDS) {
      const field = screen.getByLabelText(label).closest(".has-tip") as HTMLElement;
      const button = within(field).getByRole("button", { name: "What does this mean?" });
      expect(button.closest("label"), label).toBeNull();
      await userEvent.click(button);
      expect(screen.getByRole("note"), label).toHaveTextContent(FIELD_HELP[key]);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    }
  });
});

describe("checkRange", () => {
  it("accepts a good range, a single day and the longest allowed span (366 days)", () => {
    expect(checkRange("2026-10-01", "2026-10-07", "2026-10-07")).toBeNull();
    expect(checkRange("2026-10-07", "2026-10-07", "2026-10-07")).toBeNull();
    expect(checkRange("2025-10-07", "2026-10-07", "2026-10-07")).toBeNull();
  });
  it("refuses a first day after the last day, a last day after today and 367 days, in the server's order", () => {
    expect(checkRange("2026-10-09", "2026-10-07", "2026-10-07")).toBe("The first day must not be after the last day.");
    expect(checkRange("2026-10-01", "2026-10-08", "2026-10-07")).toBe("Choose days up to today (UTC).");
    expect(checkRange("2025-10-06", "2026-10-07", "2026-10-07")).toBe("At most 366 days at a time.");
    expect(checkRange("2026-10-09", "2026-10-08", "2026-10-07")).toBe("The first day must not be after the last day.");
    expect(checkRange("2024-01-01", "2026-10-08", "2026-10-07")).toBe("Choose days up to today (UTC).");
  });
});

describe("StoragePage rows per day by date", () => {
  const from = () => screen.getByLabelText("Rows from day");
  const to = () => screen.getByLabelText("Rows to day");
  const rangeBody = (start: string, end: string, extra: object = {}) => ({
    start, end, first_day: "2026-09-01", last_day: "2026-10-07", total_rows: 6, ...extra,
    days: [{ day: start, rows: 2 }, { day: end, rows: 4 }],
  });
  const rangeCalls = (calls: { path: string }[]) => calls.filter((c) => c.path === "/api/storage/rows-per-day");
  const open = async (rangeRoute: object) => {
    const urls: string[] = [];
    const calls = mockFetch(routes({ "GET /api/storage/rows-per-day": (req: { url: string }) => { urls.push(req.url); return rangeRoute; } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText("Rows from day");
    return { urls, calls };
  };

  it("starts on the last 7 days from the storage reply, with no extra request, and says the days are UTC days", async () => {
    const { calls } = await open({ body: rangeBody("2026-09-28", "2026-10-07") });
    expect(from()).toHaveValue("2026-10-01");
    expect(to()).toHaveValue("2026-10-07");
    expect(screen.getByText("7,000")).toBeInTheDocument();
    expect(screen.getByText("28,000 rows in total")).toBeInTheDocument();
    expect(screen.getByText(/UTC days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 7 days" })).toBeInTheDocument();
    expect(rangeCalls(calls)).toHaveLength(0);
  });

  it("loads a valid range with one request carrying both days, and fills min and max from the answer", async () => {
    const { urls } = await open({ body: rangeBody("2026-09-28", "2026-10-07") });
    fireEvent.change(from(), { target: { value: "2026-09-28" } });
    expect(await screen.findByText("2026-09-28")).toBeInTheDocument();
    expect(screen.getByText("6 rows in total")).toBeInTheDocument();
    expect(screen.queryByText("7,000")).not.toBeInTheDocument();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("start=2026-09-28");
    expect(urls[0]).toContain("end=2026-10-07");
    expect(from()).toHaveAttribute("min", "2026-09-01");
    expect(to()).toHaveAttribute("max", "2026-10-07");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a first day after the last day shows the message, sends nothing and leaves the table", async () => {
    const { calls } = await open({ body: rangeBody("2026-10-09", "2026-10-07") });
    fireEvent.change(from(), { target: { value: "2026-10-09" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("The first day must not be after the last day.");
    expect(screen.getByText("7,000")).toBeInTheDocument();
    expect(rangeCalls(calls)).toHaveLength(0);
  });

  it("a last day after today and a span over 366 days are refused the same way", async () => {
    const { calls } = await open({ body: rangeBody("2026-10-01", "2026-10-08") });
    fireEvent.change(to(), { target: { value: "2026-10-08" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose days up to today (UTC).");
    fireEvent.change(to(), { target: { value: "2026-10-07" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(from(), { target: { value: "2025-10-06" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("At most 366 days at a time.");
    expect(rangeCalls(calls)).toHaveLength(0);
    expect(screen.getByText("7,000")).toBeInTheDocument();
  });

  it("a cleared date input shows no message, sends nothing and keeps the table", async () => {
    const { calls } = await open({ body: rangeBody("2026-09-28", "2026-10-07") });
    fireEvent.change(to(), { target: { value: "" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("7,000")).toBeInTheDocument();
    expect(rangeCalls(calls)).toHaveLength(0);
  });

  it("Last 7 days puts the first rows back without another request", async () => {
    const { urls } = await open({ body: rangeBody("2026-09-28", "2026-10-07") });
    fireEvent.change(from(), { target: { value: "2026-09-28" } });
    await screen.findByText("6 rows in total");
    await userEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(screen.getByText("7,000")).toBeInTheDocument();
    expect(screen.getByText("28,000 rows in total")).toBeInTheDocument();
    expect(from()).toHaveValue("2026-10-01");
    expect(to()).toHaveValue("2026-10-07");
    expect(urls).toHaveLength(1);
  });

  it("takes the latest allowed day from the last answer, so a server a day ahead of the first reply is not second-guessed", async () => {
    const { urls } = await open({ body: rangeBody("2026-09-28", "2026-10-07", { last_day: "2026-10-08" }) });
    fireEvent.change(from(), { target: { value: "2026-09-28" } });
    await screen.findByText("6 rows in total");
    fireEvent.change(to(), { target: { value: "2026-10-08" } });
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(urls[1]).toContain("end=2026-10-08");
  });

  it("shows a table skeleton while the range is on its way and the server's text when it refuses", async () => {
    const real = globalThis.fetch;
    mockFetch(routes());
    const mocked = globalThis.fetch;
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("rows-per-day") ? new Promise<Response>((resolve) => { release = resolve; }) : mocked(input, init);
    }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText("Rows from day");
    fireEvent.change(from(), { target: { value: "2026-09-28" } });
    const region = (await screen.findByText("Loading rows per day")).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(2);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("7,000")).not.toBeInTheDocument();
    release(new Response(JSON.stringify({ detail: "The end day is in the future; the latest day is 2026-10-06." }), { status: 422, headers: { "content-type": "application/json" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The end day is in the future; the latest day is 2026-10-06.");
    expect(document.querySelector(".sk-region")).toBeNull();
    vi.stubGlobal("fetch", real);
  });

  it("says No readings stored yet. for a site whose hourly tier is empty", async () => {
    await open({ body: rangeBody("2026-09-28", "2026-10-07", { first_day: null, total_rows: 0 }) });
    fireEvent.change(from(), { target: { value: "2026-09-28" } });
    expect(await screen.findByText("No readings stored yet.")).toBeInTheDocument();
    expect(from()).not.toHaveAttribute("min");
  });
});

describe("StoragePage while it loads (W7f)", () => {
  const LABEL = "Loading storage";
  const mount = (held: string) => {
    mockFetch({ ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settingsOut } });
    const hold = holdFetch((_method, path) => path === held);
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    return hold;
  };

  it.each(["/api/storage", "/api/settings/storage"])("shows the real header, five tiles and a form skeleton in one region while %s is held, then the page and no region", async (held) => {
    const hold = mount(held);
    expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".tiles.storage-tiles > .tile")).toHaveLength(5);
    expect(region.querySelectorAll(".storage-tiles .tile > small")).toHaveLength(3); // three of the five real tiles carry a note
    expect(region.querySelector(".form-card.wide")).not.toBeNull();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument(); // the tiles' tips and the form's buttons wait for the data
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByText(/5\.0 GiB/)).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    expect(await screen.findByLabelText(/raw retention/i)).toBeInTheDocument();
  });

  it("ends with the error alone when the storage request fails, and no region", async () => {
    mockFetch({ ...base, "GET /api/storage": { status: 500, body: { detail: "storage is down" } }, "GET /api/settings/storage": { body: settingsOut } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByRole("alert")).toHaveTextContent("storage is down");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});
