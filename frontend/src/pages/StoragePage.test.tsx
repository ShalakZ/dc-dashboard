import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { StoragePage, validate } from "./StoragePage";

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
    expect(await screen.findByText(/^full /)).toBeInTheDocument();
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
    body: { detail: "Saving these settings deletes stored readings now: 5 chunks of raw readings (7 days each, 2026-08-06 to 2026-09-10, 0.3 MB).", deletes_now: true, shorter: false },
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
