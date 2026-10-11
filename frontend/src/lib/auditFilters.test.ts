import {
  apiQuery, AuditFilters, DEFAULT_SIZE, isFiltered, lastOffset, NO_FILTERS, nextOffset, offsetOfPage, pageCount, pageOf,
  PAGE_SIZES, previousOffset, QUICK_FILTERS, quickActive, readUrl, writeUrl,
} from "./auditFilters";

const FULL: AuditFilters = { user: "3", actions: ["login.*", "*.deleted"], from: "2026-10-01", to: "2026-10-06", q: "disk full" };
const quick = (id: string) => {
  const found = QUICK_FILTERS.find((item) => item.id === id);
  if (!found) throw new Error(`no quick filter ${id}`);
  return found;
};

describe("NO_FILTERS and the page sizes", () => {
  it("sets nothing", () => {
    expect(NO_FILTERS).toEqual({ user: "", actions: [], from: "", to: "", q: "" });
    expect(isFiltered(NO_FILTERS)).toBe(false);
  });
  it("offers four sizes and 50 is one of them", () => {
    expect([...PAGE_SIZES]).toEqual([25, 50, 100, 200]);
    expect(DEFAULT_SIZE).toBe(50);
    expect(PAGE_SIZES).toContain(DEFAULT_SIZE);
  });
});

describe("readUrl", () => {
  it("reads an empty query as the defaults", () => {
    expect(readUrl(new URLSearchParams(""))).toEqual({ filters: NO_FILTERS, offset: 0, size: 50, view: "friendly" });
  });

  it("round-trips through writeUrl", () => {
    const state = { filters: FULL, offset: 73, size: 100, view: "raw" as const };
    expect(readUrl(writeUrl(state))).toEqual(state);
  });

  it("reads repeated action keys in order", () => {
    const state = readUrl(new URLSearchParams("action=login.failed&action=login.locked&user=none"));
    expect(state.filters.actions).toEqual(["login.failed", "login.locked"]);
    expect(state.filters.user).toBe("none");
  });

  it.each([["size=7"], ["size=abc"], ["size="], ["size=50.5"], ["size=-25"]])("%s falls back to the default size", (query) => {
    expect(readUrl(new URLSearchParams(query)).size).toBe(DEFAULT_SIZE);
  });
  it.each([25, 50, 100, 200])("keeps size=%i", (size) => {
    expect(readUrl(new URLSearchParams(`size=${size}`)).size).toBe(size);
  });

  it.each([["offset=-3"], ["offset=abc"], ["offset="], ["offset=1.5"], ["offset=1e3"], ["offset=99999999999999999999999"]])(
    "%s falls back to offset 0",
    (query) => {
      expect(readUrl(new URLSearchParams(query)).offset).toBe(0);
    },
  );
  it("keeps a valid offset, aligned or not", () => {
    expect(readUrl(new URLSearchParams("offset=73")).offset).toBe(73);
    expect(readUrl(new URLSearchParams("offset=0")).offset).toBe(0);
  });

  it("shows the raw view only for view=raw", () => {
    expect(readUrl(new URLSearchParams("view=raw")).view).toBe("raw");
    expect(readUrl(new URLSearchParams("view=friendly")).view).toBe("friendly");
    expect(readUrl(new URLSearchParams("view=RAW")).view).toBe("friendly");
    expect(readUrl(new URLSearchParams("view=")).view).toBe("friendly");
  });

  it.each([["from=notadate"], ["from=2026-02-30"], ["from=2026-1-5"], ["from=20261005"], ["from="]])("%s becomes an unset date", (query) => {
    expect(readUrl(new URLSearchParams(query)).filters.from).toBe("");
  });
  it("keeps a real date and drops only the bad one", () => {
    const { filters } = readUrl(new URLSearchParams("from=2026-10-01&to=2026-13-01"));
    expect(filters.from).toBe("2026-10-01");
    expect(filters.to).toBe("");
  });

  it.each([["user=bob"], ["user=1234567890"], ["user=-1"], ["user=1.5"], ["user=None"], ["user=%201"]])(
    "%s is not a user the API accepts and becomes unset",
    (query) => {
      expect(readUrl(new URLSearchParams(query)).filters.user).toBe("");
    },
  );
  it.each([["none"], ["0"], ["12"], ["123456789"]])("keeps user=%s", (user) => {
    expect(readUrl(new URLSearchParams(`user=${user}`)).filters.user).toBe(user);
  });

  it.each([
    ["action=Bad%20Action"], ["action=a*b"], ["action=*"], ["action=**"], ["action=UPPER"], ["action=a-b"], ["action=%2A%2Aa"],
    [`action=${"a".repeat(61)}`],
  ])("%s is dropped", (query) => {
    expect(readUrl(new URLSearchParams(query)).filters.actions).toEqual([]);
  });
  it("keeps exact, prefix and suffix actions and drops only the bad ones, in order", () => {
    const { filters } = readUrl(new URLSearchParams("action=login.*&action=Bad&action=*.deleted&action=a*b&action=source.test_all&action=*x*"));
    expect(filters.actions).toEqual(["login.*", "*.deleted", "source.test_all", "*x*"]);
    expect(readUrl(new URLSearchParams(`action=${"a".repeat(60)}`)).filters.actions).toEqual(["a".repeat(60)]);
  });
  it("keeps at most 20 actions", () => {
    const many = Array.from({ length: 25 }, (_, i) => `action=a.b${i}`).join("&");
    expect(readUrl(new URLSearchParams(many)).filters.actions).toEqual(Array.from({ length: 20 }, (_, i) => `a.b${i}`));
  });

  it.each([["from=1969-12-31"], ["to=2101-01-01"], ["from=0001-01-01"], ["to=9999-12-31"]])("%s is outside 1970..2100 and becomes unset", (query) => {
    const { filters } = readUrl(new URLSearchParams(query));
    expect([filters.from, filters.to]).toEqual(["", ""]);
  });
  it("keeps the edges of 1970..2100", () => {
    const { filters } = readUrl(new URLSearchParams("from=1970-01-01&to=2100-12-31"));
    expect([filters.from, filters.to]).toEqual(["1970-01-01", "2100-12-31"]);
  });

  it("drops empty user, action and q values", () => {
    const { filters } = readUrl(new URLSearchParams("user=&action=&action=login.*&action=&q="));
    expect(filters).toEqual({ ...NO_FILTERS, actions: ["login.*"] });
  });
  it("drops a q that is only blanks", () => {
    expect(readUrl(new URLSearchParams("q=%20%20")).filters.q).toBe("");
  });
});

