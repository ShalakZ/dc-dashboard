import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Icon, type IconName } from "../components/Icon";
import { READ_ONLY_TEXT } from "../components/ReadOnlyNote";
import type { PermissionId } from "../lib/permissions";
import { FIELD_HELP, TILE_HELP } from "../lib/storageHelp";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { pastSaveWindow, useSaveClock } from "../test/saveWindow";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { checkRange, DISK_NOTE, dayMonth, FIELDS, READINGS_NOTE, sizeText, StoragePage, UTC_NOTE, validate } from "./StoragePage";

// w32: the System events card asks for the retention of the journal, and for the site's time zone (the day of its oldest event).
const eventsOut = {
  retention_days: 90, max_rows: 100_000, factory: { retention_days: 90, max_rows: 100_000 },
  bounds: { retention_days: [7, 400], max_rows: [10_000, 1_000_000] }, kept: 3412, oldest: "2026-07-24T08:15:00Z",
};
const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("admin", { username: "a" }) },
  "GET /api/settings/events": { body: eventsOut },
  "GET /api/site": { body: { timezone: "UTC", currency: null } },
};
const settings = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
const settingsOut = { ...settings, factory: { ...settings } };
const stats = {
  database_bytes: 5 * 1024 ** 3, readings_bytes_uncompressed: 4 * 1024 ** 3, readings_bytes_compressed: 1 * 1024 ** 3,
  readings_bytes_total: 2 * 1024 ** 3, rollup_1m_bytes: 1024 ** 2, rollup_1h_bytes: 1024 ** 2,
  rows_per_day: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, rows: 1000 * (i + 1) })),
  growth_bytes_per_day: 100 * 1024 ** 2, disk_capacity_bytes: 100 * 1024 ** 3, used_pct: 5, days_until_full: 972.8, warn: false, settings,
};

