import type { PermissionRow } from "../api/types";
import { PAGE_NEED, visibleGroups } from "../components/navItems";
import { BUILTIN_PERMISSIONS } from "../test/users";
import { catalogue } from "../test/permissionFixtures";
import { PERMISSION_LABELS, PERMISSIONS, type PermissionId } from "./permissions";
import {
  groupPermissions, joinWords, needSentence, offerFor, offerWords, PERMISSION_NEEDS, permissionGaps, roleDisplayName, summarizeRole,
} from "./roleEditor";

const row = (id: string, area: string, kind: PermissionRow["kind"]): PermissionRow => ({ id, area, kind, label: `Label of ${id}`, description: "" });
const ids = (list: readonly PermissionRow[]) => list.map((r) => r.id);

describe("groupPermissions", () => {
  it("makes one row per area in catalogue order, each with its See and Change entries; the Roles area has none and is left out", () => {
    const { areas } = groupPermissions(catalogue());
    expect(areas.map((a) => a.area)).toEqual([
      "Assets Tree", "Dashboards", "Billing and tariffs", "Sources and discovery", "Storage and settings", "Audit log", "Users", "Diagnostics",
    ]);
    const byArea = Object.fromEntries(areas.map((a) => [a.area, { see: ids(a.see), change: ids(a.change) }]));
    expect(byArea["Assets Tree"]).toEqual({ see: ["assets.view"], change: ["assets.edit"] });
    expect(byArea["Billing and tariffs"]).toEqual({ see: ["billing.view", "tariffs.view"], change: ["tariffs.edit"] });
    expect(byArea["Sources and discovery"]).toEqual({ see: ["sources.view", "discovery.view"], change: ["sources.edit", "sources.test", "discovery.edit"] });
    expect(byArea["Audit log"]).toEqual({ see: ["audit.view"], change: [] });
  });

  it("collects the risky ids as the sensitive actions, in catalogue order, and puts roles.manage nowhere", () => {
    const { areas, sensitive } = groupPermissions(catalogue());
    expect(ids(sensitive)).toEqual([
      "assets.delete", "dashboards.default", "billing.export", "discovery.scan", "discovery.accept", "settings.security", "audit.export",
    ]);
    const everyId = [...areas.flatMap((a) => [...a.see, ...a.change]), ...sensitive].map((r) => r.id);
    expect(everyId).not.toContain("roles.manage");
    expect(everyId).toHaveLength(28); // 29 in the catalogue, minus the locked one
  });

  it("orders areas by the first row of each (a risky row counts) and leaves out an area with only risky rows", () => {
    const { areas, sensitive } = groupPermissions([row("b.risky", "B", "risky"), row("a.see", "A", "see"), row("b.see", "B", "see"), row("c.risky", "C", "risky")]);
    expect(areas.map((a) => a.area)).toEqual(["B", "A"]);
    expect(ids(sensitive)).toEqual(["b.risky", "c.risky"]);
  });

  it("groups an id this build does not know like any other (it comes from the API row)", () => {
    const { areas } = groupPermissions([...catalogue(), row("reports.view", "Reports", "see")]);
    expect(areas.at(-1)).toMatchObject({ area: "Reports" });
    expect(ids(areas.at(-1)!.see)).toEqual(["reports.view"]);
  });

  it("does not throw on an empty list", () => {
    expect(groupPermissions([])).toEqual({ areas: [], sensitive: [] });
  });
});

describe("PERMISSION_NEEDS", () => {
  it("has a row for every id of the catalogue and nothing else", () => {
    expect(Object.keys(PERMISSION_NEEDS).sort()).toEqual([...PERMISSIONS].sort());
  });

  it("never lists itself or roles.manage, and every target is a real id", () => {
    for (const id of PERMISSIONS) {
      const needs = PERMISSION_NEEDS[id];
      expect(needs, id).not.toContain(id);
      expect(needs, id).not.toContain("roles.manage");
      for (const target of needs) expect(PERMISSIONS, `${id} needs ${target}`).toContain(target);
    }
  });

  it("follows the audit table of the plan for the cross-area cases", () => {
    expect(PERMISSION_NEEDS["dashboards.edit"]).toEqual(["dashboards.view", "assets.view", "discovery.view"]);
    expect(PERMISSION_NEEDS["sources.edit"]).toEqual(["sources.view"]);
    expect(PERMISSION_NEEDS["tariffs.view"]).toEqual(["assets.view"]);
    expect(PERMISSION_NEEDS["tariffs.edit"]).toEqual(["tariffs.view", "assets.view"]);
    expect(PERMISSION_NEEDS["diagnostics.view"]).toEqual(["sources.view"]);
    expect(PERMISSION_NEEDS["settings.security"]).toEqual(["settings.view"]);
    expect(PERMISSION_NEEDS["assets.view"]).toEqual([]);
  });
});