describe("writeUrl", () => {
  it("omits every default", () => {
    expect(writeUrl({ filters: NO_FILTERS, offset: 0, size: DEFAULT_SIZE, view: "friendly" }).toString()).toBe("");
  });

  it("writes the keys user, action, from, to, q, offset, size, view, repeating action", () => {
    const text = writeUrl({ filters: FULL, offset: 50, size: 25, view: "raw" }).toString();
    expect(text).toBe("user=3&action=login.*&action=*.deleted&from=2026-10-01&to=2026-10-06&q=disk+full&offset=50&size=25&view=raw");
  });

  it("writes only what differs from the default", () => {
    expect(writeUrl({ filters: { ...NO_FILTERS, user: "none" }, offset: 0, size: 50, view: "friendly" }).toString()).toBe("user=none");
    expect(writeUrl({ filters: NO_FILTERS, offset: 0, size: 200, view: "friendly" }).toString()).toBe("size=200");
    expect(writeUrl({ filters: NO_FILTERS, offset: 0, size: 50, view: "raw" }).toString()).toBe("view=raw");
  });

  it("does not write a blank q", () => {
    expect(writeUrl({ filters: { ...NO_FILTERS, q: "   " }, offset: 0, size: 50, view: "friendly" }).has("q")).toBe(false);
  });
});

describe("apiQuery", () => {
  it("is empty for no filters", () => {
    expect(apiQuery(NO_FILTERS)).toBe("");
  });

  it("encodes spaces and keeps * readable, repeating action", () => {
    const text = apiQuery({ ...NO_FILTERS, actions: ["*.deleted", "login.*"], q: "disk full & more" });
    expect(text).toBe("action=*.deleted&action=login.*&q=disk+full+%26+more");
    const back = new URLSearchParams(text);
    expect(back.getAll("action")).toEqual(["*.deleted", "login.*"]);
    expect(back.get("q")).toBe("disk full & more");
  });

  it("skips empty values and blank text", () => {
    expect(apiQuery({ user: "", actions: [], from: "", to: "2026-10-06", q: "  " })).toBe("to=2026-10-06");
  });

  it("lists every filter, then the extras", () => {
    expect(apiQuery(FULL, { limit: 50, offset: 0 })).toBe(
      "user=3&action=login.*&action=*.deleted&from=2026-10-01&to=2026-10-06&q=disk+full&limit=50&offset=0",
    );
  });

  it("works with extras alone and skips an empty extra", () => {
    expect(apiQuery(NO_FILTERS, { date: "2026-10-06" })).toBe("date=2026-10-06");
    expect(apiQuery(NO_FILTERS, { date: "" })).toBe("");
  });
});

describe("isFiltered", () => {
  it.each<[string, Partial<AuditFilters>, boolean]>([
    ["a user", { user: "none" }, true],
    ["an action", { actions: ["login.*"] }, true],
    ["a from date", { from: "2026-10-01" }, true],
    ["a to date", { to: "2026-10-01" }, true],
    ["text", { q: "x" }, true],
    ["blank text only", { q: "  " }, false],
  ])("%s -> %s", (_label, patch, expected) => {
    expect(isFiltered({ ...NO_FILTERS, ...patch })).toBe(expected);
  });
});

