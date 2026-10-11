import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { AuditEntry } from "../api/types";
import { AuditEntryDetail } from "./AuditEntryDetail";

const entry = (action: string, detail: unknown): AuditEntry => ({
  id: 9, user_id: 1, actor_id: 1, username: "admin", action, detail: detail as Record<string, unknown>, ts: "2026-10-11T08:00:00Z",
});
const show = (e: AuditEntry, view: "friendly" | "raw" = "friendly") =>
  render(<MemoryRouter><AuditEntryDetail entry={e} view={view} /></MemoryRouter>);

describe("AuditEntryDetail", () => {
  it("shows the sentence and a Field / Before / After table for an entry with before and after", () => {
    show(entry("tariff.updated", { tariff_id: 3, asset_id: 7, before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } }));
    expect(screen.getByText("Changed tariff #3: rate per kwh")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Field", "Before", "After"]);
    const row = within(table).getByRole("row", { name: /Rate per kwh/ });
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Rate per kwh", "0.1", "0.12"]);
    expect(screen.getByRole("link", { name: "Open Tariffs" })).toHaveAttribute("href", "/tariffs");
    expect(screen.getByText("Tariff id")).toBeInTheDocument(); // the subject fields
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

  it("lists the stored fields of an old entry that has no before and after, and draws no table", () => {
    show(entry("tariff.updated", { tariff_id: 3, rate_per_kwh: 0.12 }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Rate per kwh")).toBeInTheDocument();
    expect(screen.getByText("0.12")).toBeInTheDocument();
  });

  it("does not throw for an action it does not know, nested values, null and arrays", () => {
    show(entry("foo.bar_baz", { nested: { a: [1, 2] }, nothing: null, list: ["x"], flag: true }));
    expect(screen.getByText("Foo bar baz")).toBeInTheDocument();
    expect(screen.getByText('{"a":[1,2]}')).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
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