useSaveClock();

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
    pastSaveWindow();
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
    pastSaveWindow();
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
    expect(await screen.findByText("This site's default is updated. It is not in use yet: press Save to use these values.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("data-phase", "idle"); // Set as default is not a save of the live settings
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

  it("each caption is an icon and the title in one label group, then the tip at the right; the icon is decoration", async () => {
    mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByText("Database size");
    const ICON: Record<keyof typeof CAPTIONS, IconName> = { database: "storage", readings: "readings", rollups: "layers", growth: "trend", projected: "hourglass" };
    const glyph = (name: IconName) => render(<Icon name={name} />).container.querySelector("svg")!.innerHTML;
    for (const [key, caption] of Object.entries(CAPTIONS) as [keyof typeof CAPTIONS, string][]) {
      const head = tileOf(caption).firstElementChild!;
      expect([...head.children].map((child) => child.className), caption).toEqual(["tile-label", "tip"]);
      const icon = head.querySelector(".tile-label > svg.i")!;
      expect(icon, caption).toHaveAttribute("aria-hidden", "true");
      expect(icon.innerHTML, caption).toBe(glyph(ICON[key]));
      expect(head.querySelector(".tile-label"), caption).toHaveTextContent(caption);
    }
    expect(screen.getAllByRole("button", { name: "What does this mean?" }).length).toBeGreaterThanOrEqual(5);
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

describe("StoragePage cards and data bars (W7j)", () => {
  const glyph = (name: IconName) => render(<Icon name={name} />).container.querySelector("svg")!.innerHTML;
  const withRows = (counts: number[]) => ({ ...stats, rows_per_day: counts.map((rows, i) => ({ day: `2026-10-0${i + 1}`, rows })) });
  const dayRows = () => [...document.querySelectorAll<HTMLElement>(".rows-day tbody tr")];
  const fillOf = (row: HTMLElement) => row.querySelector<HTMLElement>(".databar-fill");
  const open = async (body: object = stats) => {
    mockFetch(routes({ "GET /api/storage": { body } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
  };

  it("puts Rows per day and Retention and capacity side by side in one page grid under the tiles, each card with its icon, and the System events card (w32) under both", async () => {
    await open();
    const grid = document.querySelector(".storage-page > .page-grid")!;
    expect(document.querySelector(".storage-tiles")!.nextElementSibling).toBe(grid);
    expect([...grid.children].map((card) => card.tagName + "." + [...card.classList].join("."))).toEqual([
      "SECTION.page-card.rows-day", "SECTION.page-card.retention-card", "SECTION.page-card.storage-events.span-all",
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Rows per day", "Retention and capacity", "System events and the audit log"]);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const [days, retention, events] = [...grid.children];
    expect(events.querySelector(":scope > .page-card-head > svg.i")).toHaveAttribute("aria-hidden", "true");
    expect(events.querySelector(":scope > .page-card-head > svg.i")!.innerHTML).toBe(glyph("events"));
    expect(days.querySelector(":scope > .page-card-head > svg.i")).toHaveAttribute("aria-hidden", "true");
    expect(days.querySelector(":scope > .page-card-head > svg.i")!.innerHTML).toBe(glyph("calendar"));
    expect(retention.querySelector(":scope > .page-card-head > svg.i")!.innerHTML).toBe(glyph("database"));
    expect(days.querySelector("h2.section-title")).toBeNull(); // the card's own head replaces the loose heading
  });

  it("keeps the range fields, Last 7 days, the UTC note and the count in the Rows per day card", async () => {
    await open();
    const card = screen.getByRole("heading", { name: "Rows per day" }).closest(".page-card") as HTMLElement;
    expect(within(card).getByLabelText("Rows from day")).toBeInTheDocument();
    expect(within(card).getByLabelText("Rows to day")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Last 7 days" })).toBeInTheDocument();
    expect(within(card).getByText(/Days are UTC days/)).toBeInTheDocument();
    expect(within(card).getByText("28,000 rows in total")).toBeInTheDocument();
    expect(within(card).getAllByRole("row")).toHaveLength(7);
  });

  it("puts the count above the day table and the UTC note under it, in the skeleton's order (the note's line count depends on the card's width, so it must not sit above the table)", async () => {
    await open();
    const card = screen.getByRole("heading", { name: "Rows per day" }).closest(".page-card") as HTMLElement;
    const order = [...card.children].map((child) => (child.matches("p") ? "p:" + child.textContent!.slice(0, 8) : child.className.split(" ")[0]));
    expect(order).toEqual(["page-card-head", "rows-range", "p:28,000 r", "table-wrap", "p:Days are"]);
    expect(card.querySelector(".table-wrap")).toHaveClass("day-table"); // the class the 24rem height limit hangs on; the skeleton's table has none
  });

  it("keeps Save, Set as default and both Resets inside the retention form, with the free-disk sentence in the card above them (R3)", async () => {
    await open();
    const card = screen.getByRole("heading", { name: "Retention and capacity" }).closest(".page-card") as HTMLElement;
    const form = card.querySelector(":scope > form.retention-form")!;
    for (const name of ["Save", "Set as default", "Reset to default", "Reset to factory settings"]) {
      expect(screen.getByRole("button", { name }).closest("form"), name).toBe(form);
    }
    expect(form.querySelectorAll(".page-card-foot")).toHaveLength(0);
    expect(card.querySelector(":scope > .page-card-foot")).toBeNull(); // Save is not in a footer outside its form
    const sentence = within(card as HTMLElement).getByText("Free disk space is not visible from the API container; capacity is a setting below. Set it to the size of the volume holding the database.");
    expect(sentence.compareDocumentPosition(screen.getByRole("button", { name: "Save" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(/Free disk space is not visible/)).toHaveLength(1);
    expect(FIELDS).toHaveLength(5);
    expect(form.querySelectorAll(".retention-fields > .has-tip")).toHaveLength(5);
  });

  // W18 R5: removing assets or sources leaves their readings stored; the card says so, once, as a static muted paragraph right under the free-disk note
  // (the skeleton draws it too, in the same place).
  it("says under the free-disk sentence that removing assets or sources keeps their readings, in a plain muted paragraph (no live region, no role)", async () => {
    await open();
    const card = screen.getByRole("heading", { name: "Retention and capacity" }).closest(".page-card") as HTMLElement;
    const disk = within(card).getByText(DISK_NOTE);
    const readings = within(card).getByText(READINGS_NOTE);
    expect(readings.tagName).toBe("P");
    expect(readings).toHaveClass("muted");
    expect(disk.nextElementSibling).toBe(readings);
    expect(readings.nextElementSibling).toBe(card.querySelector(":scope > form.retention-form"));
    expect(readings).not.toHaveAttribute("role");
    expect(readings.closest("[aria-live]")).toBeNull();
    expect(screen.getAllByText(/does not remove their readings/)).toHaveLength(1);
    expect(READINGS_NOTE).toBe(
      "Removing assets or sources does not remove their readings. They leave when retention drops them (see the limits below), except the hourly summaries, which stay. Shorten the retention to free space sooner; saving a shorter retention asks first.",
    );
  });

  it("Save in the card still sends the five settings through the form", async () => {
    const calls = mockFetch(routes({ "PUT /api/settings/storage": (req: { body: unknown }) => ({ body: { ...settings, ...(req.body as object) } }) }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual(settings);
    expect(await screen.findByRole("button", { name: "Saved" })).toHaveAttribute("data-phase", "saved");
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument(); // the button is the confirmation; no loose note
  });

  it("draws a bar in every row's number cell: the largest day full, the others a share of it, a day with no rows empty", async () => {
    await open(withRows([0, 500, 1000, 250]));
    const rows = dayRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => fillOf(row)?.style.width)).toEqual(["0%", "50%", "100%", "25%"]);
    for (const row of rows) {
      expect(row.querySelectorAll(":scope > td")).toHaveLength(2); // the skeleton's two columns stay right
      const track = row.querySelector(":scope > td:last-child > .databar-cell > .databar")!;
      expect(track).toHaveAttribute("aria-hidden", "true");
      expect(track.querySelector(":scope > .databar-fill")).not.toBeNull();
    }
    expect(rows.map((row) => row.querySelector(".databar-num")!.textContent)).toEqual(["0", "500", "1,000", "250"]);
    expect(screen.getByText("1,750 rows in total")).toBeInTheDocument();
  });

  it("gives a day with only a few rows a visible sliver and rounds the others to whole percents", async () => {
    await open(withRows([1, 1_000_000, 333_333]));
    expect(dayRows().map((row) => fillOf(row)?.style.width)).toEqual(["1%", "100%", "33%"]);
  });

  it("draws no fill at all when every day has zero rows, and no division by zero", async () => {
    await open(withRows([0, 0, 0, 0, 0, 0, 0]));
    const rows = dayRows();
    expect(rows).toHaveLength(7);
    expect(document.querySelectorAll(".databar-fill")).toHaveLength(0);
    expect(document.querySelectorAll(".rows-day .databar")).toHaveLength(7);
    expect(rows.every((row) => row.querySelector(".databar-num")!.textContent === "0")).toBe(true);
    expect(screen.getByText("0 rows in total")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("scales the bars of a chosen range to that range's own largest day", async () => {
    const range = {
      start: "2026-09-28", end: "2026-09-29", first_day: "2026-09-01", last_day: "2026-10-07", total_rows: 6,
      days: [{ day: "2026-09-28", rows: 2 }, { day: "2026-09-29", rows: 4 }],
    };
    mockFetch(routes({ "GET /api/storage/rows-per-day": { body: range } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    fireEvent.change(await screen.findByLabelText("Rows from day"), { target: { value: "2026-09-28" } });
    expect(await screen.findByText("6 rows in total")).toBeInTheDocument();
    expect(dayRows().map((row) => fillOf(row)?.style.width)).toEqual(["50%", "100%"]);
  });
});

describe("StoragePage while it loads (W7f)", () => {
  const LABEL = "Loading storage";
  // The page is mounted once the account is known, as RequireAuth does: what a role may change decides the shape of the loading page.
  const mount = async (held: string) => {
    mockFetch({ ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settingsOut } });
    const hold = holdFetch((_method, path) => path === held);
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await accountKnown();
    return hold;
  };

  it.each(["/api/storage", "/api/settings/storage"])("shows the real header, five tiles and a form skeleton in one region while %s is held, then the page and no region", async (held) => {
    const hold = await mount(held);
    expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".tiles.storage-tiles > .tile")).toHaveLength(5);
    expect(region.querySelectorAll(".storage-tiles .tile > small")).toHaveLength(3); // three of the five real tiles carry a note
    expect(region.querySelectorAll(".page-grid > .page-card")).toHaveLength(3); // the three cards (w32 added System events), drawn as the loaded page draws them
    expect(region.querySelector(".form-card")).toBeNull();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument(); // the tiles' tips and the form's buttons wait for the data
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByText(/5\.0 GiB/)).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    expect(await screen.findByLabelText(/raw retention/i)).toBeInTheDocument();
  });

  it("lays the page out as it will be: tiles with an icon circle each, then the two cards (Rows per day: range fields, the count, 7 day rows with no header, the UTC note; Retention: the disk note, the field grid and the buttons), all as placeholders", async () => {
    const hold = await mount("/api/storage");
    const region = screen.getByText(LABEL).parentElement!;
    expect(region.textContent, "a region holds no words but its label").toBe(LABEL);
    const order = [...region.children].filter((child) => !child.classList.contains("sr-only")).map((child) => child.tagName + "." + child.className.split(" ")[0]);
    expect(order).toEqual(["DIV.tiles", "DIV.page-grid"]); // the disk note moved into the retention card, so no line under the tiles
    expect(region.querySelectorAll(":scope > p")).toHaveLength(0);
    const day = region.querySelector(".page-grid > .page-card.rows-day")!;
    expect(day).toHaveAttribute("aria-hidden", "true");
    expect(day.querySelector(":scope > .page-card-head > .sk-block")).not.toBeNull(); // the icon tile
    expect(day.querySelector(":scope > .page-card-head h2 .sk-line")).not.toBeNull();
    expect(day.querySelectorAll(".rows-range .sk-field")).toHaveLength(2);
    expect(day.querySelectorAll(".rows-range > .sk-block")).toHaveLength(1); // the Last 7 days button
    expect(day.querySelectorAll(":scope > p.muted:not(.sk-words) .sk-line")).toHaveLength(1); // the count above the table
    expect(day.querySelectorAll(":scope > p.sk-words.muted .sk-line")).toHaveLength(UTC_NOTE.split(/\s+/).length); // the UTC note under it: its words, so it wraps as the sentence does
    expect([...day.children].map((child) => child.tagName + "." + child.className.split(" ")[0])).toEqual(["DIV.page-card-head", "DIV.rows-range", "P.muted", "DIV.table-wrap", "P.sk-words"]);
    const table = day.querySelector(":scope > .table-wrap.sk-table")!;
    expect(table.querySelector("thead")).toBeNull();
    expect(table.querySelectorAll("tbody tr")).toHaveLength(7);
    expect(table.querySelectorAll("tbody tr:first-child td")).toHaveLength(2);
    expect(region.querySelectorAll(".storage-tiles .tile > .tile-label .sk-circle")).toHaveLength(5); // the non-plain tile: a circle for the icon and a line
    const retention = region.querySelector(".page-grid > .page-card.retention-card")!;
    expect(retention).toHaveAttribute("aria-hidden", "true");
    expect(retention.querySelector(":scope > .page-card-head h2 .sk-line")).not.toBeNull();
    expect(retention.querySelectorAll(".retention-fields > .sk-field")).toHaveLength(5);
    // the three paragraphs are word pills of the real sentences (they wrap into the lines the text will, at every width; W18 added the readings note
    // right after the free-disk one, so nothing moves when the page loads), the buttons are the real 34px
    const paragraphs = retention.querySelectorAll("p.sk-words.muted");
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].querySelectorAll(".sk-line")).toHaveLength(DISK_NOTE.split(/\s+/).length);
    expect(paragraphs[1].querySelectorAll(".sk-line")).toHaveLength(READINGS_NOTE.split(/\s+/).length);
    expect(paragraphs[1].previousElementSibling).toBe(paragraphs[0]);
    expect(paragraphs[2].querySelectorAll(".sk-line").length).toBeGreaterThan(30);
    expect([...retention.querySelectorAll(".retention-foot .row > .sk-block")].map((b) => (b as HTMLElement).style.height)).toEqual(["34px", "34px", "34px", "34px"]);
    // none of it is in the accessibility tree and nothing can be focused
    expect(screen.queryByRole("heading", { name: "Rows per day" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Retention and capacity" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rows from day")).not.toBeInTheDocument();
    expect(region.querySelector("input, button, a, select")).toBeNull();
    hold.release();
    expect(await screen.findByRole("heading", { name: "Rows per day" })).toBeInTheDocument();
    expect(document.querySelectorAll(".rows-day")).toHaveLength(1);
  });

  it("ends with the error alone when the storage request fails, and no region", async () => {
    mockFetch({ ...base, "GET /api/storage": { status: 500, body: { detail: "storage is down" } }, "GET /api/settings/storage": { body: settingsOut } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByRole("alert")).toHaveTextContent("storage is down");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});

describe("StoragePage controls follow the permissions of the role (a custom role)", () => {
  /** A role called "custom" that holds `permissions`; the page is up and the account is known when this returns. */
  const show = async (permissions: PermissionId[], siteDefault?: typeof settings) => {
    const calls = mockFetch({
      ...base,
      "GET /api/me": { body: userFor("custom", { permissions }) },
      "GET /api/storage": { body: stats },
      "GET /api/settings/storage": { body: { ...settingsOut, site_default: siteDefault } },
      "PUT /api/settings/storage": (req) => ({ body: { ...settings, ...(req.body as object) } }),
      "PUT /api/settings/storage/default": (req) => ({ body: { ...settings, ...(req.body as object) } }),
    });
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
    await accountKnown();
    return calls;
  };

  it("storage.view alone: the five fields are disabled, no Save, Set as default or Reset, one read-only line, and nothing is sent", async () => {
    const calls = await show(["storage.view"]);
    for (const [, label] of FIELDS) expect(screen.getByLabelText(label)).toBeDisabled();
    for (const name of ["Save", "Set as default", "Reset to default", "Reset to factory settings"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.getAllByText(READ_ONLY_TEXT)).toHaveLength(1);
    expect(screen.queryByText(/The two Resets/)).not.toBeInTheDocument();
    expect(screen.getByText(/No site default has been set\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Retention and capacity" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("storage.view alone still reads out the site default and the factory values", async () => {
    await show(["storage.view"], { ...settings, raw_retention_days: 60 });
    expect(screen.getByText(/This site's default: raw 60 days/)).toBeInTheDocument();
    expect(screen.getByText(/Factory: raw 30 days/)).toBeInTheDocument();
  });

  it("storage.edit: the fields are enabled with Save, Set as default and both Resets, and a save and a default are sent", async () => {
    const calls = await show(["storage.view", "storage.edit"]);
    for (const [, label] of FIELDS) expect(screen.getByLabelText(label)).toBeEnabled();
    for (const name of ["Save", "Set as default", "Reset to default", "Reset to factory settings"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByText(READ_ONLY_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(/The two Resets only fill in the form/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/settings/storage")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/settings/storage/default")).toBe(true));
  });

  it("the Administrator role is unchanged: enabled fields, all four buttons, no read-only line", async () => {
    mockFetch({ ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settingsOut } });
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
    await accountKnown();
    expect(screen.getByLabelText(/raw retention/i)).toBeEnabled();
    for (const name of ["Save", "Set as default", "Reset to default", "Reset to factory settings"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByText(READ_ONLY_TEXT)).not.toBeInTheDocument();
  });

  it("while it loads, a role without storage.edit has the read-only line's words where the buttons will not be, and no button blocks", async () => {
    mockFetch({ ...base, "GET /api/me": { body: userFor("custom", { permissions: ["storage.view"] }) }, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settingsOut } });
    const hold = holdFetch((_method, path) => path === "/api/storage");
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await accountKnown();
    const retention = screen.getByText("Loading storage").parentElement!.querySelector(".retention-card")!;
    expect(retention.querySelectorAll(".retention-foot .row > .sk-block")).toHaveLength(0);
    const paragraphs = retention.querySelectorAll("p.sk-words.muted");
    expect(paragraphs).toHaveLength(4); // the free-disk note, the readings note, the read-only line and the summary
    expect(paragraphs[2].querySelectorAll(".sk-line")).toHaveLength(READ_ONLY_TEXT.split(/\s+/).length);
    hold.release();
    expect(await screen.findByText(READ_ONLY_TEXT)).toBeInTheDocument();
  });
});

describe("StoragePage Save button (W7k)", () => {
  const put = (calls: { method: string }[]) => calls.filter((c) => c.method === "PUT");
  const ok = { "PUT /api/settings/storage": (req: { body: unknown }) => ({ body: { ...settings, ...(req.body as object) } }) };
  // by class: a dialog on top hides the page from the role queries, and its own buttons start with "Save" too
  const saveButton = () => document.querySelector<HTMLButtonElement>("form.retention-form button.save-btn")!;
  const savedAt = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveButton()).toHaveAttribute("data-phase", "saved"));
  };

  it("turns green after the save and shows no loose note", async () => {
    mockFetch(routes(ok));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await savedAt();
    expect(saveButton()).toHaveAccessibleName("Saved");
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    expect(document.querySelector(".retention-foot [role='status']")).toBeNull();
  });

  it("typing in a field during the green drops it at once", async () => {
    mockFetch(routes(ok));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await savedAt();
    await userEvent.type(screen.getByLabelText(/raw retention/i), "0");
    expect(saveButton()).toHaveAttribute("data-phase", "idle");
    expect(saveButton()).toHaveAccessibleName("Save");
  });

  it("a Reset button during the green drops it at once", async () => {
    mockFetch(routes(ok));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await savedAt();
    await userEvent.click(screen.getByRole("button", { name: "Reset to factory settings" }));
    expect(saveButton()).toHaveAttribute("data-phase", "idle");
  });

  it("the confirmed save (the readings-deleting 409) turns the button green only after the real save", async () => {
    const urls: string[] = [];
    const calls = mockFetch(routes({
      "PUT /api/settings/storage": (req: { url: string; body: unknown }) => {
        urls.push(req.url);
        return req.url.includes("confirm=true")
          ? { body: { ...settings, ...(req.body as object) } }
          : { status: 409, body: { detail: "Saving these settings deletes stored readings now: 5 chunks of raw readings. Repeat the request with confirm=true to go ahead.", deletes_now: true, shorter: false } };
      },
    }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(saveButton()).toHaveAttribute("data-phase", "idle"); // the refusal is not a save
    expect(put(calls)).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: /save and delete/i }));
    await waitFor(() => expect(saveButton()).toHaveAttribute("data-phase", "saved"));
    expect(urls).toHaveLength(2);
  });

  it("typing while the save is running does not detach it: the 409 confirmation still opens", async () => {
    mockFetch(routes({
      "PUT /api/settings/storage": { status: 409, body: { detail: "Saving these settings deletes stored readings now: 5 chunks of raw readings. Repeat the request with confirm=true to go ahead.", deletes_now: true, shorter: false } },
    }));
    const hold = holdFetch((method, path) => method === "PUT" && path === "/api/settings/storage");
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveButton()).toHaveAttribute("data-phase", "saving"));
    await userEvent.type(screen.getByLabelText(/warn at/i), "1");
    expect(saveButton()).toBeDisabled(); // still saving: the double-click guard holds
    hold.release();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("StoragePage message slot (W7l)", () => {
  // The error and the note Set as default leaves used to be extra lines in the foot, growing both cards. They now go into a slot that is always
  // there, above the buttons; its height is the stylesheet's (layout-shift.css.test.ts). Here: where it is, what is inside, what it reserves for.
  const NOTE = "This site's default is updated. It is not in use yet: press Save to use these values.";
  const slot = () => document.querySelector<HTMLElement>(".retention-foot > .retention-status")!;

  it("is an empty slot above the buttons until there is something to say, and reserves room for the Set as default note", async () => {
    mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
    expect(slot()).toBeEmptyDOMElement();
    expect(slot().getAttribute("data-reserve")).toBe(NOTE);
    expect(slot().nextElementSibling).toHaveClass("row"); // directly above the buttons
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument(); // the reserved copy is an attribute (drawn by the stylesheet), not text in the page
  });

  it("holds the note Set as default leaves, as a status, once", async () => {
    mockFetch(routes({ "PUT /api/settings/storage/default": (req: { body: unknown }) => ({ body: req.body as object }) }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await screen.findByLabelText(/raw retention/i);
    await userEvent.click(screen.getByRole("button", { name: /set as default/i }));
    const note = await screen.findByText(NOTE);
    expect(note).toHaveAttribute("role", "status");
    expect(slot()).toContainElement(note);
  });

  it("holds the error of a refused value, as an alert, and the note gives way to it", async () => {
    mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "3");
    await userEvent.click(screen.getByRole("button", { name: /set as default/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/at least 8 days/i);
    expect(slot()).toContainElement(alert);
    expect(slot().children).toHaveLength(1);
  });

  it("has no slot for a role that cannot change the settings (nothing can be refused or set there), and the loading page draws it where there are buttons", async () => {
    mockFetch({ ...base, "GET /api/me": { body: userFor("custom", { permissions: ["storage.view"] }) }, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settingsOut } });
    const hold = holdFetch((_method, path) => path === "/api/storage");
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await accountKnown();
    expect(document.querySelector(".retention-status")).toBeNull(); // the skeleton of a role without storage.edit
    hold.release();
    await screen.findByText(READ_ONLY_TEXT);
    expect(document.querySelector(".retention-status")).toBeNull();
  });

  it("the loading page draws the slot above the button blocks, empty, so Save does not move when the data arrives", async () => {
    mockFetch(routes());
    const hold = holdFetch((_method, path) => path === "/api/storage");
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await accountKnown();
    const skeletonSlot = document.querySelector<HTMLElement>(".sk-region .retention-foot > .retention-status")!;
    expect(skeletonSlot).toBeEmptyDOMElement();
    expect(skeletonSlot.getAttribute("data-reserve")).toBe(NOTE);
    expect(skeletonSlot.nextElementSibling).toHaveClass("row");
    hold.release();
    await screen.findByLabelText(/raw retention/i);
  });
});

describe("StoragePage System events card (w32)", () => {
  const TITLE = "System events and the audit log";
  const SENTENCE = "System events are kept 90 days or the newest 100,000, whichever is fewer. Kept now: 3,412, the oldest from 24 Jul.";
  const card = () => screen.getByRole("heading", { name: TITLE }).closest(".page-card") as HTMLElement;
  const eventsPuts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "PUT" && c.path === "/api/settings/events");
  /** The page up with its account known; `extra` replaces routes, `permissions` makes the account a custom role. */
  const show = async (extra: object = {}, permissions?: PermissionId[]) => {
    const calls = mockFetch(routes({ ...(permissions ? { "GET /api/me": { body: userFor("custom", { permissions }) } } : {}), ...extra }));
    renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
    await screen.findByRole("heading", { name: TITLE });
    await accountKnown();
    return calls;
  };
  /** A server that keeps what was saved, and records the address of every PUT (the confirm=true is in the query). */
  const keeping = (urls: string[], refuse?: (body: { retention_days: number; max_rows: number }, url: string) => { status: number; body: object } | null) => {
    let stored = { ...eventsOut };
    return {
      "GET /api/settings/events": () => ({ body: stored }),
      "PUT /api/settings/events": (req: { url: string; body: unknown }) => {
        urls.push(req.url);
        const body = req.body as { retention_days: number; max_rows: number };
        const refused = refuse?.(body, req.url);
        if (refused) return refused;
        stored = { ...stored, ...body };
        return { body: stored };
      },
    };
  };
  const dialog = () => screen.getByRole("dialog", { name: "Change how long system events are kept" });
  const days = () => within(dialog()).getByLabelText("Keep events for (days)");
  const rows = () => within(dialog()).getByLabelText("Keep at most (events)");
  const openDialog = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Change..." }));
    return dialog();
  };
  const fill = async (input: HTMLElement, value: string) => {
    await userEvent.clear(input);
    await userEvent.type(input, value);
  };

  it("says how long system events are kept and how many are kept now, then that the audit log is kept forever", async () => {
    await show();
    expect(card().querySelector(":scope > p")).toHaveTextContent(SENTENCE);
    expect(within(card()).getByText(SENTENCE)).toBeInTheDocument();
    expect(within(card()).getByText("The audit log is kept forever.")).toBeInTheDocument();
    expect([...card().children].map((child) => child.tagName + "." + child.className.split(" ")[0])).toEqual(["DIV.page-card-head", "P.", "P.muted", "DIV.row"]);
  });

  it("names the day of the oldest event in the site's time zone, not the browser's or UTC", async () => {
    // 22:30 UTC on the 23rd is 02:30 on the 24th in Dubai (UTC+4)
    await show({ "GET /api/settings/events": { body: { ...eventsOut, oldest: "2026-07-23T22:30:00Z" } }, "GET /api/site": { body: { timezone: "Asia/Dubai", currency: null } } });
    expect(within(card()).getByText(/the oldest from 24 Jul\.$/)).toBeInTheDocument();
  });

  it("groups the digits and leaves the oldest out when nothing is kept", async () => {
    await show({ "GET /api/settings/events": { body: { ...eventsOut, max_rows: 1_000_000, retention_days: 400, kept: 0, oldest: null } } });
    expect(within(card()).getByText("System events are kept 400 days or the newest 1,000,000, whichever is fewer. Kept now: 0.")).toBeInTheDocument();
    expect(card().textContent).not.toMatch(/oldest/);
  });

  describe("dayMonth", () => {
    it("is the day and the English short month in the zone given, UTC when the zone is unknown, null for a time that is not one", () => {
      expect(dayMonth("2026-07-24T08:15:00Z", "UTC")).toBe("24 Jul");
      expect(dayMonth("2026-09-03T23:30:00Z", "Asia/Dubai")).toBe("4 Sep");
      expect(dayMonth("2026-09-03T23:30:00Z", "Not/AZone")).toBe("3 Sep");
      expect(dayMonth("yesterday", "UTC")).toBeNull();
    });
  });

  it("has Change... only for a role with storage.edit", async () => {
    await show({}, ["storage.view"]);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change..." })).not.toBeInTheDocument();
    expect(card().querySelectorAll(".row")).toHaveLength(0);
  });

  it("opens a small dialog with the two values, their bounds, and a ? tip beside each, and puts the focus on the first field", async () => {
    await show({}, ["storage.view", "storage.edit"]);
    await openDialog();
    await waitFor(() => expect(days()).toHaveFocus());
    expect(days()).toHaveValue(90);
    expect(days()).toHaveAttribute("min", "7");
    expect(days()).toHaveAttribute("max", "400");
    expect(rows()).toHaveValue(100000);
    expect(rows()).toHaveAttribute("min", "10000");
    expect(rows()).toHaveAttribute("max", "1000000");
    expect(within(dialog()).getByText(/From 7 to 400 days/)).toBeInTheDocument();
    expect(within(dialog()).getByText(/From 10,000 to 1,000,000 events/)).toBeInTheDocument();
    for (const field of [days(), rows()]) {
      const wrapper = field.closest(".has-tip") as HTMLElement;
      const tip = within(wrapper).getByRole("button", { name: "What does this mean?" });
      expect(tip.closest("label"), "the tip is beside the label, never inside it").toBeNull();
    }
    expect(within(dialog()).getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toHaveAttribute("type", "button");
  });

  it("Escape closes the dialog and the focus goes back to Change...; so does Cancel; nothing is sent", async () => {
    const calls = await show({}, ["storage.view", "storage.edit"]);
    await openDialog();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change..." })).toHaveFocus();
    await openDialog();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change..." })).toHaveFocus();
    expect(eventsPuts(calls)).toHaveLength(0);
  });

  it("Escape on an open ? tip closes the tip only; the next Escape closes the dialog", async () => {
    await show({}, ["storage.view", "storage.edit"]);
    await openDialog();
    await userEvent.click(within(days().closest(".has-tip") as HTMLElement).getByRole("button", { name: "What does this mean?" }));
    expect(screen.getByRole("note")).toHaveTextContent(/older than this many days are deleted/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Save sends exactly the two values (no confirm), closes the dialog and the card shows the new retention", async () => {
    const urls: string[] = [];
    const calls = await show(keeping(urls), ["storage.view", "storage.edit"]);
    await openDialog();
    await fill(days(), "30");
    await fill(rows(), "50000");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(eventsPuts(calls)).toHaveLength(1);
    expect(eventsPuts(calls)[0].body).toEqual({ retention_days: 30, max_rows: 50000 });
    expect(urls[0]).toMatch(/\/api\/settings\/events$/);
    expect(await screen.findByText(/System events are kept 30 days or the newest 50,000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change..." })).toHaveFocus();
  });

  it("refuses a value outside its bounds or not a whole number before asking the server, in words, and keeps the dialog open", async () => {
    const calls = await show({}, ["storage.view", "storage.edit"]);
    await openDialog();
    await fill(days(), "5");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Days must be a whole number from 7 to 400.");
    await fill(days(), "30");
    await fill(rows(), "9999");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Events must be a whole number from 10,000 to 1,000,000.");
    await fill(rows(), "12000.5");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Events must be a whole number");
    await userEvent.clear(rows());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Events must be a whole number");
    expect(eventsPuts(calls)).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a 409 says how many events will be deleted within the hour and asks to confirm; Confirm and save repeats the request with confirm=true", async () => {
    const urls: string[] = [];
    const calls = await show(keeping(urls, (_body, url) => (url.includes("confirm=true") ? null : {
      status: 409, body: { detail: "About 1,204 events will be deleted within the hour. Repeat the request with confirm=true to go ahead.", will_delete: 1204 },
    })), ["storage.view", "storage.edit"]);
    await openDialog();
    await fill(days(), "30");
    const save = within(dialog()).getByRole("button", { name: "Save" });
    await userEvent.click(save);
    const ask = await within(dialog()).findByRole("alert");
    expect(ask).toHaveTextContent("About 1,204 events will be deleted within the hour.");
    expect(ask).not.toHaveTextContent(/confirm=true/); // the server's own sentence is for scripts; the dialog says it in its words
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(eventsPuts(calls)).toHaveLength(1);
    expect(urls[0]).not.toContain("confirm");
    const confirm = within(dialog()).getByRole("button", { name: "Confirm and save" });
    expect(confirm).toBe(save); // the same button, so the focus it holds stays on it
    expect(confirm).toHaveFocus();
    await userEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(eventsPuts(calls)).toHaveLength(2);
    expect(urls[1]).toMatch(/\/api\/settings\/events\?confirm=true$/);
    expect(eventsPuts(calls)[1].body).toEqual({ retention_days: 30, max_rows: 100000 });
    expect(await screen.findByText(/System events are kept 30 days/)).toBeInTheDocument();
  });

  it("says one event in the singular", async () => {
    await show(keeping([], () => ({ status: 409, body: { detail: "x", will_delete: 1 } })), ["storage.view", "storage.edit"]);
    await openDialog();
    await fill(days(), "30");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("About 1 event will be deleted within the hour.");
  });

  it("changing a value after the 409 takes the question back: the button reads Save again and the next request has no confirm", async () => {
    const urls: string[] = [];
    const calls = await show(keeping(urls, (body, url) => (body.retention_days === 30 && !url.includes("confirm=true") ? {
      status: 409, body: { detail: "x", will_delete: 40 },
    } : null)), ["storage.view", "storage.edit"]);
    await openDialog();
    await fill(days(), "30");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await within(dialog()).findByRole("button", { name: "Confirm and save" });
    await fill(days(), "60");
    expect(within(dialog()).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(urls.map((url) => url.includes("confirm"))).toEqual([false, false]);
    expect(eventsPuts(calls)[1].body).toEqual({ retention_days: 60, max_rows: 100000 });
  });

  it("a refusal of the server stays in the dialog as an alert and sends nothing more; Cancel still closes it", async () => {
    const calls = await show(keeping([], () => ({ status: 500, body: { detail: "the database is busy" } })), ["storage.view", "storage.edit"]);
    await openDialog();
    await fill(days(), "30");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("the database is busy");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Save" })).toHaveFocus();
    expect(eventsPuts(calls)).toHaveLength(1);
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("while the request runs the buttons wait with aria-disabled (the focus stays), a second click sends nothing, and Escape does not close", async () => {
    const urls: string[] = [];
    const calls = await show(keeping(urls), ["storage.view", "storage.edit"]);
    const hold = holdFetch((method, path) => method === "PUT" && path === "/api/settings/events");
    await openDialog();
    await fill(days(), "30");
    const save = within(dialog()).getByRole("button", { name: "Save" });
    await userEvent.click(save);
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
    expect(save).toBeEnabled();
    expect(save).toHaveFocus();
    await userEvent.click(save);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    hold.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(eventsPuts(calls)).toHaveLength(1);
  });

  it("keeps the room for the question: the dialog's message slot is always there, empty until there is something to say", async () => {
    await show({}, ["storage.view", "storage.edit"]);
    await openDialog();
    const slot = dialog().querySelector(".storage-events-slot")!;
    expect(slot).toBeEmptyDOMElement();
    expect(slot.nextElementSibling).toHaveClass("row"); // directly above the buttons
  });

  describe("while it loads", () => {
    it("draws the card with the page's other cards, as word pills of the sentence, the audit line and the button, and nothing a screen reader can find", async () => {
      mockFetch(routes());
      const hold = holdFetch((_method, path) => path === "/api/settings/events");
      renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
      await accountKnown();
      const region = screen.getByText("Loading storage").parentElement!;
      const events = region.querySelector(".page-grid > .page-card.storage-events.span-all")!;
      expect(events).toHaveAttribute("aria-hidden", "true");
      expect(events.querySelector(":scope > .page-card-head > .sk-block")).not.toBeNull();
      expect(events.querySelector(":scope > .page-card-head h2 .sk-line")).not.toBeNull();
      expect([...events.children].map((child) => child.tagName + "." + child.className.split(" ")[0])).toEqual(["DIV.page-card-head", "P.sk-words", "P.sk-words", "DIV.row"]);
      expect(events.children[1].querySelectorAll(".sk-line")).toHaveLength(SENTENCE.split(/\s+/).length);
      expect(events.children[2]).toHaveClass("muted");
      expect(events.children[2].querySelectorAll(".sk-line")).toHaveLength("The audit log is kept forever.".split(/\s+/).length);
      expect((events.querySelector(".row > .sk-block") as HTMLElement).style.height).toBe("34px");
      expect(region.textContent, "a region holds no words but its label").toBe("Loading storage");
      expect(screen.queryByRole("heading", { name: TITLE })).not.toBeInTheDocument();
      hold.release();
      expect(await screen.findByRole("heading", { name: TITLE })).toBeInTheDocument();
      expect(document.querySelector(".sk-region")).toBeNull();
    });

    it("draws no button block for a role that cannot change it", async () => {
      mockFetch(routes({ "GET /api/me": { body: userFor("custom", { permissions: ["storage.view"] }) } }));
      const hold = holdFetch((_method, path) => path === "/api/settings/events");
      renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
      await accountKnown();
      const events = document.querySelector(".sk-region .storage-events")!;
      expect([...events.children].map((child) => child.tagName)).toEqual(["DIV", "P", "P"]);
      hold.release();
      await screen.findByRole("heading", { name: TITLE });
      expect([...card().children].map((child) => child.tagName)).toEqual(["DIV", "P", "P"]);
    });

    it("waits for the site's time zone too, so the day it names is never drawn in the wrong zone first", async () => {
      mockFetch(routes());
      const hold = holdFetch((_method, path) => path === "/api/site");
      renderWithProviders(<><StoragePage /><SignedIn /></>, { route: "/storage", path: "/storage" });
      await accountKnown();
      expect(screen.getByText("Loading storage")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: TITLE })).not.toBeInTheDocument();
      hold.release();
      expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    });
  });

  it("a failing read of the retention does not take the page down: the card says so in an alert, with no Change... button", async () => {
    await show({ "GET /api/settings/events": { status: 500, body: { detail: "events are down" } } });
    expect(screen.getByLabelText(/raw retention/i)).toBeInTheDocument();
    expect(within(card()).getByRole("alert")).toHaveTextContent("How long system events are kept could not be read: events are down");
    expect(screen.queryByRole("button", { name: "Change..." })).not.toBeInTheDocument();
    expect(within(card()).getByText("The audit log is kept forever.")).toBeInTheDocument();
  });
});
