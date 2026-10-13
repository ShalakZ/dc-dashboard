import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { AuditOptions } from "../api/types";
import { NO_FILTERS, type AuditFilters } from "../lib/auditFilters";
import { AuditFilterBar } from "./AuditFilterBar";

const OPTIONS: AuditOptions = {
  actions: ["asset.created", "asset.deleted", "scan.finished"],
  users: [{ id: 1, name: "admin" }, { id: 2, name: "ops" }],
  unattributed: true,
};
const TODAY = "2026-10-07";

type Extra = { exporting?: boolean; jumping?: boolean; error?: string | null; notice?: string | null; options?: AuditOptions | undefined };

function setup(initial: AuditFilters = NO_FILTERS, extra: Extra = {}) {
  const onChange = vi.fn();
  const onJump = vi.fn();
  const onExport = vi.fn();
  function Harness() {
    const [filters, setFilters] = useState(initial);
    return (
      <AuditFilterBar
        filters={filters}
        onChange={(next) => { onChange(next); setFilters(next); }}
        today={TODAY}
        options={"options" in extra ? extra.options : OPTIONS}
        onJump={onJump}
        jumping={extra.jumping ?? false}
        onExport={onExport}
        exporting={extra.exporting ?? false}
        error={extra.error ?? null}
        notice={extra.notice ?? null}
      />
    );
  }
  render(<Harness />);
  return { onChange, onJump, onExport };
}
const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall![0] as AuditFilters;
const quick = (name: string) => screen.getByRole("button", { name });

afterEach(() => { vi.useRealTimers(); });

