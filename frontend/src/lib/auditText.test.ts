import type { AuditEntry } from "../api/types";
import { describeAudit, formatValue, humanise } from "./auditText";

const entry = (action: string, detail: unknown, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1, user_id: 1, actor_id: 1, username: "admin", action, detail: detail as Record<string, unknown>,
  ts: "2026-10-11T08:00:00Z", ...extra,
});

// Every action the backend writes (the Python parity test keeps this list and the table in step).
const ALL_ACTIONS = [
  "asset.created", "asset.updated", "asset.deleted", "billing.currency_changed",
  "dashboard.created", "dashboard.updated", "dashboard.deleted", "dashboard.default_changed", "diagnostics.report", "discovery.accepted",
  "kind.created", "kind.deleted", "kind.icon_changed", "kind.renamed", "kind.starter_pack_added",
  "login.failed", "login.locked", "login.succeeded", "login.unblocked", "mapping.created", "mapping.updated", "mapping.deleted",
  "password.change_failed", "password.changed", "role.created", "role.updated", "role.deleted", "scan.finished", "scan.started",
  "scope.created", "scope.updated", "scope.deleted", "settings.sign_in_changed", "settings.timezone_changed", "setup.completed",
  "source.browsed", "source.checked", "source.created", "source.deleted", "source.test_all", "source.tested", "source.updated",
  "storage.changed", "storage.default_set", "tariff.created", "tariff.updated", "tariff.deleted",
  "user.created", "user.deleted", "user.updated",
];

describe("humanise", () => {
  it("turns underscores and dots into spaces and capitalises the first letter", () => {
    expect(humanise("rate_per_kwh")).toBe("Rate per kwh");
    expect(humanise("foo.bar_baz")).toBe("Foo bar baz");
    expect(humanise("")).toBe("");
  });
});

describe("formatValue", () => {
  it("writes absent values as a dash, booleans as yes/no, strings as they are and structures as JSON", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue(true)).toBe("yes");
    expect(formatValue(false)).toBe("no");
    expect(formatValue("QAR")).toBe("QAR");
    expect(formatValue(0.12)).toBe("0.12");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue(["10.0.0.0/24", 502])).toBe('["10.0.0.0/24",502]');
  });
});

describe("describeAudit: updates with before and after", () => {
  it("shows a tariff change as a sentence naming the asset, and one change row", () => {
    const view = describeAudit(
      entry(
        "tariff.updated",
        { tariff_id: 3, asset_id: 7, before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } },
        { refs: { asset: { "7": "Panel A" } } },
      ),
    );
    expect(view.summary).toBe("Changed the tariff for asset Panel A: rate per kwh");
    expect(view.changes).toEqual([{ field: "Rate per kwh", before: "0.1", after: "0.12" }]);
    expect(view.unchanged).toBe(0);
    expect(view.link).toEqual({ to: "/tariffs", label: "Open Tariffs" });
  });

  it("lists only the fields that changed for a storage save and counts the rest", () => {
    const view = describeAudit(
      entry("storage.changed", {
        policies_reapplied: true,
        origin: "manual",
        before: { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 },
        after: { raw_retention_days: 60, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 },
      }),
    );
    expect(view.summary).toBe("Changed the storage settings: raw retention days");
    expect(view.changes).toEqual([{ field: "Raw retention days", before: "30", after: "60" }]);
    expect(view.unchanged).toBe(4);
    expect(view.link).toEqual({ to: "/storage", label: "Open Storage" });
  });

  it("says the policies were re-applied when a storage save changed no value", () => {
    const same = { raw_retention_days: 30, compress_after_days: 7 };
    const view = describeAudit(
      entry("storage.changed", {
        policies_reapplied: true,
        origin: "factory",
        confirmed_loss: { shorter: true, raw_chunks: 4, rollup_1m_chunks: 0 },
        before: same,
        after: { ...same },
      }),
    );
    expect(view.summary).toBe("Saved the storage settings (policies re-applied)");
    expect(view.changes).toEqual([]);
    expect(view.unchanged).toBe(2);
  });

  it("shows the dashboard layout as a sentence, never as the hash", () => {
    const view = describeAudit(
      entry("dashboard.updated", {
        dashboard_id: 4, name: "Ops",
        before: { widgets: 3, widgets_hash: "abc123def456" },
        after: { widgets: 4, widgets_hash: "0f9e8d7c6b5a" },
      }),
    );
    const text = JSON.stringify(view);
    expect(text).not.toContain("abc123def456");
    expect(text).not.toContain("0f9e8d7c6b5a");
    expect(view.summary).toBe("Changed dashboard Ops: widgets, widget layout");
    expect(view.changes).toContainEqual({ field: "Widgets", before: "3", after: "4" });
    expect(view.changes.some((c) => c.after === "the widget layout changed")).toBe(true);
    expect(view.link).toEqual({ to: "/dashboards/4", label: "Open dashboard Ops" });
  });

  it("writes the default dashboard change as a sentence and links to the new default", () => {
    const side = (id: number | null, name: string | null) => ({ dashboard_id: id, dashboard: name });
    const made = describeAudit(entry("dashboard.default_changed", { before: side(null, null), after: side(4, "Ops") }));
    expect(made.summary).toBe("Made dashboard Ops the default dashboard");
    expect(made.link).toEqual({ to: "/dashboards/4", label: "Open dashboard Ops" });
    const moved = describeAudit(entry("dashboard.default_changed", { before: side(4, "Ops"), after: side(6, "Plant") }));
    expect(moved.summary).toBe("Changed the default dashboard from Ops to Plant");
    expect(moved.link).toEqual({ to: "/dashboards/6", label: "Open dashboard Plant" });
    const cleared = describeAudit(entry("dashboard.default_changed", { before: side(6, "Plant"), after: side(null, null) }));
    expect(cleared.summary).toBe("Cleared the default dashboard (was Plant)");
    expect(cleared.link).toBeNull();
    expect(describeAudit(entry("dashboard.default_changed", {})).summary).toBe("Changed the default dashboard");
    // A link is built from an integer id only.
    expect(describeAudit(entry("dashboard.default_changed", { before: side(null, null), after: side("4" as never, "Ops") })).link).toBeNull();
  });

  it("says when a deleted dashboard was the default", () => {
    expect(describeAudit(entry("dashboard.deleted", { dashboard_id: 4, name: "Ops", widgets: 1, was_default: true })).summary).toBe(
      "Deleted dashboard Ops (it was the default dashboard)",
    );
    expect(describeAudit(entry("dashboard.deleted", { dashboard_id: 4, name: "Ops", widgets: 1 })).summary).toBe("Deleted dashboard Ops");
    expect(describeAudit(entry("dashboard.deleted", { dashboard_id: 4, name: "Ops", widgets: 1, was_default: "yes" })).summary).toBe(
      "Deleted dashboard Ops",
    );
  });

  it("writes the two single-value settings as from-to sentences, with 'not set' for a missing side", () => {
    expect(
      describeAudit(entry("billing.currency_changed", { before: { currency: "QAR" }, after: { currency: "USD" } })).summary,
    ).toBe("Changed the site currency from QAR to USD");
    const first = describeAudit(entry("billing.currency_changed", { before: { currency: null }, after: { currency: "QAR" } }));
    expect(first.summary).toBe("Changed the site currency from not set to QAR");
    expect(first.link).toEqual({ to: "/tariffs", label: "Open Tariffs" });
    const zone = describeAudit(
      entry("settings.timezone_changed", { before: { timezone: "UTC" }, after: { timezone: "Asia/Qatar" } }),
    );
    expect(zone.summary).toBe("Changed the site time zone from UTC to Asia/Qatar");
    expect(zone.link).toEqual({ to: "/settings", label: "Open Settings" });
  });

  it("names the sign-in protection fields that changed and links to Settings", () => {
    const view = describeAudit(
      entry("settings.sign_in_changed", { before: { max_failures: 5, block_minutes: 5 }, after: { max_failures: 7, block_minutes: 10 } }),
    );
    expect(view.summary).toBe("Changed the sign-in protection: max failures, block minutes");
    expect(view.changes).toEqual([
      { field: "Max failures", before: "5", after: "7" },
      { field: "Block minutes", before: "5", after: "10" },
    ]);
    expect(view.link).toEqual({ to: "/settings", label: "Open Settings" });
    expect(describeAudit(entry("settings.sign_in_changed", {})).summary).toBe("Changed the sign-in protection");
  });

  it("says when the sign-in protection was switched off or on, and still lists the numbers that changed", () => {
    const off = describeAudit(entry("settings.sign_in_changed", { before: { enabled: true }, after: { enabled: false } }));
    expect(off.summary).toBe("Sign-in protection switched off");
    expect(off.changes).toEqual([{ field: "Enabled", before: "yes", after: "no" }]);
    expect(off.link).toEqual({ to: "/settings", label: "Open Settings" });
    expect(describeAudit(entry("settings.sign_in_changed", { before: { enabled: false }, after: { enabled: true } })).summary).toBe(
      "Sign-in protection switched on",
    );
    const both = describeAudit(
      entry("settings.sign_in_changed", {
        before: { max_failures: 5, block_minutes: 5, enabled: true }, after: { max_failures: 5, block_minutes: 10, enabled: false },
      }),
    );
    expect(both.summary).toBe("Sign-in protection switched off: block minutes");
    expect(both.changes.map((c) => c.field)).toEqual(["Block minutes", "Enabled"]);
    expect(
      describeAudit(entry("settings.sign_in_changed", { before: { max_failures: 5, enabled: true }, after: { max_failures: 8, enabled: true } })).summary,
    ).toBe("Changed the sign-in protection: max failures");
  });

  it("says how many blocks switching the protection off ended, when the subject carries the count", () => {
    const off = (blocks_ended: unknown) =>
      describeAudit(entry("settings.sign_in_changed", { blocks_ended, before: { enabled: true }, after: { enabled: false } })).summary;
    expect(off(3)).toBe("Sign-in protection switched off (3 blocks ended)");
    expect(off(1)).toBe("Sign-in protection switched off (1 block ended)");
    expect(off(0)).toBe("Sign-in protection switched off");
    expect(off("3")).toBe("Sign-in protection switched off");
    expect(off(undefined)).toBe("Sign-in protection switched off");
    const withNumbers = describeAudit(
      entry("settings.sign_in_changed", { blocks_ended: 2, before: { block_minutes: 5, enabled: true }, after: { block_minutes: 10, enabled: false } }),
    );
    expect(withNumbers.summary).toBe("Sign-in protection switched off (2 blocks ended): block minutes");
  });

  it("does not claim a switch when `enabled` is not a real change or not a boolean", () => {
    const same = describeAudit(
      entry("settings.sign_in_changed", { before: { max_failures: 5, enabled: true }, after: { max_failures: 6, enabled: true } }),
    );
    expect(same.summary).toBe("Changed the sign-in protection: max failures");
    const odd = describeAudit(entry("settings.sign_in_changed", { before: { enabled: true }, after: { enabled: "off" } }));
    expect(odd.summary).toBe("Changed the sign-in protection: enabled");
  });

  it("names the field changed on an asset and links to it", () => {
    const view = describeAudit(
      entry("asset.updated", { asset_id: 12, name: "Panel B", before: { name: "Panel A" }, after: { name: "Panel B" } }),
    );
    expect(view.summary).toBe("Changed asset Panel B: name");
    expect(view.changes).toEqual([{ field: "Name", before: "Panel A", after: "Panel B" }]);
    expect(view.link).toEqual({ to: "/assets/12", label: "Open asset Panel B" });
  });

  it("shows an absent side as a dash", () => {
    const view = describeAudit(
      entry("source.updated", { source_id: 2, name: "PM-1", before: { enabled: true }, after: { enabled: false, secret: "changed" } }),
    );
    expect(view.changes).toContainEqual({ field: "Enabled", before: "yes", after: "no" });
    expect(view.changes).toContainEqual({ field: "Secret", before: "—", after: "changed" });
  });

  it("treats the user_id of a user entry as the subject account, not the actor", () => {
    const view = describeAudit(
      entry("user.updated", { user_id: 9, username: "bob", before: { role: "viewer" }, after: { role: "operator" } }),
    );
    expect(view.summary).toBe("Changed the role of bob from viewer to operator");
    expect(view.link).toEqual({ to: "/users", label: "Open Users & Roles" });
  });
});

