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
  it("shows a tariff change as a sentence and one change row, with the subject as facts", () => {
    const view = describeAudit(
      entry("tariff.updated", { tariff_id: 3, asset_id: 7, before: { rate_per_kwh: 0.1 }, after: { rate_per_kwh: 0.12 } }),
    );
    expect(view.summary).toBe("Changed tariff #3: rate per kwh");
    expect(view.changes).toEqual([{ field: "Rate per kwh", before: "0.1", after: "0.12" }]);
    expect(view.unchanged).toBe(0);
    expect(view.facts).toEqual([
      { label: "Tariff id", value: "3" },
      { label: "Asset id", value: "7" },
    ]);
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
    expect(view.facts).toEqual([
      { label: "Policies reapplied", value: "yes" },
      { label: "Origin", value: "manual" },
    ]);
    expect(view.link).toEqual({ to: "/storage", label: "Open Storage" });
  });

  it("says the policies were re-applied when a storage save changed no value, and keeps the nested loss as a fact", () => {
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
    expect(view.facts).toContainEqual({ label: "Confirmed loss", value: '{"shorter":true,"raw_chunks":4,"rollup_1m_chunks":0}' });
    expect(view.facts).toContainEqual({ label: "Origin", value: "factory" });
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
    expect(withNumbers.facts).toEqual([{ label: "Blocks ended", value: "2" }]);
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
    expect(view.facts).toEqual([
      { label: "Account id", value: "9" },
      { label: "Username", value: "bob" },
    ]);
    expect(view.link).toEqual({ to: "/users", label: "Open Users" });
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

  it("names the account by id when the stored name is missing, and falls back to a generic sentence", () => {
    expect(describeAudit(entry("user.updated", { user_id: 9, before: { active: true }, after: { active: false } })).summary).toBe(
      "Deactivated user #9",
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
    expect(view.link).toBeNull();
    expect(view.facts.map((fact) => fact.label)).toEqual(["Role id", "Name", "Description", "Permissions"]);
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
    expect(view.link).toBeNull();
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
    expect(describeAudit(entry("role.updated", { role_id: 4 })).summary).toBe("Changed role #4");
    expect(describeAudit(entry("role.updated", {})).summary).toBe("Changed role");
  });

  it("says a deletion by name, else by id, without a link", () => {
    const view = describeAudit(entry("role.deleted", { role_id: 4, name: "Executive", permissions: ["assets.view"] }));
    expect(view.summary).toBe("Deleted role Executive");
    expect(view.link).toBeNull();
    expect(describeAudit(entry("role.deleted", { role_id: 4 })).summary).toBe("Deleted role #4");
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
    expect(view.facts).toContainEqual({ label: "Mappings", value: "3" });
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

    it("shows the icon of a created asset as its label, Automatic for null, the raw id when unknown", () => {
      const created = (icon: unknown) =>
        describeAudit(entry("asset.created", { asset_id: 8, name: "Rack 1", parent_id: null, kind: "Rack", sort_order: 0, icon }));
      const fact = (view: ReturnType<typeof describeAudit>) => view.facts.find((f) => f.label === "Icon");
      expect(fact(created("server"))).toEqual({ label: "Icon", value: "Server" });
      expect(fact(created(null))).toEqual({ label: "Icon", value: "Automatic" });
      expect(fact(created("zzz"))).toEqual({ label: "Icon", value: "zzz" });
      expect(created("server").facts).toContainEqual({ label: "Kind", value: "Rack" });
      expect(created("server").summary).toBe("Created asset Rack 1");
    });

    it("shows no Icon fact for an older created row that has no icon key", () => {
      const view = describeAudit(entry("asset.created", { asset_id: 8, name: "Rack 1", kind: "Rack" }));
      expect(view.facts.map((f) => f.label)).toEqual(["Asset id", "Name", "Kind"]);
    });
  });

  it("links a created mapping and an accepted discovery to the asset, and only from integer ids", () => {
    const created = describeAudit(entry("mapping.created", { mapping_id: 4, point_id: 11, asset_id: 7, metric: "power", scale: 1 }));
    expect(created.link).toEqual({ to: "/assets/7", label: "Open asset #7" });
    expect(created.summary).toBe("Mapped point #11 to asset #7 as power");
    const accepted = describeAudit(entry("discovery.accepted", { source_id: 2, asset_id: 15, mappings: 3, created_asset: true }));
    expect(accepted.link).toEqual({ to: "/assets/15", label: "Open asset #15" });
    expect(accepted.summary).toBe("Accepted discovery: created asset #15 with 3 mappings");
    expect(describeAudit(entry("discovery.accepted", { asset_id: "7", mappings: 1, created_asset: false })).link).toBeNull();
    expect(describeAudit(entry("mapping.created", { mapping_id: 4, asset_id: "7" })).link).toBeNull();
    expect(describeAudit(entry("asset.updated", { asset_id: 7.5, name: "X", before: { a: 1 }, after: { a: 2 } })).link).toBeNull();
  });

  it("links a changed mapping only when the new asset is in the entry", () => {
    const moved = describeAudit(entry("mapping.updated", { mapping_id: 4, point_id: 11, before: { asset_id: 2 }, after: { asset_id: 7 } }));
    expect(moved.link).toEqual({ to: "/assets/7", label: "Open asset #7" });
    expect(moved.summary).toBe("Changed mapping #4: asset id");
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
    expect(describeAudit(entry("login.succeeded", { client: "10.0.0.5" })).facts).toEqual([{ label: "Client", value: "10.0.0.5" }]);
  });

  it("says whose sign-in an admin unblocked, links to the Users page and labels the account id", () => {
    const view = describeAudit(entry("login.unblocked", { user_id: 9, username: "bob", cleared: 2 }));
    expect(view.summary).toBe("Unblocked sign-in for user bob");
    expect(view.link).toEqual({ to: "/users", label: "Open Users" });
    expect(view.facts).toContainEqual({ label: "Account id", value: "9" });
    expect(view.facts).toContainEqual({ label: "Cleared", value: "2" });
    expect(describeAudit(entry("login.unblocked", { user_id: 9, cleared: 1 })).summary).toBe("Unblocked sign-in for user #9");
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
    expect(failed("wrong_password").facts).toContainEqual({ label: "Reason", value: "wrong_password" });
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
      "Generated a diagnostics report (full, masked, source #4)",
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
    expect(describeAudit(entry("user.deleted", { user_id: 3 })).summary).toBe("Deleted user #3");
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
    ).toBe("Created tariff 0.2 per kWh from 2026-02-01 for asset #7");
  });
});

