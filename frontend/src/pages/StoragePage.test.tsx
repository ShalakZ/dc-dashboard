import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { StoragePage } from "./StoragePage";

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "a", role: "admin" } },
};
const settings = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
const stats = {
  database_bytes: 5 * 1024 ** 3, readings_bytes_uncompressed: 4 * 1024 ** 3, readings_bytes_compressed: 1 * 1024 ** 3,
  readings_bytes_total: 2 * 1024 ** 3, rollup_1m_bytes: 1024 ** 2, rollup_1h_bytes: 1024 ** 2,
  rows_per_day: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, rows: 1000 * (i + 1) })),
  growth_bytes_per_day: 100 * 1024 ** 2, disk_capacity_bytes: 100 * 1024 ** 3, used_pct: 5, days_until_full: 972.8, warn: false, settings,
};

describe("StoragePage", () => {
  it("shows sizes, projection and rows per day", async () => {
    mockFetch({ ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settings } });
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
      "GET /api/settings/storage": { body: settings },
      "PUT /api/settings/storage": (req) => ({ body: { ...settings, ...(req.body as object) } }),
    });
    const put = () => calls.filter((c) => c.method === "PUT");
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "5");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/raw retention must be at least one day longer/i)).toBeInTheDocument();
    expect(put()).toHaveLength(0);
    await userEvent.clear(raw);
    await userEvent.type(raw, "45");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(put()).toHaveLength(1));
    expect((put()[0].body as { raw_retention_days: number }).raw_retention_days).toBe(45);
  });

  it("shows the warning when the threshold is crossed", async () => {
    mockFetch({
      ...base,
      "GET /api/storage": { body: { ...stats, used_pct: 91, warn: true } },
      "GET /api/settings/storage": { body: settings },
    });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/91/);
  });
});