describe("describeAudit: user.updated reads as what was done to the account", () => {
  const update = (before: Record<string, unknown>, after: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    describeAudit(entry("user.updated", { user_id: 9, username: "bob", before, after, ...extra }));

  it("says a deactivation and a reactivation", () => {
    expect(update({ active: true }, { active: false }).summary).toBe("Deactivated user bob");
    expect(update({ active: false }, { active: true }).summary).toBe("Reactivated user bob");
    expect(update({}, { active: false }).summary).toBe("Deactivated user bob");
  });

  it("says a role change with both roles, and what the new role adds and removes when the entry carries it", () => {
    const given = { added: ["audit.view", "future.thing"], removed: ["billing.view"] };
    expect(update({ role: "viewer" }, { role: "Staff" }, given).summary).toBe(
      "Changed the role of bob from viewer to Staff (adds See the audit log, future.thing; removes See billing)",
    );
    expect(update({ role: "viewer" }, { role: "Staff" }, { added: [], removed: ["billing.view"] }).summary).toBe(
      "Changed the role of bob from viewer to Staff (removes See billing)",
    );
    expect(update({ role: "viewer" }, { role: "Staff" }, { added: [], removed: [] }).summary).toBe("Changed the role of bob from viewer to Staff");
    expect(update({ role: "viewer" }, { role: "admin" }).summary).toBe("Changed the role of bob from viewer to admin");
    expect(update({}, { role: "admin" }).summary).toBe("Changed the role of bob to admin");
  });

  it("says a password reset only for the stored word changed", () => {
    expect(update({ password: "set" }, { password: "changed" }).summary).toBe("Reset the password of bob");
    // "set" on the after side means unchanged (the backend never stores it); it must not read as a reset.
    expect(update({}, { password: "set" }).summary).not.toContain("Reset the password");
  });

  it("joins several in the order role, active, password", () => {
    expect(
      update({ role: "operator", active: true, password: "set" }, { role: "viewer", active: false, password: "changed" }).summary,
    ).toBe("Changed the role of bob from operator to viewer; Deactivated user bob; Reset the password of bob");
    expect(update({ active: false, password: "set" }, { active: true, password: "changed" }).summary).toBe(
      "Reactivated user bob; Reset the password of bob",
    );
  });

  it("never numbers an account whose stored name is missing, and falls back to a generic sentence", () => {
    expect(describeAudit(entry("user.updated", { user_id: 9, before: { active: true }, after: { active: false } })).summary).toBe(
      "Deactivated user",
    );
    expect(describeAudit(entry("user.updated", { before: { role: "viewer" }, after: { role: "admin" } })).summary).toBe(
      "Changed the role of a user from viewer to admin",
    );
  });

  it("keeps the generic sentence when none of the three applies, and the change table in every case", () => {
    const other = update({ nickname: "a" }, { nickname: "b" });
    expect(other.summary).toBe("Changed user bob: nickname");
    expect(update({ active: true }, { active: true, role: "x" }).summary).toBe("Changed the role of bob to x");
    expect(update({ role: "viewer", password: "set" }, { role: "viewer", password: "set" }).summary).toBe("Changed user bob");
    const full = update({ role: "viewer", active: true }, { role: "admin", active: false });
    expect(full.changes).toEqual([
      { field: "Role", before: "viewer", after: "admin" },
      { field: "Active", before: "yes", after: "no" },
    ]);
  });

  it("does not claim a change that the stored sides do not show", () => {
    expect(update({ active: false, role: "viewer" }, { active: false, role: "viewer" }).summary).toBe("Changed user bob");
  });
});

describe("describeAudit: roles", () => {
  const updated = (extra: Record<string, unknown>) =>
    describeAudit(entry("role.updated", { role_id: 4, name: "Executive", ...extra }));

  it("names the permissions a new role was given by their labels, in the order stored", () => {
    const view = describeAudit(
      entry("role.created", {
        role_id: 4, name: "Executive", description: "Board members", permissions: ["assets.view", "billing.view", "billing.export"],
      }),
    );
    expect(view.summary).toBe("Created role Executive: See the Assets Tree, See billing, Export billing as CSV");
    expect(view.link).toEqual({ to: "/users/roles", label: "Open Roles" }); // the Roles tab of Users & Roles
  });

  it("says so when a new role has no permissions, and names the role it was copied from", () => {
    expect(describeAudit(entry("role.created", { role_id: 5, name: "Nobody", description: "", permissions: [] })).summary).toBe(
      "Created role Nobody: no permissions",
    );
    expect(
      describeAudit(
        entry("role.created", { role_id: 6, name: "Copy of operator", permissions: ["assets.view"], copied_from: "operator" }),
      ).summary,
    ).toBe("Created role Copy of operator as a copy of operator: See the Assets Tree");
  });

  it("shows an id this build has no label for as the id, and never reads the prototype", () => {
    const view = describeAudit(
      entry("role.created", { role_id: 4, name: "Odd", permissions: ["assets.view", "future.thing", "constructor", "__proto__", 7, null] }),
    );
    expect(view.summary).toBe("Created role Odd: See the Assets Tree, future.thing, constructor, __proto__, 7, —");
  });

  it("counts the long tail of a long permission list", () => {
    const all = ["assets.view", "assets.edit", "assets.delete", "dashboards.view", "dashboards.edit", "dashboards.default", "billing.view", "billing.export"];
    expect(describeAudit(entry("role.created", { role_id: 4, name: "Wide", permissions: all })).summary).toBe(
      "Created role Wide: See the Assets Tree, Change assets, Delete assets, See dashboards, Change dashboards, " +
        "Choose the default dashboard and 2 more",
    );
  });

  it("says which permissions an edit added and removed, by label", () => {
    const view = updated({
      added: ["billing.export", "tariffs.view"], removed: ["dashboards.view"],
      before: { permissions: ["assets.view", "dashboards.view"] }, after: { permissions: ["assets.view", "billing.export", "tariffs.view"] },
    });
    expect(view.summary).toBe("Changed role Executive: added Export billing as CSV, See tariffs; removed See dashboards");
    expect(view.changes.map((change) => change.field)).toEqual(["Permissions"]);
    expect(view.link).toEqual({ to: "/users/roles", label: "Open Roles" });
  });

  it("says a rename and a new description, and joins everything in the order name, added, removed, description", () => {
    expect(updated({ before: { name: "Execs" }, after: { name: "Executive" } }).summary).toBe("Changed role Executive: renamed from Execs");
    expect(updated({ before: { description: "a" }, after: { description: "b" } }).summary).toBe("Changed role Executive: changed the description");
    expect(
      updated({
        added: ["audit.view"], removed: ["audit.export"],
        before: { name: "Execs", description: "", permissions: [] }, after: { name: "Executive", description: "x", permissions: [] },
      }).summary,
    ).toBe("Changed role Executive: renamed from Execs; added See the audit log; removed Export the audit log; changed the description");
  });

  it("shows an unknown id in an edit as the id", () => {
    expect(updated({ added: ["future.thing"], removed: ["audit.view"] }).summary).toBe(
      "Changed role Executive: added future.thing; removed See the audit log",
    );
  });

  it("falls back to the generic sentence when the entry shows none of the three changes", () => {
    expect(updated({ before: { nickname: "a" }, after: { nickname: "b" } }).summary).toBe("Changed role Executive: nickname");
    expect(updated({ before: { name: "same" }, after: { name: "same" } }).summary).toBe("Changed role Executive");
    expect(describeAudit(entry("role.updated", { role_id: 4 })).summary).toBe("Changed role");
    expect(describeAudit(entry("role.updated", {})).summary).toBe("Changed role");
  });

  it("says a deletion by name, else by the kind alone, without a link", () => {
    const view = describeAudit(entry("role.deleted", { role_id: 4, name: "Executive", permissions: ["assets.view"] }));
    expect(view.summary).toBe("Deleted role Executive");
    expect(view.link).toBeNull();
    expect(describeAudit(entry("role.deleted", { role_id: 4 })).summary).toBe("Deleted role");
  });

  it("works out what an edit added and removed from the permissions before and after when the entry has no lists", () => {
    const view = updated({
      before: { permissions: ["assets.view", "dashboards.view"] }, after: { permissions: ["assets.view", "billing.export", "tariffs.view"] },
    });
    expect(view.summary).toBe("Changed role Executive: added Export billing as CSV, See tariffs; removed See dashboards");
    expect(updated({ before: { permissions: ["assets.view"] }, after: { permissions: [] } }).summary).toBe(
      "Changed role Executive: removed See the Assets Tree",
    );
    expect(updated({ before: { permissions: [] }, after: { permissions: ["future.thing"] } }).summary).toBe(
      "Changed role Executive: added future.thing",
    );
  });

  it("prefers the lists the server wrote, and does not guess from sides that are not lists", () => {
    expect(
      updated({ added: ["audit.view"], removed: [], before: { permissions: ["assets.view"] }, after: { permissions: ["billing.view"] } }).summary,
    ).toBe("Changed role Executive: added See the audit log");
    expect(updated({ before: { permissions: "assets.view" }, after: { permissions: 7 } }).summary).toBe("Changed role Executive: permissions");
    expect(updated({ before: { permissions: ["assets.view", "billing.view"] }, after: { permissions: ["billing.view", "assets.view"] } }).summary).toBe(
      "Changed role Executive: permissions",
    );
  });

  describe("a name in a role sentence is cut at 80 characters", () => {
    const exact = "n".repeat(80);
    const long = "n".repeat(5000);
    const cut = `${exact}…`;

    it("cuts the name of a new role, of the role it was copied from, of an edit and of a deletion", () => {
      expect(describeAudit(entry("role.created", { role_id: 4, name: long, permissions: ["assets.view"], copied_from: long })).summary).toBe(
        `Created role ${cut} as a copy of ${cut}: See the Assets Tree`,
      );
      expect(updated({ name: long, before: { name: long }, after: { name: "Short" } }).summary).toBe(`Changed role ${cut}: renamed from ${cut}`);
      expect(describeAudit(entry("role.deleted", { role_id: 4, name: long })).summary).toBe(`Deleted role ${cut}`);
    });

    it("leaves a name of 80 characters whole and cuts one of 81", () => {
      expect(describeAudit(entry("role.deleted", { role_id: 4, name: exact })).summary).toBe(`Deleted role ${exact}`);
      expect(describeAudit(entry("role.deleted", { role_id: 4, name: `${exact}x` })).summary).toBe(`Deleted role ${cut}`);
    });

    it("counts characters, not UTF-16 units, so a cut never splits an emoji", () => {
      const view = describeAudit(entry("role.deleted", { role_id: 4, name: "😀".repeat(81) }));
      expect(view.summary).toBe(`Deleted role ${"😀".repeat(80)}…`);
    });

    it("does not touch the names in other entries", () => {
      expect(describeAudit(entry("asset.deleted", { asset_id: 1, name: long })).summary).toBe(`Deleted asset ${long}`);
    });
  });

  it("never throws on a role entry with the wrong shapes", () => {
    for (const action of ["role.created", "role.updated", "role.deleted"]) {
      for (const detail of [{ permissions: "assets.view" }, { permissions: {} }, { added: 5, removed: "x" }, { name: 7 }, { copied_from: {} }]) {
        expect(typeof describeAudit(entry(action, detail)).summary).toBe("string");
      }
    }
  });
});

describe("describeAudit: asset kinds", () => {
  const KIND = 90016;
  const renamed = (detail: Record<string, unknown>) => describeAudit(entry("kind.renamed", { kind_id: KIND, ...detail }));
  const iconChanged = (detail: Record<string, unknown>) => describeAudit(entry("kind.icon_changed", { kind_id: KIND, ...detail }));

  it("says a creation and a deletion by name, else by the kind alone, and never shows the id", () => {
    expect(describeAudit(entry("kind.created", { kind_id: KIND, name: "Rack", icon: "rack" })).summary).toBe("Created asset kind Rack");
    expect(describeAudit(entry("kind.created", { kind_id: KIND })).summary).toBe("Created an asset kind");
    expect(describeAudit(entry("kind.deleted", { kind_id: KIND, name: "Rack", icon: "rack" })).summary).toBe("Deleted asset kind Rack");
    expect(describeAudit(entry("kind.deleted", { kind_id: KIND, name: "  " })).summary).toBe("Deleted an asset kind");
  });

  it("says a rename from the two stored names, and how many assets followed", () => {
    const sides = { before: { name: "Rack" }, after: { name: "Racks" } };
    expect(renamed({ assets: 12, ...sides }).summary).toBe("Renamed asset kind Rack to Racks (12 assets follow)");
    expect(renamed({ assets: 1, ...sides }).summary).toBe("Renamed asset kind Rack to Racks (1 asset follows)");
    expect(renamed({ assets: 0, ...sides }).summary).toBe("Renamed asset kind Rack to Racks");
    expect(renamed({ ...sides }).summary).toBe("Renamed asset kind Rack to Racks");
    expect(renamed({ assets: -3, ...sides }).summary).toBe("Renamed asset kind Rack to Racks");
    expect(renamed({ assets: "12", ...sides }).summary).toBe("Renamed asset kind Rack to Racks");
  });

  it("still reads when a side of the rename is missing", () => {
    expect(renamed({ assets: 2, before: {}, after: { name: "Racks" } }).summary).toBe("Renamed an asset kind to Racks (2 assets follow)");
    expect(renamed({ before: { name: "Rack" }, after: {} }).summary).toBe("Renamed asset kind Rack");
    expect(renamed({ assets: 2 }).summary).toBe("Renamed an asset kind (2 assets follow)");
  });

  it("shows the rename as one Name row and the icon change as one Icon row with catalogue labels", () => {
    const rename = renamed({ assets: 3, before: { name: "Rack" }, after: { name: "Racks" } });
    expect(rename.changes).toEqual([{ field: "Name", before: "Rack", after: "Racks" }]);
    const icon = iconChanged({ name: "Racks", before: { icon: "rack" }, after: { icon: "pdu" } });
    expect(icon.changes).toEqual([{ field: "Icon", before: "Rack", after: "PDU" }]);
  });

  it("says an icon change with the catalogue labels, and an id the catalogue lacks as it is stored", () => {
    expect(iconChanged({ name: "Racks", before: { icon: "rack" }, after: { icon: "server" } }).summary).toBe(
      "Changed the icon of asset kind Racks from Rack to Server",
    );
    expect(iconChanged({ name: "Racks", before: { icon: "zzz" }, after: { icon: "server" } }).summary).toBe(
      "Changed the icon of asset kind Racks from zzz to Server",
    );
    expect(iconChanged({ name: "Racks", before: { icon: "server" }, after: { icon: "__proto__" } }).summary).toBe(
      "Changed the icon of asset kind Racks from Server to __proto__",
    );
    expect(iconChanged({ name: "Racks", after: { icon: "server" }, before: {} }).summary).toBe("Changed the icon of asset kind Racks to Server");
    expect(iconChanged({ name: "Racks" }).summary).toBe("Changed the icon of asset kind Racks");
    expect(iconChanged({}).summary).toBe("Changed the icon of an asset kind");
  });

  const starterPack = (detail: unknown) => describeAudit(entry("kind.starter_pack_added", detail));

  it("says the starter pack by the names of the kinds it added, never by an id, and counts the long tail", () => {
    expect(starterPack({ count: 3, names: ["UPS", "Battery", "PDU"] }).summary).toBe("Added 3 data-centre asset kinds: UPS, Battery, PDU");
    expect(starterPack({ count: 1, names: ["Pump"] }).summary).toBe("Added 1 data-centre asset kind: Pump");
    const names = ["UPS", "Battery", "PDU", "RPP", "ATS", "STS", "Switchgear", "Busway", "Ring main unit"];
    expect(starterPack({ count: 9, names }).summary).toBe("Added 9 data-centre asset kinds: UPS, Battery, PDU, RPP, ATS, STS and 3 more");
    expect(starterPack({ count: 3, names: ["UPS", "x".repeat(300)] }).summary).toBe(`Added 3 data-centre asset kinds: UPS, ${"x".repeat(80)}…`);
  });

  it("still reads when the count or the names are missing or are not what they should be", () => {
    expect(starterPack({ names: ["UPS", "Battery"] }).summary).toBe("Added 2 data-centre asset kinds: UPS, Battery");
    expect(starterPack({ count: 36 }).summary).toBe("Added 36 data-centre asset kinds");
    expect(starterPack({}).summary).toBe("Added data-centre asset kinds");
    expect(starterPack({ count: -2, names: "UPS" }).summary).toBe("Added data-centre asset kinds");
    expect(starterPack({ count: "3", names: [7, null, "  ", "Pump", {}] }).summary).toBe("Added 1 data-centre asset kind: Pump");
    expect(starterPack({ count: 1.5, names: {} }).summary).toBe("Added data-centre asset kinds");
  });

  it("links the starter pack to the Asset kinds page and shows no Before/After rows", () => {
    const view = starterPack({ count: 2, names: ["UPS", "Battery"] });
    expect(view.link).toEqual({ to: "/assets/kinds", label: "Open Asset kinds" });
    expect(view.changes).toEqual([]);
  });

  it("links to the Asset kinds page, except from a deletion", () => {
    expect(describeAudit(entry("kind.created", { kind_id: KIND, name: "Rack" })).link).toEqual({ to: "/assets/kinds", label: "Open Asset kinds" });
    expect(renamed({ before: { name: "a" }, after: { name: "b" } }).link).toEqual({ to: "/assets/kinds", label: "Open Asset kinds" });
    expect(iconChanged({ name: "Rack" }).link).toEqual({ to: "/assets/kinds", label: "Open Asset kinds" });
    expect(describeAudit(entry("kind.deleted", { kind_id: KIND, name: "Rack" })).link).toBeNull();
  });

  it("cuts a very long seeded name like a role name and shows markup as text", () => {
    const long = "n".repeat(500);
    expect(describeAudit(entry("kind.created", { kind_id: KIND, name: long })).summary).toBe(`Created asset kind ${"n".repeat(80)}…`);
    expect(describeAudit(entry("kind.deleted", { kind_id: KIND, name: "<img src=x onerror=alert(1)>" })).summary).toBe(
      "Deleted asset kind <img src=x onerror=alert(1)>",
    );
  });

  it("never throws on a kind entry with the wrong shapes", () => {
    for (const action of ["kind.created", "kind.renamed", "kind.icon_changed", "kind.deleted", "kind.starter_pack_added"]) {
      for (const detail of [{}, { name: 7 }, { assets: {} }, { before: 5, after: "x" }, { before: { name: {} }, after: { icon: [] } }, { icon: null }, { count: {}, names: 5 }, { names: [[], {}] }]) {
        expect(typeof describeAudit(entry(action, detail)).summary).toBe("string");
      }
    }
  });
});

describe("describeAudit: custom role names read well in account entries", () => {
  const update = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    describeAudit(entry("user.updated", { user_id: 9, username: "bob", before, after })).summary;

  it("reads a change between custom roles with spaces, capitals and other scripts", () => {
    expect(update({ role: "Night shift" }, { role: "Executive team" })).toBe("Changed the role of bob from Night shift to Executive team");
    expect(update({ role: "viewer" }, { role: "Équipe de nuit" })).toBe("Changed the role of bob from viewer to Équipe de nuit");
    expect(update({ role: "Night shift" }, { role: "admin" })).toBe("Changed the role of bob from Night shift to admin");
  });

  it("reads a role name of the longest length and one that looks like part of the sentence", () => {
    const long = "x".repeat(64);
    expect(update({ role: long }, { role: "viewer" })).toBe(`Changed the role of bob from ${long} to viewer`);
    expect(update({ role: "from" }, { role: "to" })).toBe("Changed the role of bob from from to to");
  });

  it("names the custom role of a new account", () => {
    expect(describeAudit(entry("user.created", { user_id: 3, username: "carol", role: "Night shift", active: true })).summary).toBe(
      "Created user carol (Night shift)",
    );
  });
});

describe("describeAudit: creations, deletions and events", () => {
  it("describes a deleted asset without a link", () => {
    const view = describeAudit(entry("asset.deleted", { asset_id: 5, name: "Panel A", assets: 2, mappings: 3, tariffs: 0 }));
    expect(view.summary).toBe("Deleted asset Panel A");
    expect(view.link).toBeNull();
    expect(view.changes).toEqual([]);
  });

  it("links a created or changed asset to its page and a deleted one to nothing", () => {
    expect(describeAudit(entry("asset.created", { asset_id: 8, name: "Rack 1" })).link).toEqual({
      to: "/assets/8", label: "Open asset Rack 1",
    });
    expect(describeAudit(entry("asset.created", { asset_id: 8, name: "Rack 1" })).summary).toBe("Created asset Rack 1");
    expect(describeAudit(entry("dashboard.deleted", { dashboard_id: 3, name: "Old", widgets: 2 })).link).toBeNull();
    expect(describeAudit(entry("tariff.deleted", { tariff_id: 1, asset_id: null, rate_per_kwh: 0.1, effective_from: "2026-01-01" })).link).toBeNull();
  });

  describe("an asset's icon reads as the catalogue label", () => {
    const update = (before: Record<string, unknown>, after: Record<string, unknown>) =>
      describeAudit(entry("asset.updated", { asset_id: 7, name: "Hall pump", before, after }));

    it("reads null to a chosen icon as Automatic to the label", () => {
      const view = update({ icon: null }, { icon: "server" });
      expect(view.changes).toEqual([{ field: "Icon", before: "Automatic", after: "Server" }]);
      expect(view.summary).toBe("Changed asset Hall pump: icon");
    });

    it("reads one icon to another by both labels, and a cleared icon as Automatic", () => {
      expect(update({ icon: "server" }, { icon: "fueltank" }).changes).toEqual([{ field: "Icon", before: "Server", after: "Fuel tank" }]);
      expect(update({ icon: "ups" }, { icon: null }).changes).toEqual([{ field: "Icon", before: "UPS", after: "Automatic" }]);
    });

    it("treats a missing key as Automatic and shows an id this front end does not know as stored", () => {
      expect(update({}, { icon: "camera" }).changes).toEqual([{ field: "Icon", before: "Automatic", after: "Camera" }]);
      expect(update({ icon: "zzz" }, { icon: null }).changes).toEqual([{ field: "Icon", before: "zzz", after: "Automatic" }]);
      expect(update({ icon: "__proto__" }, { icon: "constructor" }).changes).toEqual([{ field: "Icon", before: "__proto__", after: "constructor" }]);
    });

    it("leaves other fields as they were and counts an unchanged icon as unchanged", () => {
      const view = update({ name: "A", icon: "pump" }, { name: "B", icon: "pump" });
      expect(view.changes).toEqual([{ field: "Name", before: "A", after: "B" }]);
      expect(view.unchanged).toBe(1);
    });

    it("says a created asset in one sentence, whatever its icon; the stored fields are the drawer's JSON block, not a list here", () => {
      const created = (icon: unknown) =>
        describeAudit(entry("asset.created", { asset_id: 8, name: "Rack 1", parent_id: null, kind: "Rack", sort_order: 0, icon }));
      for (const icon of ["server", null, "zzz"]) {
        expect(created(icon).summary).toBe("Created asset Rack 1");
        expect(created(icon).changes).toEqual([]);
      }
    });
  });

  it("links a created mapping and an accepted discovery to the asset, and only from integer ids", () => {
    // No lookup: the link keeps its place, with no name to put in the label, and the sentence says "a point" and "an asset".
    const created = describeAudit(entry("mapping.created", { mapping_id: 4, point_id: 11, asset_id: 7, metric: "power", scale: 1 }));
    expect(created.link).toEqual({ to: "/assets/7", label: "Open asset" });
    expect(created.summary).toBe("Mapped a point to an asset as power");
    const accepted = describeAudit(entry("discovery.accepted", { source_id: 2, asset_id: 15, mappings: 3, created_asset: true }));
    expect(accepted.link).toEqual({ to: "/assets/15", label: "Open asset" });
    expect(accepted.summary).toBe("Accepted discovery: created an asset with 3 mappings");
    expect(describeAudit(entry("discovery.accepted", { asset_id: "7", mappings: 1, created_asset: false })).link).toBeNull();
    expect(describeAudit(entry("mapping.created", { mapping_id: 4, asset_id: "7" })).link).toBeNull();
    expect(describeAudit(entry("asset.updated", { asset_id: 7.5, name: "X", before: { a: 1 }, after: { a: 2 } })).link).toBeNull();
  });

  it("links a changed mapping only when the new asset is in the entry", () => {
    const moved = describeAudit(entry("mapping.updated", { mapping_id: 4, point_id: 11, before: { asset_id: 2 }, after: { asset_id: 7 } }));
    expect(moved.link).toEqual({ to: "/assets/7", label: "Open asset" });
    expect(moved.summary).toBe("Changed the mapping of a point: asset");
    const rescaled = describeAudit(entry("mapping.updated", { mapping_id: 4, point_id: 11, before: { scale: 1 }, after: { scale: 2 } }));
    expect(rescaled.link).toBeNull();
    expect(describeAudit(entry("mapping.updated", { mapping_id: 4, before: { asset_id: "2" }, after: { asset_id: "7" } })).link).toBeNull();
  });

  it("describes scans with their id and status", () => {
    const done = describeAudit(entry("scan.finished", { scan_id: 12, status: "done", hosts: 4, pairs: 8 }));
    expect(done.summary).toBe("Scan #12 finished (done)");
    expect(done.link).toEqual({ to: "/scans", label: "Open Scans" });
    expect(describeAudit(entry("scan.finished", { scan_id: 13, status: "failed", error: "collector restarted" })).summary).toBe(
      "Scan #13 finished (failed)",
    );
    expect(describeAudit(entry("scan.started", { scan_id: 14, scope_name: "Lab", hosts: 4, pairs: 8 })).summary).toBe(
      "Started scan #14 of scope Lab",
    );
  });

  it("describes sign-in events without a link and without inventing a user name", () => {
    for (const action of ["login.failed", "login.locked", "login.succeeded", "password.change_failed", "password.changed"]) {
      const view = describeAudit(entry(action, { via: "login", client: "10.0.0.5" }, { actor_id: null, username: null }));
      expect(view.link).toBeNull();
      expect(view.summary).not.toBe(humanise(action));
    }
  });

  it("says whose sign-in an admin unblocked and links to the Users & Roles page", () => {
    const view = describeAudit(entry("login.unblocked", { user_id: 9, username: "bob", cleared: 2 }));
    expect(view.summary).toBe("Unblocked sign-in for user bob");
    expect(view.link).toEqual({ to: "/users", label: "Open Users & Roles" });
    expect(describeAudit(entry("login.unblocked", { user_id: 9, cleared: 1 })).summary).toBe("Unblocked sign-in for user");
    expect(describeAudit(entry("login.unblocked", {})).summary).toBe("Unblocked sign-in for user");
  });

  it("says a failed sign-in was made to an account, with the stored reason", () => {
    // For these rows the User column is the account that was attacked, not someone who did something.
    const failed = (reason?: string) =>
      describeAudit(entry("login.failed", { via: "login", client: "10.0.0.5", ...(reason ? { reason } : {}) }, { actor_id: 7, username: "bob" }));
    expect(failed("wrong_password").summary).toBe("Failed sign-in to this account (wrong password)");
    expect(failed("account_inactive").summary).toBe("Failed sign-in to this account (account inactive)");
    // No account was found for the typed name, so the sentence does not point at "this account".
    expect(failed("unknown_account").summary).toBe("Failed sign-in to an unknown account");
    expect(describeAudit(entry("login.failed", { via: "login", reason: "unknown_account" })).summary).toBe("Failed sign-in to an unknown account");
    expect(failed().summary).toBe("Failed sign-in to this account");
    expect(failed("some_new_reason").summary).toBe("Failed sign-in to this account (some new reason)");
    expect(describeAudit(entry("login.failed", { via: "login", reason: "" })).summary).toBe("Failed sign-in to this account");
    expect(describeAudit(entry("login.failed", { via: "login", reason: 5 })).summary).toBe("Failed sign-in to this account");
    expect(failed("wrong_password").link).toBeNull();
  });

  it("keeps the lockout wording and adds the reason when there is one", () => {
    const locked = (detail: Record<string, unknown>) => describeAudit(entry("login.locked", detail, { actor_id: 7, username: "bob" })).summary;
    expect(locked({ via: "login", reason: "wrong_password" })).toBe("Sign-in blocked after repeated failures (wrong password)");
    expect(locked({ via: "login", reason: "unknown_account" })).toBe("Sign-in blocked after repeated failures (unknown account)");
    expect(locked({ via: "login" })).toBe("Sign-in blocked after repeated failures");
  });

  it("describes a diagnostics report by how it was asked for, never by its content", () => {
    const report = (detail: unknown) => describeAudit(entry("diagnostics.report", detail));
    expect(report({ detail: "summary", mask: false, source_id: null, parts: 1, chars: 9000 }).summary).toBe(
      "Generated a diagnostics report (summary, not masked)",
    );
    expect(report({ detail: "full", mask: true, source_id: 4, parts: 5, chars: 55000 }).summary).toBe(
      "Generated a diagnostics report (full, masked, a source)", // no lookup: never the id
    );
    expect(report({}).summary).toBe("Generated a diagnostics report (summary, not masked)");
    expect(report({ detail: "summary", mask: false, source_id: 4, parts: 1, chars: 5 }).link).toEqual({ to: "/diagnostics", label: "Open Diagnostics" });
  });

  it("leaves the failed password change as it was", () => {
    expect(describeAudit(entry("password.change_failed", { via: "password_change", client: "10.0.0.5" }, { actor_id: 7, username: "bob" })).summary).toBe(
      "Failed password change (wrong current password)",
    );
  });

  it("describes the source jobs and the user and scope families", () => {
    expect(describeAudit(entry("source.tested", { source_id: 2, name: "PM-1", job_id: 9 })).summary).toBe(
      "Started a connection test of source PM-1",
    );
    expect(describeAudit(entry("source.test_all", { sources: 3, job_ids: [1, 2, 3] })).summary).toBe(
      "Started a connection test of 3 sources",
    );
    expect(describeAudit(entry("source.checked", { source_id: 2, name: "PM-1", job_id: 9 })).summary).toBe(
      "Started a connection check of source PM-1",
    );
    expect(describeAudit(entry("source.checked", { source_id: 2, name: "PM-1", job_id: 9 })).link).toEqual({
      to: "/sources", label: "Open Sources",
    });
    expect(describeAudit(entry("source.browsed", { source_id: 2, name: "PM-1", job_id: 9 })).link).toEqual({
      to: "/sources", label: "Open Sources",
    });
    expect(describeAudit(entry("source.deleted", { source_id: 2, name: "PM-1", points: 4, mappings: 4 })).link).toBeNull();
    expect(describeAudit(entry("user.created", { user_id: 3, username: "carol", role: "operator", active: true })).summary).toBe(
      "Created user carol (operator)",
    );
    expect(describeAudit(entry("user.deleted", { user_id: 3, username: "carol", role: "operator", active: true })).summary).toBe(
      "Deleted user carol",
    );
    expect(describeAudit(entry("user.deleted", { user_id: 3, username: "carol", role: "operator", active: true })).link).toBeNull();
    expect(describeAudit(entry("user.deleted", { user_id: 3 })).summary).toBe("Deleted user");
    expect(describeAudit(entry("scope.created", { scope_id: 1, name: "Lab" })).summary).toBe("Created scan scope Lab");
    expect(describeAudit(entry("scope.deleted", { scope_id: 1, name: "Lab" })).link).toBeNull();
    expect(describeAudit(entry("setup.completed", { username: "admin", role: "admin" })).link).toBeNull();
  });

  it("describes a created tariff by its rate, date and asset", () => {
    expect(
      describeAudit(entry("tariff.created", { tariff_id: 1, asset_id: null, rate_per_kwh: 0.1, effective_from: "2026-01-01" })).summary,
    ).toBe("Created tariff 0.1 per kWh from 2026-01-01 (site default)");
    expect(
      describeAudit(entry("tariff.created", { tariff_id: 2, asset_id: 7, rate_per_kwh: 0.2, effective_from: "2026-02-01" })).summary,
    ).toBe("Created tariff 0.2 per kWh from 2026-02-01 for an asset"); // no lookup: never the id
  });
});

describe("describeAudit: old, odd and unknown rows", () => {
  it("keeps a sentence and no change rows when an update has no before and after", () => {
    const view = describeAudit(entry("tariff.updated", { tariff_id: 3, asset_id: 7, rate_per_kwh: 0.12, effective_from: "2026-01-01" }));
    expect(view.summary).toBe("Changed the tariff for an asset");
    expect(view.changes).toEqual([]);
    expect(view.unchanged).toBe(0);
  });

  it("falls back to the humanised action for an action it does not know", () => {
    const view = describeAudit(entry("foo.bar_baz", { x: 1, name: "n" }));
    expect(view.summary).toBe("Foo bar baz");
    expect(view.link).toBeNull();
    expect(view.changes).toEqual([]);
  });

  it("does not mistake an inherited object key for a known action", () => {
    for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(describeAudit(entry(action, {})).summary).toBe(humanise(action));
    }
  });

  it("copes with nested objects, null values and arrays in the detail", () => {
    const view = describeAudit(entry("scope.updated", {
      scope_id: 1, name: "Lab",
      before: { targets: ["10.0.0.0/24"], ports: [502], meta: { a: null } },
      after: { targets: ["10.0.0.0/24", "10.0.1.0/24"], ports: [502], meta: { a: null } },
    }));
    expect(view.changes).toEqual([
      { field: "Targets", before: '["10.0.0.0/24"]', after: '["10.0.0.0/24","10.0.1.0/24"]' },
    ]);
    expect(view.unchanged).toBe(2);
    const odd = describeAudit(entry("foo.bar", { a: null, b: { c: [1, { d: null }] }, e: [] }));
    expect(odd.summary).toBe("Foo bar");
    expect(odd.changes).toEqual([]);
  });

  it("draws no change rows for a before or after that is not a plain object", () => {
    const view = describeAudit(entry("asset.updated", { asset_id: 1, name: "A", before: "old", after: { name: "B" } }));
    expect(view.changes).toEqual([]);
    expect(view.summary).toBe("Changed asset A");
    const listed = describeAudit(entry("asset.updated", { asset_id: 1, name: "A", before: [1], after: [2] }));
    expect(listed.changes).toEqual([]);
  });

  it("reads keys that are also names on every object as ordinary fields", () => {
    const view = describeAudit(entry("foo.bar", JSON.parse('{"constructor": 1, "__proto__": 2, "before": {"toString": 1}, "after": {"toString": 2}}')));
    expect(view.changes).toEqual([{ field: "ToString", before: "1", after: "2" }]);
  });

  it("never throws and always answers text, whatever the detail is", () => {
    const details: unknown[] = [null, undefined, "text", 7, true, [], [1, 2], {}, { before: null, after: null }, { name: 5, asset_id: {} }];
    for (const action of [...ALL_ACTIONS, "nope", ""]) {
      for (const detail of details) {
        const view = describeAudit(entry(action, detail));
        expect(typeof view.summary).toBe("string");
        expect(Array.isArray(view.changes)).toBe(true);
        expect(typeof view.unchanged).toBe("number");
        expect(view.link === null || (typeof view.link.to === "string" && typeof view.link.label === "string")).toBe(true);
      }
    }
    expect(() => describeAudit(null as unknown as AuditEntry)).not.toThrow();
    expect(() => describeAudit(entry(undefined as unknown as string, {}))).not.toThrow();
  });

  it("has a sentence of its own for every action the backend writes", () => {
    expect(ALL_ACTIONS).toHaveLength(50);
    for (const action of ALL_ACTIONS) {
      expect(describeAudit(entry(action, {})).summary, action).not.toBe(humanise(action));
    }
  });

  it("returns text only: markup in a stored value stays a plain string", () => {
    const view = describeAudit(entry("asset.deleted", { asset_id: 1, name: "<img src=x onerror=alert(1)>" }));
    expect(view.summary).toBe("Deleted asset <img src=x onerror=alert(1)>");
    expect(typeof view.summary).toBe("string");
    expect(view.link).toBeNull();
  });

  it("builds a link path from an integer only, whatever else the detail holds", () => {
    const view = describeAudit(entry("asset.created", { asset_id: 3, name: "../../login" }));
    expect(view.link?.to).toBe("/assets/3");
  });
});

