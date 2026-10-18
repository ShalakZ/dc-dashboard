import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EstimatedItem, GapsItem, LaterItem, MonthCheck, MonthCheckGroup, MonthCheckHead, ResetsItem, SilentItem, UnmeteredItem } from "../api/types";
import { itemLines, type MonthCheckStatus } from "../lib/monthCheck";
import { MonthCheckDrawer } from "./MonthCheckDrawer";

const ZONE = "Asia/Qatar"; // UTC+3 all year: 06:00Z reads 09:00
const LIMITS = { flat_hours: 24, short_minutes: 60, short_share: 0.01, max_tolerated_hours: 24, cap: 50 };
const none = <T,>(): MonthCheckGroup<T> => ({ total: 0, items: [] });
const group = <T,>(items: T[], total = items.length): MonthCheckGroup<T> => ({ total, items });
const times = <T,>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

function check(over: Partial<MonthCheck> = {}, groups: Partial<MonthCheck["groups"]> = {}): MonthCheck {
  return {
    month: "2026-09", timezone: ZONE, state: "finished", closed: false,
    from: "2026-08-31T21:00:00Z", to: "2026-09-30T21:00:00Z", month_end: "2026-09-30T21:00:00Z",
    hours: 720, meters: 217, meter_hours: 150480, things: 0, limits: LIMITS,
    groups: { silent: none(), gaps: none(), estimated: none(), resets: none(), started: none(), unpriced: none(), flat: none(), unmetered: none(), later: none(), ...groups },
    ...over,
  };
}
const head = (kind: "counter" | "power", i = 0, over: Partial<MonthCheckHead> = {}): MonthCheckHead => ({
  asset_id: 100 + i, path: `Hall 1 / Rack ${String(i + 1).padStart(2, "0")} / Feed A`, kind, point: "kWh total", source: "Hall PLC", interval_seconds: 900, ...over,
});
const estimated = (i: number): EstimatedItem => ({ ...head("power", i, { point: "kW", interval_seconds: 1800 }), hours_estimated: 720, hours_total: 720 });
const gap: GapsItem = {
  ...head("counter", 50), runs: 1, hours: 6, longest_hours: 6, longest_start: "2026-09-20T06:00:00Z", first_start: "2026-09-20T06:00:00Z", last_end: "2026-09-20T12:00:00Z",
  leading_hours: 0, previous_reading: null, short_hours: 0, short_minutes: 0,
};
const reset: ResetsItem = { ...head("counter", 60), resets: 1, dips: 0, falls: 0, events: [{ at: "2026-09-12T06:00:00Z", kind: "reset" }] };
const unmetered = (i: number, beside = false): UnmeteredItem => ({ asset_id: 900 + i, path: `Electrical / Panel ${i + 1}`, beside_measured: beside });
const later = (i: number): LaterItem => ({ asset_id: 800 + i, path: `Hall 2 / Rack ${i + 1} / Feed B`, kind: "counter", first_reading: "2026-10-01T05:00:00Z" });
const silent: SilentItem = { ...head("counter", 70), reason: "trailing", since: "2026-09-29T06:00:00Z", hours: 39, last_reading: "2026-09-29T03:00:00Z" };

/** The pilot-hall September: 8 estimated feeds, one gap of six hours, one reset, 20 assets nothing measures. */
const pilot = (): MonthCheck => check({ things: 10 }, {
  gaps: group([gap]), estimated: group(times(8, estimated)), resets: group([reset]), unmetered: group(times(20, (i) => unmetered(i))),
});

const ready = (data: MonthCheck): MonthCheckStatus => ({ status: "ready", data });
const show = (status: MonthCheckStatus, props: Partial<Parameters<typeof MonthCheckDrawer>[0]> = {}) =>
  render(<MonthCheckDrawer month="2026-09" timezone={ZONE} status={status} onClose={() => {}} {...props} />);
