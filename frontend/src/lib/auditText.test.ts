import type { AuditEntry } from "../api/types";
import { describeAudit, formatValue, humanise } from "./auditText";

const entry = (action: string, detail: unknown, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1, user_id: 1, actor_id: 1, username: "admin", action, detail: detail as Record<string, unknown>,
  ts: "2026-10-11T08:00:00Z", ...extra,
});

// Every action the backend writes (the Python parity test keeps this list and the table in step).
const ALL_ACTIONS = [
  "asset.created", "asset.updated", "asset.deleted", "billing.currency_changed",
  "dashboard.created", "dashboard.updated", "dashboard.deleted", "discovery.accepted",
  "login.failed", "login.locked", "login.succeeded", "mapping.created", "mapping.updated", "mapping.deleted",
  "password.change_failed", "password.changed", "scan.finished", "scan.started",
  "scope.created", "scope.updated", "scope.deleted", "settings.timezone_changed", "setup.completed",
  "source.browsed", "source.created", "source.deleted", "source.test_all", "source.tested", "source.updated",
  "storage.changed", "storage.default_set", "tariff.created", "tariff.updated", "tariff.deleted",
  "user.created", "user.updated",
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

  it("says a role change with both roles", () => {
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
    expect(describeAudit(entry("source.browsed", { source_id: 2, name: "PM-1", job_id: 9 })).link).toEqual({
      to: "/sources", label: "Open Sources",
    });
    expect(describeAudit(entry("source.deleted", { source_id: 2, name: "PM-1", points: 4, mappings: 4 })).link).toBeNull();
    expect(describeAudit(entry("user.created", { user_id: 3, username: "carol", role: "operator", active: true })).summary).toBe(
      "Created user carol (operator)",
    );
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
    expect(ALL_ACTIONS).toHaveLength(36);
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