describe("PERMISSION_NEEDS is a sound table", () => {
  it("is closed: whatever a need itself needs is listed too, so one lookup is exact", () => {
    for (const id of PERMISSIONS) for (const need of PERMISSION_NEEDS[id]) {
      for (const deeper of PERMISSION_NEEDS[need]) expect(PERMISSION_NEEDS[id], `${id} needs ${need} needs ${deeper}`).toContain(deeper);
    }
  });
  it("has no cycle and no permission needing itself", () => {
    const visit = (id: PermissionId, path: PermissionId[]) => {
      expect(path, `cycle through ${id}`).not.toContain(id);
      for (const need of PERMISSION_NEEDS[id]) visit(need, [...path, id]);
    };
    for (const id of PERMISSIONS) visit(id, []);
  });
  it("lists no duplicate need", () => {
    for (const id of PERMISSIONS) expect(new Set(PERMISSION_NEEDS[id]).size, id).toBe(PERMISSION_NEEDS[id].length);
  });
  it("agrees with the pages: for an all-of page need, the first id lists all the others", () => {
    for (const [page, need] of Object.entries(PAGE_NEED)) {
      if (!Array.isArray(need)) continue;
      const [opens, ...rest] = need as PermissionId[];
      for (const other of rest) expect(PERMISSION_NEEDS[opens], `${page}: ${opens} should list ${other}`).toContain(other);
    }
  });
  it("makes every action permission need the See of its own area", () => {
    // the area is the id's prefix; "tariffs.edit" needs "tariffs.view" and so on. roles.manage and *.view ids are exempt,
    // and diagnostics.run (works without diagnostics.view: the W9b audit table, row diagnostics.run) is the one real exception.
    for (const id of PERMISSIONS) {
      const [area, action] = id.split(".");
      if (action === "view" || id === "roles.manage" || id === "diagnostics.run") continue;
      expect(PERMISSION_NEEDS[id], id).toContain(`${area}.view`);
    }
  });
});

describe("offerFor", () => {
  it("offers to tick the See that a just-ticked Change lacks", () => {
    expect(offerFor("users.edit", new Set())).toEqual({ kind: "tick", id: "users.edit", others: ["users.view"] });
  });
  it("offers all the missing needs in the table's order, and none that are ticked", () => {
    expect(offerFor("dashboards.edit", new Set(["dashboards.view"]))).toEqual({ kind: "tick", id: "dashboards.edit", others: ["assets.view", "discovery.view"] });
  });
  it("offers nothing when every need is ticked, or the permission needs nothing", () => {
    expect(offerFor("users.edit", new Set(["users.view"]))).toBeNull();
    expect(offerFor("assets.view", new Set())).toBeNull();
  });
  it("offers to untick the ticked permissions that need a just-unticked one", () => {
    expect(offerFor("users.view", new Set(["users.view", "users.edit"]))).toEqual({ kind: "untick", id: "users.view", others: ["users.edit"] });
    expect(offerFor("users.view", new Set(["users.view", "audit.view"]))).toBeNull();
  });
  it("lists the dependents in catalogue order", () => {
    const before = new Set(["assets.view", "tariffs.edit", "assets.edit", "assets.delete"]);
    expect(offerFor("assets.view", before)?.others).toEqual(["assets.edit", "assets.delete", "tariffs.edit"]);
  });
  it("offers nothing for an id this build does not know", () => {
    expect(offerFor("zzz.new", new Set())).toBeNull();
  });
});

describe("offerWords", () => {
  const L = (id: string) => PERMISSION_LABELS[id as PermissionId] ?? id;
  it("words a tick offer for one need like the hint", () => {
    expect(offerWords({ kind: "tick", id: "users.edit", others: ["users.view"] }, L)).toEqual({
      sentence: "Change users also needs See users to show anything.", items: [], accept: "Also tick See users", decline: "Not now",
    });
  });
  it("lists several needs and counts them on the button", () => {
    const words = offerWords({ kind: "tick", id: "dashboards.edit", others: ["assets.view", "discovery.view"] }, L);
    expect(words.sentence).toBe("Change dashboards also needs these to show anything:");
    expect(words.items).toEqual(["See the Assets Tree", "See scans and the graph"]);
    expect(words.accept).toBe("Also tick 2 permissions");
  });
  it("words an untick offer for one and for several dependents", () => {
    expect(offerWords({ kind: "untick", id: "users.view", others: ["users.edit"] }, L)).toEqual({
      sentence: "Change users needs See users to show anything. Also untick Change users?", items: [], accept: "Also untick Change users", decline: "Leave ticked",
    });
    const many = offerWords({ kind: "untick", id: "assets.view", others: ["assets.edit", "assets.delete"] }, L);
    expect(many.sentence).toBe("These need See the Assets Tree to show anything. Also untick them?");
    expect(many.accept).toBe("Also untick 2 permissions");
  });
  it("needSentence is the hint's sentence", () => {
    expect(needSentence("dashboards.edit", ["assets.view", "discovery.view"], L)).toBe("Change dashboards also needs See the Assets Tree and See scans and the graph to show anything.");
  });
});