const dialog = () => screen.getByRole("dialog", { name: "Check September 2026" });
const headings = () => within(dialog()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const groupOf = (title: string) => within(dialog()).getByRole("heading", { level: 3, name: title }).parentElement!;

describe("MonthCheckDrawer", () => {
  describe("an answer", () => {
    it("is a wide dialog named for the month (not the button's words) that opens on the headline and what was looked at", () => {
      show(ready(pilot()));
      const d = dialog();
      expect(d).toHaveClass("drawer-wide");
      expect(screen.getByRole("heading", { level: 2, name: "Check September 2026" })).toBeInTheDocument();
      expect(within(d).getByText("10 things to check")).toHaveClass("month-check-headline");
      expect(within(d).getByText(/^Looked at 217 meters over 720 hours \(150,480 hours of readings\), from 2026-09-01 00:00 to 2026-10-01 00:00\./)).toBeInTheDocument();
      expect(d.querySelector(".month-check-headline")!.nextElementSibling).toHaveClass("month-check-looked"); // headline, then (no reason) what was looked at
    });

    it("draws one block per group that has findings, in the order of the lists, each titled with its true total, then the information block last", () => {
      show(ready(pilot()));
      expect(headings()).toEqual(["Gaps in the readings 1", "Estimated from power 8", "Counter went back or dipped 1", "Not counted"]);
      expect(within(dialog()).queryByRole("heading", { name: /Meters with no readings/ })).not.toBeInTheDocument(); // an empty group is not drawn
      expect(groupOf("Gaps in the readings 1")).toHaveTextContent("Hours in a row with no reading at all.");
      expect(groupOf("Estimated from power 8")).toHaveTextContent("An hour is marked estimated when the asset has no energy (kWh) counter");
    });

    it("lists a finding as the path in strong, a muted line of what it reads, and its sentences", () => {
      show(ready(pilot()));
      const item = groupOf("Gaps in the readings 1").querySelector("li")!;
      expect(within(item).getByText("Hall 1 / Rack 51 / Feed A").tagName).toBe("STRONG");
      expect(within(item).getByText("Reads kWh total (Hall PLC)")).toHaveClass("muted");
      expect(item).toHaveTextContent("1 gap: 6 hours without any reading. It starts 2026-09-20 09:00 and ends 2026-09-20 15:00.");
      expect(item).toHaveTextContent("The energy in a gap is not lost");
      // the same sentences the words module makes: the drawer adds none of its own
      for (const line of itemLines("gaps", gap, ZONE, LIMITS).lines) expect(item).toHaveTextContent(line);
      expect(within(groupOf("Counter went back or dipped 1")).getByText(/went back down 1 time \(2026-09-12 09:00\)/)).toBeInTheDocument();
    });

    it("leaves the reads line out when the caller may not see point names", () => {
      show(ready(check({ things: 1 }, { gaps: group([{ ...gap, point: null, source: null }]) })));
      const item = groupOf("Gaps in the readings 1").querySelector("li")!;
      expect(item.querySelector(".month-check-reads")).toBeNull();
      expect(item).not.toHaveTextContent("Reads");
    });

    it("says nothing was found without promising anything, and still draws the information block", () => {
      show(ready(check()));
      expect(within(dialog()).getByText("Nothing to check")).toBeInTheDocument();
      expect(within(dialog()).getByText(/^Looked at 217 meters/)).toBeInTheDocument();
      expect(headings()).toEqual(["Not counted"]);
      expect(within(dialog()).getByText("Every asset at the bottom of the tree has a meter of its own or one above it.")).toBeInTheDocument();
    });

    it.each([
      ["a month that has not begun", { state: "not_begun" as const, hours: 0, meters: 0, meter_hours: 0 }, "This month has not begun.", "Nothing was read."],
      ["a month whose first hour is not over", { state: "open" as const, hours: 0, meters: 0, meter_hours: 0 }, "The first hour of this month is not over yet.", "Nothing was read."],
      ["a month no meter recorded in", { meters: 0, meter_hours: 0 }, "No meter has recorded anything in this month.", /^Looked at 0 meters over 720 hours/],
    ])("says Nothing to look at yet, and why, for %s", (_name, over, reason, looked) => {
      show(ready(check(over)));
      expect(within(dialog()).getByText("Nothing to look at yet")).toBeInTheDocument();
      expect(within(dialog()).getByText(reason)).toBeInTheDocument();
      expect(within(dialog()).getByText(looked)).toBeInTheDocument();
      expect(within(dialog()).queryByText("Nothing to check")).not.toBeInTheDocument();
    });

    it("says that a closed month's bill is frozen and the check is not, and that an open month is read up to its last full hour", () => {
      const { unmount } = show(ready(check({ closed: true })));
      expect(within(dialog()).getByText(/^This month is closed: its billed figures are frozen\./)).toBeInTheDocument();
      unmount();
      show(ready(check({ state: "open" })));
      expect(within(dialog()).getByText("This month is still running: the check stops at the last full hour.")).toBeInTheDocument();
    });

    it("keeps the headline on top of a month whose every meter is silent", () => {
      show(ready(check({ things: 3, meters: 3 }, { silent: group([{ ...silent, reason: "never", since: null, last_reading: null, hours: 720 }]) })));
      expect(within(dialog()).getByText("3 things to check")).toBeInTheDocument();
      expect(within(groupOf("Meters with no readings 1")).getByText("No reading has ever been recorded.")).toBeInTheDocument();
    });
  });

  describe("long lists", () => {
    const button = (name: string | RegExp) => within(dialog()).getByRole("button", { name });
    const itemsOf = (title: string) => groupOf(title).querySelectorAll("li");

    it("shows the first five and a Show all N button that opens the rest, becomes Show fewer, and keeps the focus on itself", async () => {
      show(ready(pilot()));
      expect(itemsOf("Estimated from power 8")).toHaveLength(5);
      const more = within(groupOf("Estimated from power 8")).getByRole("button", { name: "Show all 8" });
      expect(more).toHaveAttribute("type", "button");
      expect(more).toHaveAttribute("aria-expanded", "false");
      expect(more).toHaveAttribute("aria-controls", groupOf("Estimated from power 8").querySelector("ul")!.id);
      await userEvent.click(more);
      expect(itemsOf("Estimated from power 8")).toHaveLength(8);
      expect(more).toHaveTextContent("Show fewer"); // the same element: its words changed, the focus stays
      expect(more).toHaveAttribute("aria-expanded", "true");
      expect(more).toHaveFocus();
      await userEvent.click(more);
      expect(itemsOf("Estimated from power 8")).toHaveLength(5);
      expect(more).toHaveAttribute("aria-expanded", "false");
      expect(more).toHaveFocus();
    });

    it("has no button for a list of five or fewer", () => {
      show(ready(pilot()));
      expect(within(groupOf("Gaps in the readings 1")).queryByRole("button")).not.toBeInTheDocument();
      expect(itemsOf("Gaps in the readings 1")).toHaveLength(1);
    });

    it("says how many more the server did not send under a list that shows all it sent, and waits for Show all otherwise", async () => {
      const many = check({ things: 217, limits: { ...LIMITS, cap: 60 } }, { estimated: group(times(60, estimated), 217) });
      show(ready(many));
      const block = groupOf("Estimated from power 217");
      expect(block.querySelectorAll("li")).toHaveLength(5);
      expect(within(block).queryByText(/^and \d+ more$/)).not.toBeInTheDocument(); // 5 of 60 shown: the cap line would count wrong here
      await userEvent.click(within(block).getByRole("button", { name: "Show all 60" }));
      expect(block.querySelectorAll("li")).toHaveLength(60);
      expect(within(block).getByText("and 157 more")).toHaveClass("muted");
    });

    it("shows the cap line at once when the whole list is short", () => {
      show(ready(check({ things: 8, limits: { ...LIMITS, cap: 3 } }, { estimated: group(times(3, estimated), 8) })));
      expect(within(groupOf("Estimated from power 8")).getByText("and 5 more")).toBeInTheDocument();
    });

    it("keeps each list's fold to itself", async () => {
      show(ready(check({ things: 12 }, { estimated: group(times(6, estimated)), gaps: group(times(6, (i) => ({ ...gap, asset_id: 300 + i, path: `Gap ${i}` }))) })));
      await userEvent.click(within(groupOf("Estimated from power 6")).getByRole("button", { name: "Show all 6" }));
      expect(itemsOf("Estimated from power 6")).toHaveLength(6);
      expect(itemsOf("Gaps in the readings 6")).toHaveLength(5);
      expect(button("Show all 6")).toBeInTheDocument(); // the other list's button
    });
  });

  describe("the information block (never counted)", () => {
    it("lists the assets nothing measures, the beside-measured ones first with their own sentence, folded to five", async () => {
      const items = [unmetered(0), unmetered(1, true), unmetered(2, true), ...times(17, (i) => unmetered(i + 3))];
      show(ready(check({}, { unmetered: group([items[1], items[2], items[0], ...items.slice(3)]) })));
      const block = groupOf("Not counted");
      expect(within(block).getByText(/^20 assets have no meter of their own and no meter above them/)).toBeInTheDocument();
      const rows = Array.from(block.querySelectorAll("li"));
      expect(rows).toHaveLength(5);
      expect(rows[0]).toHaveTextContent("Electrical / Panel 2");
      expect(rows[0]).toHaveTextContent("The asset above is billed from other meters under it; if this one uses power, that power is not in that figure.");
      expect(rows[2]).toHaveTextContent("Nothing measures this asset or any asset above it.");
      await userEvent.click(within(block).getByRole("button", { name: "Show all 20" }));
      expect(block.querySelectorAll("li")).toHaveLength(20);
    });

    it("lists meters that started after what was looked at, with the time of their first reading, and nothing when there are none", () => {
      const { unmount } = show(ready(check()));
      expect(within(dialog()).queryByRole("heading", { level: 4, name: "Meters that started later" })).not.toBeInTheDocument();
      unmount();
      show(ready(check({ state: "open" }, { later: group([later(0), later(1)]) })));
      expect(within(dialog()).getByRole("heading", { level: 4, name: "Meters that started later" })).toBeInTheDocument();
      expect(within(dialog()).getByText(/^2 meters gave their first reading after what was looked at\./)).toBeInTheDocument();
      expect(within(dialog()).getAllByText("First reading 2026-10-01 08:00: after what was looked at.", { selector: "p" })).toHaveLength(2);
    });

    it("is the last block, below every counted group", () => {
      show(ready(pilot()));
      const blocks = Array.from(dialog().querySelectorAll(".month-check-group"));
      expect(blocks[blocks.length - 1]).toHaveClass("month-check-info");
      expect(blocks.filter((b) => b.classList.contains("month-check-info"))).toHaveLength(1);
    });
  });

  describe("accessibility and words", () => {
    it("has no live region, no status and no alert in its content: it is read once opened", () => {
      show(ready(pilot()));
      expect(dialog().querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    });

    it("builds its groups from divs and headings, not from labelled sections (a section with aria-labelledby is found twice by its label)", () => {
      show(ready(pilot()));
      expect(dialog().querySelector("section")).toBeNull();
      expect(dialog().querySelectorAll("[aria-labelledby]")).toHaveLength(0); // only the dialog itself is labelled
      const ids = Array.from(dialog().querySelectorAll("h3")).map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id !== "")).toBe(true);
    });

    it("never uses a word that promises the month is right, in any group of any kind, and never a percent sign", () => {
      const everything = check({ things: 9, state: "open", closed: true, limits: LIMITS }, {
        silent: group([silent, { ...silent, asset_id: 71, kind: "power", reason: "never", since: null, last_reading: null }, { ...silent, asset_id: 72, reason: "none_in_month", since: null }]),
        gaps: group([gap, { ...gap, asset_id: 73, kind: "power", runs: 0, hours: 0, longest_hours: null, short_hours: 12, short_minutes: 150, leading_hours: 4, previous_reading: "2026-08-31T20:00:00Z" }]),
        estimated: group([estimated(0)]),
        resets: group([{ ...reset, dips: 2, falls: 1, events: [{ at: "2026-09-12T06:00:00Z", kind: "reset" }, { at: "2026-09-13T06:00:00Z", kind: "dip" }, { at: "2026-09-14T06:00:00Z", kind: "fell" }] }]),
        started: group([{ ...head("counter", 80), first_reading: "2026-09-10T06:00:00Z", children: 0 }]),
        unpriced: group([{ ...head("counter", 81), kwh: 1234.56, hours: 5, days: 2, first_day: "2026-09-01", last_day: "2026-09-02" }]),
        flat: group([{ ...head("power", 82), runs: 2, longest_hours: 40, longest_start: "2026-09-05T06:00:00Z", first_start: "2026-09-05T06:00:00Z" }]),
        unmetered: group([unmetered(0, true), unmetered(1)]),
        later: group([later(0)]),
      });
      show(ready(everything));
      const words = dialog().textContent!;
      expect(words.length).toBeGreaterThan(1500);
      expect(words).not.toMatch(/\b(ok|ready|verified|correct|accurate|guarantee|safe|all good|passed)\b/i);
      expect(words).not.toContain("%");
    });
  });

  describe("while the answer is read, and when it fails", () => {
    it("draws the shape of the answer in one status region named for what it waits for", () => {
      show({ status: "loading" });
      const region = within(dialog()).getByRole("status");
      expect(region).toHaveTextContent("Loading the month check");
      expect(region).toHaveAttribute("aria-busy", "true");
      expect(region.querySelector(".month-check-headline")).not.toBeNull();
      expect(region.querySelector(".month-check-looked")).not.toBeNull();
      const groups = region.querySelectorAll(".month-check-group");
      expect(groups).toHaveLength(2);
      for (const g of Array.from(groups)) expect(g.querySelectorAll("li")).toHaveLength(3);
      expect(region.querySelectorAll(".sk-line").length).toBeGreaterThanOrEqual(9);
      expect(within(dialog()).queryByRole("heading", { level: 3 })).not.toBeInTheDocument(); // the shape's headings are hidden from assistive technology
      expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();
    });

    it("holds no words but the region's label while it waits", () => {
      show({ status: "loading" });
      expect(dialog().querySelector(".drawer-body")!.textContent).toBe("Loading the month check");
    });

    it("shows the message in an alert and nothing else when the read failed", () => {
      show({ status: "error", message: "the check is down" });
      expect(within(dialog()).getByRole("alert")).toHaveTextContent("the check is down");
      expect(within(dialog()).getByRole("alert")).toHaveClass("error");
      expect(within(dialog()).queryByRole("status")).not.toBeInTheDocument();
      expect(within(dialog()).queryByText(/things? to check/)).not.toBeInTheDocument();
    });
  });

  describe("closing", () => {
    it("closes with Escape and the x, and gives the focus to what returnFocus names", async () => {
      const onClose = vi.fn();
      const opener = document.createElement("button");
      opener.textContent = "opener";
      document.body.append(opener);
      show(ready(pilot()), { onClose, returnFocus: () => opener });
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      await userEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(2);
      opener.remove();
    });

    it("hands the focus back when it is taken away", () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      const { unmount } = show(ready(pilot()), { returnFocus: () => opener });
      unmount();
      expect(opener).toHaveFocus();
      opener.remove();
    });
  });
});
