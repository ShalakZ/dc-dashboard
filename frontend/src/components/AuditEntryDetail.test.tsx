import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { AuditEntry } from "../api/types";
import { AuditEntryDetail } from "./AuditEntryDetail";

const entry = (action: string, detail: unknown, refs?: AuditEntry["refs"]): AuditEntry => ({
  id: 9, user_id: 1, actor_id: 1, username: "admin", action, detail: detail as Record<string, unknown>, ts: "2026-10-11T08:00:00Z", refs,
});
const show = (e: AuditEntry, view: "friendly" | "raw" = "friendly") =>
  render(<MemoryRouter><AuditEntryDetail entry={e} view={view} /></MemoryRouter>);

describe("AuditEntryDetail", () => {
  it("shows the sentence and a Field / Before / After table for an entry with before and after", () => {
    show(entry("tariff.updated", { tariff_id: 3, asset_id: 7, before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } }, { asset: { "7": "Panel A" } }));
    expect(screen.getByText("Changed the tariff for asset Panel A: rate per kwh")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Field", "Before", "After"]);
    const row = within(table).getByRole("row", { name: /Rate per kwh/ });
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Rate per kwh", "0.1", "0.12"]);
    expect(screen.getByRole("link", { name: "Open Tariffs" })).toHaveAttribute("href", "/tariffs");
    expect(screen.queryByText("Tariff id")).not.toBeInTheDocument(); // no list of stored fields: the ids stay in the raw view
  });

  it("lists two changed fields that read the same once humanised, with no repeated-key warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    show(entry("foo.bar", { before: { a_b: 1, "a.b": 2 }, after: { a_b: 3, "a.b": 4 } }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => Array.from(row.querySelectorAll("td")).map((c) => c.textContent))).toEqual([
      ["A b", "1", "3"],
      ["A b", "2", "4"],
    ]);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("same key");
    warn.mockRestore();
  });

  it("counts the unchanged values instead of listing them", () => {
    show(entry("storage.changed", {
      before: { raw_retention_days: 30, compress_after_days: 7 }, after: { raw_retention_days: 60, compress_after_days: 7 },
    }));
    expect(screen.getByText("1 unchanged value not shown")).toBeInTheDocument();
    show(entry("storage.changed", {
      before: { a: 1, b: 2, c: 3 }, after: { a: 1, b: 2, c: 4 },
    }));
    expect(screen.getByText("2 unchanged values not shown")).toBeInTheDocument();
  });

  it("draws a sentence and no table or field list for an old entry that has no before and after", () => {
    show(entry("tariff.updated", { tariff_id: 3, rate_per_kwh: 0.12 }));
    expect(screen.getByText("Changed a tariff")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Rate per kwh")).not.toBeInTheDocument();
    expect(screen.queryByText("0.12")).not.toBeInTheDocument();
  });

  it("does not throw for an action it does not know, nested values, null and arrays", () => {
    show(entry("foo.bar_baz", { nested: { a: [1, 2] }, nothing: null, list: ["x"], flag: true }));
    expect(screen.getByText("Foo bar baz")).toBeInTheDocument();
    expect(screen.queryByText('{"a":[1,2]}')).not.toBeInTheDocument(); // the stored fields are not listed
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders stored text as text, never as markup", () => {
    show(entry("asset.deleted", { asset_id: 4, name: '<img src=x onerror="alert(1)">' }));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/Deleted asset <img src=x/)).toBeInTheDocument();
  });

  it("links to the thing the entry is about", () => {
    show(entry("asset.updated", { asset_id: 12, name: "Panel A", before: { name: "P" }, after: { name: "Panel A" } }));
    expect(screen.getByRole("link", { name: "Open asset Panel A" })).toHaveAttribute("href", "/assets/12");
  });

  it("in the raw view shows the action as text and the stored JSON in code", () => {
    show(entry("tariff.updated", { tariff_id: 3, after: { rate_per_kwh: 0.12 } }), "raw");
    expect(screen.getByText("tariff.updated")).toBeInTheDocument();
    const code = screen.getByText('{"tariff_id":3,"after":{"rate_per_kwh":0.12}}');
    expect(code.tagName).toBe("CODE");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