describe("quick filters", () => {
  const today = "2026-10-06";

  it("lists today, week, deletions, signin", () => {
    expect(QUICK_FILTERS.map((item) => item.id)).toEqual(["today", "week", "deletions", "signin"]);
    expect(QUICK_FILTERS.map((item) => item.label)).toEqual(["Today", "Last 7 days", "Deletions", "Sign-in problems"]);
  });

  it("builds each patch", () => {
    expect(quick("today").patch(today)).toEqual({ from: "2026-10-06", to: "2026-10-06" });
    expect(quick("week").patch(today)).toEqual({ from: "2026-09-30", to: "2026-10-06" });
    expect(quick("week").patch("2026-03-02")).toEqual({ from: "2026-02-24", to: "2026-03-02" });
    expect(quick("deletions").patch(today)).toEqual({ actions: ["*.deleted"] });
    expect(quick("signin").patch(today)).toEqual({ actions: ["login.failed", "login.locked", "password.change_failed"] });
  });

  it("is active only for exactly its own filters", () => {
    expect(quickActive(quick("today"), { ...NO_FILTERS, from: today, to: today }, today)).toBe(true);
    expect(quickActive(quick("today"), { ...NO_FILTERS, from: today }, today)).toBe(false);
    expect(quickActive(quick("today"), { ...NO_FILTERS, from: "2026-10-05", to: today }, today)).toBe(false);
    expect(quickActive(quick("week"), { ...NO_FILTERS, from: "2026-09-30", to: today }, today)).toBe(true);
    expect(quickActive(quick("week"), { ...NO_FILTERS, from: "2026-10-01", to: today }, today)).toBe(false);
    expect(quickActive(quick("week"), { ...NO_FILTERS, from: today, to: today }, today)).toBe(false);
    expect(quickActive(quick("deletions"), { ...NO_FILTERS, actions: ["*.deleted"] }, today)).toBe(true);
    expect(quickActive(quick("deletions"), { ...NO_FILTERS, actions: ["*.deleted", "login.*"] }, today)).toBe(false);
    expect(quickActive(quick("deletions"), NO_FILTERS, today)).toBe(false);
    const three = ["login.failed", "login.locked", "password.change_failed"];
    expect(quickActive(quick("signin"), { ...NO_FILTERS, actions: three }, today)).toBe(true);
    expect(quickActive(quick("signin"), { ...NO_FILTERS, actions: [...three].reverse() }, today)).toBe(true);
    expect(quickActive(quick("signin"), { ...NO_FILTERS, actions: three.slice(0, 2) }, today)).toBe(false);
    expect(quickActive(quick("signin"), { ...NO_FILTERS, actions: [...three, "x.y"] }, today)).toBe(false);
  });

  it("does not look at the filters it does not set", () => {
    expect(quickActive(quick("deletions"), { ...NO_FILTERS, actions: ["*.deleted"], user: "3", q: "x" }, today)).toBe(true);
  });

  it("applying a patch makes that quick filter active", () => {
    for (const item of QUICK_FILTERS) {
      expect(quickActive(item, { ...NO_FILTERS, ...item.patch(today) }, today)).toBe(true);
    }
  });
});

describe("pager arithmetic", () => {
  it("counts at least one page", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(1, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(120, 50)).toBe(3);
  });

  it("names the page an offset is on, aligned or not", () => {
    expect(pageOf(0, 50)).toBe(1);
    expect(pageOf(49, 50)).toBe(1);
    expect(pageOf(50, 50)).toBe(2);
    expect(pageOf(73, 50)).toBe(2);
    expect(pageOf(100, 50)).toBe(3);
  });

  it("goes to the aligned offset of a page, clamped into range", () => {
    expect(offsetOfPage(1, 50, 120)).toBe(0);
    expect(offsetOfPage(2, 50, 120)).toBe(50);
    expect(offsetOfPage(3, 50, 120)).toBe(100);
    expect(offsetOfPage(99, 50, 120)).toBe(100);
    expect(offsetOfPage(0, 50, 120)).toBe(0);
    expect(offsetOfPage(-4, 50, 120)).toBe(0);
    expect(offsetOfPage(Number.NaN, 50, 120)).toBe(0);
    expect(offsetOfPage(2, 50, 0)).toBe(0);
  });

  it("steps back without going below zero, from an unaligned offset too", () => {
    expect(previousOffset(100, 50)).toBe(50);
    expect(previousOffset(73, 50)).toBe(23);
    expect(previousOffset(23, 50)).toBe(0);
    expect(previousOffset(0, 50)).toBe(0);
  });

  it("steps forward by a page, or null at the end", () => {
    expect(nextOffset(0, 50, 120)).toBe(50);
    expect(nextOffset(23, 50, 120)).toBe(73);
    expect(nextOffset(50, 50, 120)).toBe(100);
    expect(nextOffset(73, 50, 120)).toBeNull(); // 123 is not below 120
    expect(nextOffset(100, 50, 120)).toBeNull();
    expect(nextOffset(0, 50, 50)).toBeNull();
    expect(nextOffset(0, 50, 0)).toBeNull();
  });

  it("finds the aligned offset of the last page", () => {
    expect(lastOffset(50, 120)).toBe(100);
    expect(lastOffset(50, 100)).toBe(50);
    expect(lastOffset(50, 101)).toBe(100);
    expect(lastOffset(50, 0)).toBe(0);
    expect(lastOffset(50, 7)).toBe(0);
  });
});