describe("describeAudit: old, odd and unknown rows", () => {
  it("shows the stored fields as facts when an update has no before and after", () => {
    const view = describeAudit(entry("tariff.updated", { tariff_id: 3, asset_id: 7, rate_per_kwh: 0.12, effective_from: "2026-01-01" }));
    expect(view.summary).toBe("Changed tariff #3");
    expect(view.changes).toEqual([]);
    expect(view.unchanged).toBe(0);
    expect(view.facts).toEqual([
      { label: "Tariff id", value: "3" },
      { label: "Asset id", value: "7" },
      { label: "Rate per kwh", value: "0.12" },
      { label: "Effective from", value: "2026-01-01" },
    ]);
  });

  it("falls back to the humanised action and the stored fields for an action it does not know", () => {
    const view = describeAudit(entry("foo.bar_baz", { x: 1, name: "n" }));
    expect(view.summary).toBe("Foo bar baz");
    expect(view.link).toBeNull();
    expect(view.changes).toEqual([]);
    expect(view.facts).toEqual([
      { label: "X", value: "1" },
      { label: "Name", value: "n" },
    ]);
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
    expect(odd.facts).toEqual([
      { label: "A", value: "—" },
      { label: "B", value: '{"c":[1,{"d":null}]}' },
      { label: "E", value: "[]" },
    ]);
  });

  it("treats a before or after that is not a plain object as a stored field", () => {
    const view = describeAudit(entry("asset.updated", { asset_id: 1, name: "A", before: "old", after: { name: "B" } }));
    expect(view.changes).toEqual([]);
    expect(view.facts).toContainEqual({ label: "Before", value: "old" });
    expect(view.facts).toContainEqual({ label: "After", value: '{"name":"B"}' });
    const listed = describeAudit(entry("asset.updated", { asset_id: 1, name: "A", before: [1], after: [2] }));
    expect(listed.changes).toEqual([]);
    expect(listed.facts).toContainEqual({ label: "Before", value: "[1]" });
  });

  it("reads keys that are also names on every object as ordinary fields", () => {
    const view = describeAudit(entry("foo.bar", JSON.parse('{"constructor": 1, "__proto__": 2, "before": {"toString": 1}, "after": {"toString": 2}}')));
    expect(view.changes).toEqual([{ field: "ToString", before: "1", after: "2" }]);
    expect(view.facts).toEqual([
      { label: "Constructor", value: "1" },
      { label: "Proto", value: "2" },
    ]);
  });

  it("never throws and always answers text, whatever the detail is", () => {
    const details: unknown[] = [null, undefined, "text", 7, true, [], [1, 2], {}, { before: null, after: null }, { name: 5, asset_id: {} }];
    for (const action of [...ALL_ACTIONS, "nope", ""]) {
      for (const detail of details) {
        const view = describeAudit(entry(action, detail));
        expect(typeof view.summary).toBe("string");
        expect(Array.isArray(view.changes)).toBe(true);
        expect(Array.isArray(view.facts)).toBe(true);
        expect(typeof view.unchanged).toBe("number");
        expect(view.link === null || (typeof view.link.to === "string" && typeof view.link.label === "string")).toBe(true);
      }
    }
    expect(() => describeAudit(null as unknown as AuditEntry)).not.toThrow();
    expect(() => describeAudit(entry(undefined as unknown as string, {}))).not.toThrow();
  });

  it("has a sentence of its own for every action the backend writes", () => {
    expect(ALL_ACTIONS).toHaveLength(45);
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