describe("describeAudit: names instead of ids (refs)", () => {
  const refs = {
    asset: { "5": "MV2-R1-LV-Panel-02", "6": "Hall 2" },
    point: { "11": "Voltage L1" },
    source: { "2": "PM-1" },
    user: { "9": "bob" },
    dashboard: { "4": "Ops", "7": "Plant" },
  };
  const withRefs = (action: string, detail: unknown) => describeAudit(entry(action, detail, { refs }));
  const gone = (action: string, detail: unknown) => describeAudit(entry(action, detail, { refs: {} }));
  const noLookup = (action: string, detail: unknown) => describeAudit(entry(action, detail));
  const tariff = { tariff_id: 3, asset_id: 5, rate_per_kwh: 0.16, effective_from: "2026-10-13" };

  describe("tariffs", () => {
    it("names the asset in the sentence from the owner's screenshot", () => {
      const view = withRefs("tariff.created", tariff);
      expect(view.summary).toBe("Created tariff 0.16 per kWh from 2026-10-13 for asset MV2-R1-LV-Panel-02");
      expect(view.link).toEqual({ to: "/tariffs", label: "Open Tariffs" });
    });

    it("says 'a deleted asset' when the lookup cannot find it, and 'an asset' when no lookup was made", () => {
      expect(gone("tariff.created", tariff).summary).toBe("Created tariff 0.16 per kWh from 2026-10-13 for a deleted asset");
      expect(noLookup("tariff.created", tariff).summary).toBe("Created tariff 0.16 per kWh from 2026-10-13 for an asset");
      expect(gone("tariff.deleted", tariff).summary).toBe("Deleted tariff 0.16 per kWh from 2026-10-13 for a deleted asset");
      expect(withRefs("tariff.deleted", tariff).summary).toBe("Deleted tariff 0.16 per kWh from 2026-10-13 for asset MV2-R1-LV-Panel-02");
    });

    it("keeps '(site default)' for a tariff of no asset, and 'a deleted asset' only where an asset id was stored", () => {
      const site = { tariff_id: 1, asset_id: null, rate_per_kwh: 0.1, effective_from: "2026-01-01" };
      expect(gone("tariff.created", site).summary).toBe("Created tariff 0.1 per kWh from 2026-01-01 (site default)");
      expect(withRefs("tariff.created", site).summary).toBe("Created tariff 0.1 per kWh from 2026-01-01 (site default)");
    });

    it("names which tariff an update changed", () => {
      const change = { before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } };
      expect(withRefs("tariff.updated", { tariff_id: 3, asset_id: 5, ...change }).summary).toBe(
        "Changed the tariff for asset MV2-R1-LV-Panel-02: rate per kwh",
      );
      expect(gone("tariff.updated", { tariff_id: 3, asset_id: 5, ...change }).summary).toBe("Changed the tariff for a deleted asset: rate per kwh");
      expect(noLookup("tariff.updated", { tariff_id: 3, asset_id: 5, ...change }).summary).toBe("Changed the tariff for an asset: rate per kwh");
      expect(withRefs("tariff.updated", { tariff_id: 3, asset_id: null, ...change }).summary).toBe("Changed the site default tariff: rate per kwh");
      expect(withRefs("tariff.updated", { tariff_id: 3, ...change }).summary).toBe("Changed a tariff: rate per kwh");
      expect(withRefs("tariff.updated", { tariff_id: 3 }).summary).toBe("Changed a tariff");
    });
  });

  describe("discovery, diagnostics and mappings", () => {
    it("names the asset a discovery was accepted into, and links to it only while it exists", () => {
      const added = { source_id: 2, asset_id: 6, mappings: 3, created_asset: false };
      expect(withRefs("discovery.accepted", added).summary).toBe("Accepted discovery: added 3 mappings to asset Hall 2");
      expect(withRefs("discovery.accepted", added).link).toEqual({ to: "/assets/6", label: "Open asset Hall 2" });
      expect(withRefs("discovery.accepted", { ...added, created_asset: true }).summary).toBe("Accepted discovery: created asset Hall 2 with 3 mappings");
      expect(gone("discovery.accepted", added).summary).toBe("Accepted discovery: added 3 mappings to a deleted asset");
      expect(gone("discovery.accepted", added).link).toBeNull();
      expect(noLookup("discovery.accepted", added).summary).toBe("Accepted discovery: added 3 mappings to an asset");
      expect(withRefs("discovery.accepted", { mappings: 1 }).summary).toBe("Accepted discovery: added 1 mapping to an asset");
    });

    it("names the source a diagnostics report was limited to", () => {
      const report = { detail: "full", mask: true, source_id: 2, parts: 2, chars: 10 };
      expect(withRefs("diagnostics.report", report).summary).toBe("Generated a diagnostics report (full, masked, source PM-1)");
      expect(gone("diagnostics.report", report).summary).toBe("Generated a diagnostics report (full, masked, a deleted source)");
      expect(withRefs("diagnostics.report", { ...report, source_id: null }).summary).toBe("Generated a diagnostics report (full, masked)");
    });

    it("describes a mapping by its point and asset, never by its own number", () => {
      const created = { mapping_id: 4, point_id: 11, asset_id: 5, metric: "power", scale: 1 };
      expect(withRefs("mapping.created", created).summary).toBe("Mapped point Voltage L1 to asset MV2-R1-LV-Panel-02 as power");
      expect(gone("mapping.created", created).summary).toBe("Mapped a deleted point to a deleted asset as power");
      expect(withRefs("mapping.created", { mapping_id: 4 }).summary).toBe("Created a mapping");
      expect(withRefs("mapping.created", created).link).toEqual({ to: "/assets/5", label: "Open asset MV2-R1-LV-Panel-02" });
      expect(gone("mapping.created", created).link).toBeNull();

      const moved = { mapping_id: 4, point_id: 11, before: { asset_id: 6, scale: 1 }, after: { asset_id: 5, scale: 2 } };
      const view = withRefs("mapping.updated", moved);
      expect(view.summary).toBe("Changed the mapping of point Voltage L1: asset, scale");
      expect(view.changes).toEqual([
        { field: "Asset", before: "Hall 2", after: "MV2-R1-LV-Panel-02" },
        { field: "Scale", before: "1", after: "2" },
      ]);
      expect(view.link).toEqual({ to: "/assets/5", label: "Open asset MV2-R1-LV-Panel-02" });
      expect(withRefs("mapping.updated", { mapping_id: 4, before: { scale: 1 }, after: { scale: 2 } }).summary).toBe("Changed a mapping: scale");

      expect(withRefs("mapping.deleted", { mapping_id: 4, point_id: 11, asset_id: 5, metric: "power" }).summary).toBe(
        "Deleted the mapping of point Voltage L1 to asset MV2-R1-LV-Panel-02",
      );
      expect(gone("mapping.deleted", { mapping_id: 4, point_id: 11, asset_id: 5 }).summary).toBe("Deleted the mapping of a deleted point to a deleted asset");
      expect(withRefs("mapping.deleted", { mapping_id: 4 }).summary).toBe("Deleted a mapping");
      expect(withRefs("mapping.deleted", { mapping_id: 4, point_id: 11 }).link).toBeNull();
    });
  });

  describe("accounts and sources", () => {
    it("names an account that the entry carries only as an id", () => {
      expect(withRefs("login.unblocked", { user_id: 9, cleared: 2 }).summary).toBe("Unblocked sign-in for user bob");
      expect(gone("login.unblocked", { user_id: 9, cleared: 2 }).summary).toBe("Unblocked sign-in for a deleted user");
      expect(withRefs("user.created", { user_id: 9, role: "viewer" }).summary).toBe("Created user bob (viewer)");
      const update = (extra: object) => ({ user_id: 9, ...extra });
      expect(withRefs("user.updated", update({ before: { role: "viewer" }, after: { role: "admin" } })).summary).toBe("Changed the role of bob from viewer to admin");
      expect(gone("user.updated", update({ before: { role: "viewer" }, after: { role: "admin" } })).summary).toBe("Changed the role of a deleted user from viewer to admin");
      expect(gone("user.updated", update({ before: { active: true }, after: { active: false } })).summary).toBe("Deactivated a deleted user");
      expect(withRefs("user.updated", update({ before: { active: true }, after: { active: false } })).summary).toBe("Deactivated user bob");
      expect(gone("user.updated", update({ before: { password: "set" }, after: { password: "changed" } })).summary).toBe("Reset the password of a deleted user");
    });

    it("names a source the entry carries only as an id", () => {
      expect(withRefs("source.tested", { source_id: 2, job_id: 9 }).summary).toBe("Started a connection test of source PM-1");
      expect(withRefs("source.checked", { source_id: 2 }).summary).toBe("Started a connection check of source PM-1");
      expect(gone("source.browsed", { source_id: 2 }).summary).toBe("Started a browse of a deleted source");
      expect(noLookup("source.browsed", { source_id: 2 }).summary).toBe("Started a browse of source");
    });

    it("never numbers a role, a scan scope or a deleted record", () => {
      expect(withRefs("role.updated", { role_id: 4 }).summary).toBe("Changed role");
      expect(withRefs("scope.created", { scope_id: 3 }).summary).toBe("Created scan scope");
      expect(withRefs("scope.deleted", { scope_id: 3 }).summary).toBe("Deleted scan scope");
      expect(gone("user.deleted", { user_id: 9 }).summary).toBe("Deleted user"); // gone by definition: not "a deleted user"
      expect(gone("source.deleted", { source_id: 2 }).summary).toBe("Deleted source");
    });
  });

  describe("the stored name wins (R2)", () => {
    it("keeps the name an entry was written with, even when the lookup knows another", () => {
      const asset = { asset_id: 5, name: "Panel A", before: { name: "Pan" }, after: { name: "Panel A" } };
      expect(withRefs("asset.deleted", { asset_id: 5, name: "Panel A" }).summary).toBe("Deleted asset Panel A");
      expect(withRefs("asset.updated", asset).summary).toBe("Changed asset Panel A: name");
      expect(withRefs("asset.updated", asset).link).toEqual({ to: "/assets/5", label: "Open asset Panel A" });
      expect(withRefs("source.updated", { source_id: 2, name: "Old name", before: { enabled: true }, after: { enabled: false } }).summary).toBe(
        "Changed source Old name: enabled",
      );
      expect(withRefs("login.unblocked", { user_id: 9, username: "robert" }).summary).toBe("Unblocked sign-in for user robert");
    });

    it("names an asset the lookup knows when the entry stored no name, and drops the link when it is gone (R6)", () => {
      expect(withRefs("asset.updated", { asset_id: 5, before: { kind: "a" }, after: { kind: "b" } }).summary).toBe(
        "Changed asset MV2-R1-LV-Panel-02: kind",
      );
      expect(withRefs("asset.updated", { asset_id: 5, before: { kind: "a" }, after: { kind: "b" } }).link).toEqual({
        to: "/assets/5", label: "Open asset MV2-R1-LV-Panel-02",
      });
      expect(gone("asset.updated", { asset_id: 5, name: "Panel A", before: { kind: "a" }, after: { kind: "b" } }).summary).toBe(
        "Changed asset Panel A: kind", // the stored name still reads
      );
      expect(gone("asset.updated", { asset_id: 5, name: "Panel A", before: { kind: "a" }, after: { kind: "b" } }).link).toBeNull();
      expect(gone("asset.created", { asset_id: 5, name: "Panel A" }).link).toBeNull();
      expect(gone("dashboard.created", { dashboard_id: 4, name: "Ops" }).link).toBeNull();
      expect(withRefs("dashboard.created", { dashboard_id: 4, name: "Ops" }).link).toEqual({ to: "/dashboards/4", label: "Open dashboard Ops" });
      // Without a lookup nothing is known to be gone, so the link stays, with no name when the entry stored none.
      expect(noLookup("asset.updated", { asset_id: 5, before: { kind: "a" }, after: { kind: "b" } }).link).toEqual({ to: "/assets/5", label: "Open asset" });
    });
  });

  describe("the default dashboard", () => {
    const side = (id: number | null, name?: string | null) => ({ dashboard_id: id, ...(name === undefined ? {} : { dashboard: name }) });

    it("keeps the stored names, and falls back to the lookup for a side that has only an id", () => {
      expect(withRefs("dashboard.default_changed", { before: side(4, "Ops"), after: side(7, "Plant") }).summary).toBe(
        "Changed the default dashboard from Ops to Plant",
      );
      expect(withRefs("dashboard.default_changed", { before: side(4), after: side(7) }).summary).toBe("Changed the default dashboard from Ops to Plant");
      expect(withRefs("dashboard.default_changed", { before: side(null), after: side(7) }).summary).toBe("Made dashboard Plant the default dashboard");
      expect(gone("dashboard.default_changed", { before: side(4), after: side(7) }).summary).toBe(
        "Changed the default dashboard from a deleted dashboard to a deleted dashboard",
      );
      expect(gone("dashboard.default_changed", { before: side(null), after: side(7) }).summary).toBe("Made a deleted dashboard the default dashboard");
      expect(gone("dashboard.default_changed", { before: side(4), after: side(null) }).summary).toBe("Cleared the default dashboard (was a deleted dashboard)");
    });

    it("links to the new default only while it exists", () => {
      expect(withRefs("dashboard.default_changed", { before: side(4, "Ops"), after: side(7, "Plant") }).link).toEqual({
        to: "/dashboards/7", label: "Open dashboard Plant",
      });
      expect(gone("dashboard.default_changed", { before: side(4, "Ops"), after: side(7, "Plant") }).link).toBeNull();
    });

    it("shows one row for the dashboard, not the name and then the id", () => {
      const view = withRefs("dashboard.default_changed", { before: side(4, "Ops"), after: side(7, "Plant") });
      expect(view.changes).toEqual([{ field: "Dashboard", before: "Ops", after: "Plant" }]);
      // Without the name field the id row is the only one and reads as the name.
      expect(withRefs("dashboard.default_changed", { before: side(4), after: side(7) }).changes).toEqual([
        { field: "Dashboard", before: "Ops", after: "Plant" },
      ]);
    });
  });

  describe("the Before / After table", () => {
    it("shows a moved asset's parents by name, never the asset's own stored name, and 'a deleted asset' for a parent that is gone", () => {
      const move = { asset_id: 5, name: "Panel B", before: { parent_id: 6 }, after: { parent_id: 5 } };
      expect(withRefs("asset.updated", move).changes).toEqual([{ field: "Parent asset", before: "Hall 2", after: "MV2-R1-LV-Panel-02" }]);
      expect(withRefs("asset.updated", move).summary).toBe("Changed asset Panel B: parent asset");
      expect(gone("asset.updated", move).changes).toEqual([{ field: "Parent asset", before: "a deleted asset", after: "a deleted asset" }]);
      expect(noLookup("asset.updated", move).changes).toEqual([{ field: "Parent asset", before: "an asset", after: "an asset" }]);
    });

    it("shows no parent as a dash", () => {
      const view = withRefs("asset.updated", { asset_id: 5, name: "P", before: { parent_id: null }, after: { parent_id: 6 } });
      expect(view.changes).toEqual([{ field: "Parent asset", before: "—", after: "Hall 2" }]);
      expect(withRefs("asset.updated", { asset_id: 5, name: "P", before: {}, after: { parent_id: 6 } }).changes).toEqual([
        { field: "Parent asset", before: "—", after: "Hall 2" },
      ]);
    });

    it("labels each id field without the word id", () => {
      const view = withRefs("foo.bar", {
        before: { user_id: 9, source_id: 2, point_id: 11, dashboard_id: 4 }, after: { user_id: 1, source_id: 3, point_id: 12, dashboard_id: 7 },
      });
      expect(view.changes).toEqual([
        { field: "User", before: "bob", after: "a deleted user" },
        { field: "Source", before: "PM-1", after: "a deleted source" },
        { field: "Point", before: "Voltage L1", after: "a deleted point" },
        { field: "Dashboard", before: "Ops", after: "Plant" },
      ]);
    });

    it("shows a value that is not an id as it is stored", () => {
      const view = withRefs("foo.bar", { before: { asset_id: "5" }, after: { asset_id: 0 } });
      expect(view.changes).toEqual([{ field: "Asset", before: "5", after: "0" }]);
    });

    it("does not treat a field named like an object method as an id field", () => {
      expect(withRefs("foo.bar", JSON.parse('{"before": {"constructor": 5}, "after": {"constructor": 6}}')).changes).toEqual([
        { field: "Constructor", before: "5", after: "6" },
      ]);
    });
  });

  describe("a lookup that is missing or malformed", () => {
    const task = { tariff_id: 3, asset_id: 5, rate_per_kwh: 0.16, effective_from: "2026-10-13" };

    it("tells no lookup (undefined) from an empty one ({})", () => {
      expect(describeAudit(entry("tariff.created", task)).summary).toContain("for an asset");
      expect(describeAudit(entry("tariff.created", task, { refs: {} })).summary).toContain("for a deleted asset");
      expect(describeAudit(entry("tariff.created", task, { refs: undefined })).summary).toContain("for an asset");
    });

    it("treats a refs value that is not an object as no lookup, and a kind that is not an object, or a blank name, as gone", () => {
      for (const refs of [null, "x", 5, ["asset"]]) {
        expect(describeAudit(entry("tariff.created", task, { refs: refs as never })).summary).toContain("for an asset");
      }
      for (const asset of [null, "x", ["MV"], { "5": "" }, { "5": "  " }, { "5": 7 }, { "6": "Hall 2" }]) {
        expect(describeAudit(entry("tariff.created", task, { refs: { asset } as never })).summary).toContain("for a deleted asset");
      }
      expect(describeAudit(entry("tariff.created", task, { refs: { user: { "5": "bob" } } })).summary).toContain("for a deleted asset"); // another kind
    });

    it("reads only its own keys of a lookup", () => {
      const inherited = JSON.parse('{"asset": {"__proto__": "x", "constructor": "y"}}');
      expect(describeAudit(entry("tariff.created", task, { refs: inherited })).summary).toContain("for a deleted asset");
    });
  });

  it("answers a summary, the changes, the unchanged count and a link, and no list of stored fields (the drawer's JSON block shows those)", () => {
    for (const view of [withRefs("tariff.created", tariff), describeAudit(entry("foo.bar", { a: 1 })), describeAudit(null as unknown as AuditEntry)]) {
      expect(Object.keys(view).sort()).toEqual(["changes", "link", "summary", "unchanged"]);
    }
  });
});