describe("AuditFilterBar layout (W7j)", () => {
  it("is the one search landmark and keeps every labelled control", () => {
    setup();
    const bar = screen.getByRole("search", { name: "Filter the audit log" });
    for (const name of ["Search", "User", "Action", "From", "To", "Go to date"]) expect(within(bar).getByLabelText(name)).toBeInTheDocument();
    for (const name of ["Today", "Last 7 days", "Deletions", "Sign-in problems", "Go", "Export CSV"]) expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
  });

  it("reads Search, User, Action, From, To in the order it is laid out (Tab follows the eye)", () => {
    setup();
    const bar = screen.getByRole("search", { name: "Filter the audit log" });
    const order = Array.from(bar.querySelectorAll<HTMLElement>("input, select, button")).map((el) => el.id ? bar.querySelector(`label[for="${el.id}"]`)?.textContent ?? el.textContent : el.textContent);
    expect(order.slice(0, 5)).toEqual(["Search", "User", "Action", "From", "To"]);
    expect(order.slice(5)).toEqual(["Today", "Last 7 days", "Deletions", "Sign-in problems", "Go to date", "Go", "Export CSV"]);
  });

  it("groups From and To in one control with a 'to' between, and keeps their labels", () => {
    setup();
    const group = screen.getByLabelText("From").closest(".range-group")!;
    expect(group).toContainElement(screen.getByLabelText("To"));
    const sep = group.querySelector(".range-sep")!;
    expect(sep).toHaveTextContent("to");
    expect(sep).toHaveAttribute("aria-hidden", "true");
    expect(group).not.toContainElement(screen.getByLabelText("Go to date"));
  });

  it("gives each quick filter an icon (hidden from screen readers) that does not change its name", () => {
    setup();
    for (const name of ["Today", "Last 7 days", "Deletions", "Sign-in problems"]) {
      const chip = quick(name);
      expect(chip).toHaveClass("filter-chip");
      expect(chip).not.toHaveClass("chip"); // .chip is the 22px status chip of other pages
      expect(chip.querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("keeps Clear filters a quiet button and gives Export CSV a download icon", async () => {
    setup();
    expect(quick("Export CSV").querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(quick("Deletions"));
    expect(quick("Clear filters")).toHaveClass("quiet");
    expect(quick("Clear filters").querySelector("svg")).toBeNull();
  });
});

describe("AuditFilterBar selects and dates", () => {
  it("lists the users with All users first and (no user) only when such entries exist, and picks by id", async () => {
    const { onChange } = setup();
    const user = screen.getByRole("combobox", { name: "User" });
    expect(Array.from(user.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["All users", "(no user)", "admin", "ops"]);
    await userEvent.selectOptions(user, "ops");
    expect(last(onChange)).toEqual({ ...NO_FILTERS, user: "2" });
    await userEvent.selectOptions(user, "(no user)");
    expect(last(onChange).user).toBe("none");
    await userEvent.selectOptions(user, "All users");
    expect(last(onChange).user).toBe("");
  });

  it("leaves out (no user) when nothing is unattributed, and still renders before the options arrive", () => {
    setup(NO_FILTERS, { options: { ...OPTIONS, unattributed: false } });
    expect(screen.queryByRole("option", { name: "(no user)" })).not.toBeInTheDocument();
  });

  it("renders All users and All actions while the options are still loading", () => {
    setup(NO_FILTERS, { options: undefined });
    expect(screen.getByRole("option", { name: "All users" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All actions" })).toBeInTheDocument();
  });

  it("chooses one exact action, or all", async () => {
    const { onChange } = setup();
    const action = screen.getByRole("combobox", { name: "Action" });
    expect(Array.from(action.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["All actions", ...OPTIONS.actions]);
    await userEvent.selectOptions(action, "asset.deleted");
    expect(last(onChange).actions).toEqual(["asset.deleted"]);
    await userEvent.selectOptions(action, "All actions");
    expect(last(onChange).actions).toEqual([]);
  });

  it("changes From and To", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    expect(last(onChange)).toEqual({ ...NO_FILTERS, from: "2026-10-01" });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-05" } });
    expect(last(onChange)).toEqual({ ...NO_FILTERS, from: "2026-10-01", to: "2026-10-05" });
  });

  it("bounds the date boxes to 1970..2100 and keeps From and To in order", () => {
    setup();
    expect(screen.getByLabelText("From")).toHaveAttribute("min", "1970-01-01");
    expect(screen.getByLabelText("From")).toHaveAttribute("max", "2100-12-31");
    expect(screen.getByLabelText("To")).toHaveAttribute("min", "1970-01-01");
    expect(screen.getByLabelText("To")).toHaveAttribute("max", "2100-12-31");
    expect(screen.getByLabelText("Go to date")).toHaveAttribute("min", "1970-01-01");
    expect(screen.getByLabelText("Go to date")).toHaveAttribute("max", "2100-12-31");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-05" } });
    expect(screen.getByLabelText("From")).toHaveAttribute("max", "2026-10-05"); // From cannot pass To
    expect(screen.getByLabelText("To")).toHaveAttribute("min", "2026-10-01"); // To cannot precede From
  });

  it("shows an action from the address that the list does not hold, so the select is never blank", () => {
    setup({ ...NO_FILTERS, actions: ["old.action"] });
    expect(screen.getByRole("combobox", { name: "Action" })).toHaveValue("old.action");
  });
});

describe("AuditFilterBar quick filters", () => {
  it("toggles Deletions on and off, and the Action select names the quick filter while it holds", async () => {
    const { onChange } = setup();
    const deletions = quick("Deletions");
    expect(deletions).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(deletions);
    expect(last(onChange).actions).toEqual(["*.deleted"]);
    expect(deletions).toHaveAttribute("aria-pressed", "true");
    const action = screen.getByRole("combobox", { name: "Action" });
    const named = screen.getByRole("option", { name: "Deletions (quick filter)" });
    expect(named).toBeDisabled();
    expect(action).toHaveValue(named.getAttribute("value"));
    await userEvent.click(deletions);
    expect(last(onChange).actions).toEqual([]);
    expect(deletions).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("option", { name: /quick filter/ })).not.toBeInTheDocument();
    expect(action).toHaveValue("");
  });

  it("Sign-in problems sets three actions and is named in the Action select", async () => {
    const { onChange } = setup();
    await userEvent.click(quick("Sign-in problems"));
    expect(last(onChange).actions).toEqual(["login.failed", "login.locked", "password.change_failed"]);
    expect(screen.getByRole("option", { name: "Sign-in problems (quick filter)" })).toBeDisabled();
  });

  it("choosing one action replaces a quick filter", async () => {
    const { onChange } = setup({ ...NO_FILTERS, actions: ["*.deleted"] });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action" }), "asset.created");
    expect(last(onChange).actions).toEqual(["asset.created"]);
    expect(quick("Deletions")).toHaveAttribute("aria-pressed", "false");
  });

  it("Today and Last 7 days set the dates in the site zone's day and toggle off", async () => {
    const { onChange } = setup();
    await userEvent.click(quick("Today"));
    expect(last(onChange)).toMatchObject({ from: TODAY, to: TODAY });
    expect(quick("Today")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(quick("Last 7 days"));
    expect(last(onChange)).toMatchObject({ from: "2026-10-01", to: TODAY });
    expect(quick("Today")).toHaveAttribute("aria-pressed", "false");
    expect(quick("Last 7 days")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(quick("Last 7 days"));
    expect(last(onChange)).toMatchObject({ from: "", to: "" });
  });

  it("a quick filter keeps the other filters", async () => {
    const { onChange } = setup({ ...NO_FILTERS, user: "2" });
    await userEvent.click(quick("Deletions"));
    expect(last(onChange)).toEqual({ ...NO_FILTERS, user: "2", actions: ["*.deleted"] });
  });
});

describe("AuditFilterBar without an export", () => {
  it("draws no Export CSV button when it is given no onExport", () => {
    render(
      <AuditFilterBar filters={NO_FILTERS} onChange={vi.fn()} today={TODAY} options={OPTIONS} onJump={vi.fn()} jumping={false}
        exporting={false} error={null} notice={null} />,
    );
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });
});

describe("AuditFilterBar Clear filters, Go to date, Export CSV and messages", () => {
  it("shows Clear filters only when something is filtered, and clears everything including the search box", async () => {
    const { onChange } = setup();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    await userEvent.click(quick("Deletions"));
    await userEvent.type(screen.getByLabelText("Search"), "abc{Enter}");
    expect(last(onChange).q).toBe("abc");
    await userEvent.click(quick("Clear filters"));
    expect(last(onChange)).toEqual(NO_FILTERS);
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("Go calls onJump with the chosen day, and waits for a day", async () => {
    const { onJump } = setup();
    expect(quick("Go")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Go to date"), { target: { value: "2026-10-05" } });
    await userEvent.click(quick("Go"));
    expect(onJump).toHaveBeenCalledWith("2026-10-05");
  });

  it("Go is disabled while a jump is under way", () => {
    setup(NO_FILTERS, { jumping: true });
    fireEvent.change(screen.getByLabelText("Go to date"), { target: { value: "2026-10-05" } });
    expect(quick("Go")).toBeDisabled();
  });

  it("Export CSV calls onExport, and is disabled while exporting", async () => {
    const { onExport } = setup();
    await userEvent.click(quick("Export CSV"));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("disables Export CSV while exporting", () => {
    setup(NO_FILTERS, { exporting: true });
    expect(quick("Export CSV")).toBeDisabled();
  });

  it("shows an error as an alert and a notice as plain status text", () => {
    setup(NO_FILTERS, { error: "1234 entries match; narrow the date range", notice: "No entries on 2026-10-05; showing the nearest ones." });
    expect(screen.getByRole("alert")).toHaveTextContent("1234 entries match; narrow the date range");
    expect(screen.getByRole("status")).toHaveTextContent("No entries on 2026-10-05; showing the nearest ones.");
  });

  it("shows neither an alert nor a status when there is nothing to say", () => {
    setup();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("AuditFilterBar search box", () => {
  it("has a placeholder that says what is searched", () => {
    setup();
    expect(screen.getByLabelText("Search")).toHaveAttribute("placeholder", "Search action, user and details");
  });

  it("applies after a 400 ms pause, once", () => {
    vi.useFakeTimers();
    const { onChange } = setup();
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "a" } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(box, { target: { value: "ab" } });
    act(() => { vi.advanceTimersByTime(399); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(last(onChange)).toEqual({ ...NO_FILTERS, q: "ab" });
  });

  it("applies at once on Enter and does not apply again after the pause", () => {
    vi.useFakeTimers();
    const { onChange } = setup();
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "disk" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(last(onChange).q).toBe("disk");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a select changed during the pause is not reverted when the search applies", () => {
    vi.useFakeTimers(); // Testing Library's async wrapper hangs under vitest's fake timers, so no userEvent here
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "x" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Action" }), { target: { value: "asset.created" } });
    expect(last(onChange)).toEqual({ ...NO_FILTERS, actions: ["asset.created"] });
    act(() => { vi.advanceTimersByTime(400); });
    expect(last(onChange)).toEqual({ ...NO_FILTERS, actions: ["asset.created"], q: "x" });
  });

  it("does not apply a blank or unchanged search", () => {
    vi.useFakeTimers();
    const { onChange } = setup();
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "   " } });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the keystrokes typed while the address catches up, and takes a different address value", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const props = { today: TODAY, options: OPTIONS, onJump: vi.fn(), jumping: false, onExport: vi.fn(), exporting: false, error: null, notice: null, onChange };
    const view = render(<AuditFilterBar {...props} filters={NO_FILTERS} />);
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "ab" } });
    act(() => { vi.advanceTimersByTime(400); });
    expect(last(onChange).q).toBe("ab");
    fireEvent.change(box, { target: { value: "abc" } }); // typed on before the address changed
    view.rerender(<AuditFilterBar {...props} filters={{ ...NO_FILTERS, q: "ab" }} />); // the address now holds what the box wrote
    expect(box).toHaveValue("abc");
    act(() => { vi.advanceTimersByTime(400); });
    expect(last(onChange).q).toBe("abc");
    view.rerender(<AuditFilterBar {...props} filters={{ ...NO_FILTERS, q: "disk" }} />); // Back, or a link: a value the box did not write
    expect(box).toHaveValue("disk");
  });

  it("starts with the address value", () => {
    setup({ ...NO_FILTERS, q: "disk" });
    expect(screen.getByLabelText("Search")).toHaveValue("disk");
  });
});