describe("permissionGaps", () => {
  it("names the See that a lone Change lacks", () => {
    expect(permissionGaps(new Set(["assets.edit"]))).toEqual([{ id: "assets.edit", missing: ["assets.view"] }]);
  });

  it("flags dashboards.edit without the assets and the graph it loads, even with dashboards.view", () => {
    expect(permissionGaps(new Set(["dashboards.view", "dashboards.edit"]))).toEqual([
      { id: "dashboards.edit", missing: ["assets.view", "discovery.view"] },
    ]);
  });

  it("lists the gaps in catalogue order, whatever the order the ids were ticked in", () => {
    expect(permissionGaps(new Set(["audit.export", "assets.delete"])).map((g) => g.id)).toEqual(["assets.delete", "audit.export"]);
  });

  it("finds no gap in an Executive set or in any built-in role", () => {
    expect(permissionGaps(new Set(["assets.view", "dashboards.view", "billing.view", "billing.export"]))).toEqual([]);
    for (const set of Object.values(BUILTIN_PERMISSIONS)) expect(permissionGaps(new Set(set))).toEqual([]);
    expect(permissionGaps(new Set())).toEqual([]);
  });

  it("ignores an id this build does not know", () => {
    expect(permissionGaps(new Set(["zzz.new"]))).toEqual([]);
  });
});

describe("summarizeRole", () => {
  const list = catalogue();
  const pagesOf = (set: ReadonlySet<string>) => visibleGroups((id) => set.has(id)).flatMap((g) => g.items.map((i) => i.label));

  it("reads the Executive set as three pages, no changes and one sensitive action", () => {
    const executive = new Set(["assets.view", "dashboards.view", "billing.view", "billing.export"]);
    expect(summarizeRole(list, executive)).toEqual({
      pages: ["Assets Tree", "Dashboards", "Billing"],
      changes: [],
      sensitive: ["Export billing as CSV"],
    });
  });

  it("opens exactly the sidebar that visibleGroups gives the same permissions", () => {
    for (const set of [new Set(BUILTIN_PERMISSIONS.operator), new Set(BUILTIN_PERMISSIONS.admin), new Set(["users.view"]), new Set<string>()]) {
      expect(summarizeRole(list, set).pages).toEqual(pagesOf(set));
    }
  });

  it("lists the ticked Change entries and the ticked sensitive ones by their labels, in catalogue order", () => {
    const operator = summarizeRole(list, new Set(BUILTIN_PERMISSIONS.operator));
    expect(operator.changes).toEqual(["Change dashboards", "Test source connections", "Run the connection check"]);
    expect(operator.sensitive).toEqual(["Export billing as CSV"]);
  });

  it("counts roles.manage among the sensitive ones when it is ticked (the built-in Admin)", () => {
    const admin = summarizeRole(list, new Set(BUILTIN_PERMISSIONS.admin));
    expect(admin.sensitive).toContain("Manage roles");
    expect(admin.sensitive).toHaveLength(8);
  });

  it("ignores an id this build does not know for the pages, lists it by its server label, and does not throw", () => {
    const withNew = [...list, row("zzz.new", "Reports", "change")];
    const summary = summarizeRole(withNew, new Set(["assets.view", "zzz.new"]));
    expect(summary.pages).toEqual(pagesOf(new Set(["assets.view"])));
    expect(summary.changes).toEqual(["Label of zzz.new"]);
    expect(() => summarizeRole(list, new Set(["zzz.other"]))).not.toThrow();
    expect(summarizeRole(list, new Set(["zzz.other"]))).toEqual({ pages: [], changes: [], sensitive: [] });
  });
});

describe("joinWords and roleDisplayName", () => {
  it("joins words as a sentence does", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["A"])).toBe("A");
    expect(joinWords(["A", "B"])).toBe("A and B");
    expect(joinWords(["A", "B", "C"])).toBe("A, B and C");
  });

  it("writes a built-in role out (Administrator) and leaves a custom name as it is", () => {
    expect(roleDisplayName({ name: "admin", builtin: true })).toBe("Administrator");
    expect(roleDisplayName({ name: "operator", builtin: true })).toBe("Operator");
    expect(roleDisplayName({ name: "admin", builtin: false })).toBe("admin");
    expect(roleDisplayName({ name: "Executive", builtin: false })).toBe("Executive");
  });
});