describe("describeAudit: no sentence shows an id", () => {
  // Distinctive ids, so a leaked one is found by its digits: a plain "7" would pass a /#\d+/ check.
  const A = 90001, PARENT = 90002, USER = 90003, SRC = 90004, DASH = 90005, POINT = 90006, MAPPING = 90007, TARIFF = 90008;
  const ROLE = 90009, SCOPE = 90010, JOB = 90011, SCAN = 90012, A2 = 90013, A3 = 90014, DASH2 = 90015, KIND = 90016;
  const connection = { via: "login", client: "10.0.0.5" };

  // The shape each backend writer stores (see the audit calls in backend/dcdash/api).
  const FIXTURES: Record<string, unknown> = {
    "asset.created": { asset_id: A, name: "Rack 1", parent_id: PARENT, kind: "Rack", sort_order: 0, icon: null },
    "asset.updated": { asset_id: A, name: "Rack 1", before: { parent_id: A2, name: "Rack" }, after: { parent_id: A3, name: "Rack 1" } },
    "asset.deleted": { asset_id: A, name: "Rack 1", assets: 1, mappings: 2, tariffs: 0 },
    "billing.currency_changed": { before: { currency: "QAR" }, after: { currency: "USD" } },
    "dashboard.created": { dashboard_id: DASH, name: "Ops", widgets: 0 },
    "dashboard.updated": { dashboard_id: DASH, name: "Ops", before: { name: "O", widgets: 1 }, after: { name: "Ops", widgets: 2 } },
    "dashboard.deleted": { dashboard_id: DASH, name: "Ops", widgets: 2, was_default: true },
    "dashboard.default_changed": { before: { dashboard_id: DASH, dashboard: "Ops" }, after: { dashboard_id: DASH2, dashboard: "Plant" } },
    "diagnostics.report": { detail: "full", mask: true, source_id: SRC, parts: 2, chars: 100 },
    "discovery.accepted": { source_id: SRC, asset_id: A, mappings: 3, created_asset: true },
    "kind.created": { kind_id: KIND, name: "Rack", icon: "rack" },
    "kind.renamed": { kind_id: KIND, assets: 12, before: { name: "Rack" }, after: { name: "Racks" } },
    "kind.icon_changed": { kind_id: KIND, name: "Racks", before: { icon: "rack" }, after: { icon: "server" } },
    "kind.deleted": { kind_id: KIND, name: "Racks", icon: "server" },
    "kind.starter_pack_added": { count: 3, names: ["UPS", "Battery", "PDU"] },
    "login.failed": { ...connection, reason: "wrong_password" },
    "login.locked": { ...connection, reason: "wrong_password" },
    "login.succeeded": { client: "10.0.0.5" },
    "login.unblocked": { user_id: USER, username: "bob", cleared: 2 },
    "mapping.created": { mapping_id: MAPPING, point_id: POINT, asset_id: A, metric: "power", scale: 1 },
    "mapping.updated": { mapping_id: MAPPING, point_id: POINT, before: { asset_id: A2, scale: 1 }, after: { asset_id: A3, scale: 2 } },
    "mapping.deleted": { mapping_id: MAPPING, point_id: POINT, asset_id: A, metric: "power" },
    "password.change_failed": connection,
    "password.changed": { other_sessions_signed_out: 1 },
    "role.created": { role_id: ROLE, name: "Exec", description: "", permissions: ["assets.view"], copied_from: "operator" },
    "role.updated": { role_id: ROLE, name: "Exec", before: { name: "E", permissions: [] }, after: { name: "Exec", permissions: ["assets.view"] } },
    "role.deleted": { role_id: ROLE, name: "Exec", permissions: [] },
    "scan.finished": { scan_id: SCAN, status: "done" },
    "scan.started": { scan_id: SCAN, scope_name: "Lab", hosts: 4 },
    "scope.created": { scope_id: SCOPE, name: "Lab" },
    "scope.updated": { scope_id: SCOPE, name: "Lab", before: { ports: [502] }, after: { ports: [502, 503] } },
    "scope.deleted": { scope_id: SCOPE, name: "Lab" },
    "settings.sign_in_changed": { blocks_ended: 2, before: { enabled: true, max_failures: 5 }, after: { enabled: false, max_failures: 6 } },
    "settings.timezone_changed": { before: { timezone: "UTC" }, after: { timezone: "Asia/Qatar" } },
    "setup.completed": { username: "admin", role: "admin" },
    "source.browsed": { source_id: SRC, name: "PM-1", job_id: JOB },
    "source.checked": { source_id: SRC, name: "PM-1", job_id: JOB },
    "source.created": { source_id: SRC, connector_type: "modbus", name: "PM-1", enabled: true },
    "source.deleted": { source_id: SRC, name: "PM-1", points: 4, mappings: 4 },
    "source.test_all": { sources: 3, job_ids: [JOB, JOB + 1] },
    "source.tested": { source_id: SRC, name: "PM-1", job_id: JOB },
    "source.updated": { source_id: SRC, name: "PM-1", before: { enabled: true }, after: { enabled: false } },
    "storage.changed": { before: { raw_retention_days: 30 }, after: { raw_retention_days: 60 } },
    "storage.default_set": {},
    "tariff.created": { tariff_id: TARIFF, asset_id: A, rate_per_kwh: 0.16, effective_from: "2026-10-13" },
    "tariff.updated": { tariff_id: TARIFF, asset_id: A, before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } },
    "tariff.deleted": { tariff_id: TARIFF, asset_id: A, rate_per_kwh: 0.16, effective_from: "2026-10-13" },
    "user.created": { user_id: USER, username: "bob", role: "viewer", active: true },
    "user.updated": { user_id: USER, username: "bob", before: { role: "viewer", active: true }, after: { role: "admin", active: false } },
    "user.deleted": { user_id: USER, username: "bob", role: "viewer", active: true },
  };

  const present = {
    asset: { [A]: "Panel A", [PARENT]: "Hall 1", [A2]: "Hall 2", [A3]: "Hall 3" },
    user: { [USER]: "robert" }, source: { [SRC]: "Meter 1" }, dashboard: { [DASH]: "Overview", [DASH2]: "Plant" }, point: { [POINT]: "Voltage L1" },
  };

  // The same entry with every name it stored taken out: an old entry, or one whose writer did not keep the name.
  const withoutNames = (detail: unknown): unknown => {
    const strip = (value: Record<string, unknown>) => {
      const copy = { ...value };
      for (const key of ["name", "username", "dashboard", "scope_name", "copied_from"]) delete copy[key];
      return copy;
    };
    const copy = strip(detail as Record<string, unknown>);
    for (const side of ["before", "after"]) {
      if (typeof copy[side] === "object" && copy[side] !== null) copy[side] = strip(copy[side] as Record<string, unknown>);
    }
    return copy;
  };

  it("has a fixture for every action the backend writes", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...ALL_ACTIONS].sort());
  });

  it("shows none of the 16 distinctive ids in a sentence, a link label or a Before/After cell, with every lookup state and with or without stored names", () => {
    for (const action of ALL_ACTIONS) {
      for (const detail of [FIXTURES[action], withoutNames(FIXTURES[action])]) {
        for (const refs of [present, {}, undefined]) {
          const view = describeAudit(entry(action, detail, { refs }));
          // The Scan numbers are the one id a sentence keeps: the Scans page shows them as "Scan #N" too.
          const shown = [view.summary, view.link?.label ?? "", ...view.changes.flatMap((c) => [c.field, c.before, c.after])]
            .join("\n")
            .replaceAll(`Scan #${SCAN}`, "Scan")
            .replaceAll(`scan #${SCAN}`, "scan");
          const where = `${action} (${refs === undefined ? "no lookup" : refs === present ? "names" : "gone"}): ${shown}`;
          expect(shown, where).not.toMatch(/900\d\d/);
          expect(shown, where).not.toMatch(/#\d/);
        }
      }
    }
  });

  it("keeps the Scan numbers, which the Scans page shows too", () => {
    expect(describeAudit(entry("scan.finished", FIXTURES["scan.finished"])).summary).toBe(`Scan #${SCAN} finished (done)`);
    expect(describeAudit(entry("scan.started", FIXTURES["scan.started"])).summary).toBe(`Started scan #${SCAN} of scope Lab`);
  });

  it("names the targets in the sentences that carry only ids, when the lookup knows them", () => {
    const say = (action: string) => describeAudit(entry(action, withoutNames(FIXTURES[action]), { refs: present })).summary;
    expect(say("tariff.created")).toBe("Created tariff 0.16 per kWh from 2026-10-13 for asset Panel A");
    expect(say("mapping.created")).toBe("Mapped point Voltage L1 to asset Panel A as power");
    expect(say("discovery.accepted")).toBe("Accepted discovery: created asset Panel A with 3 mappings");
    expect(say("diagnostics.report")).toBe("Generated a diagnostics report (full, masked, source Meter 1)");
    expect(say("login.unblocked")).toBe("Unblocked sign-in for user robert");
    expect(say("user.updated")).toBe("Changed the role of robert from viewer to admin; Deactivated user robert");
    expect(say("source.tested")).toBe("Started a connection test of source Meter 1");
    expect(say("dashboard.default_changed")).toBe("Changed the default dashboard from Overview to Plant");
  });
});
