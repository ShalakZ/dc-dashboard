import { readFileSync } from "node:fs";
import { auditKind, type AuditKind } from "./auditKind";

// The expected kind of every action the backend writes (lib/auditText.ts keeps the table; the test below reads its keys, so a new action fails here until it is listed).
const EXPECTED: Record<string, AuditKind> = {
  "asset.created": "create", "asset.updated": "change", "asset.deleted": "delete", "asset.moved": "change",
  "billing.currency_changed": "settings",
  "dashboard.created": "create", "dashboard.updated": "change", "dashboard.deleted": "delete", "dashboard.default_changed": "change",
  "diagnostics.report": "other", "discovery.accepted": "other",
  "kind.created": "create", "kind.deleted": "delete", "kind.icon_changed": "change", "kind.renamed": "change",
  "kind.starter_pack_added": "create",
  "login.failed": "problem", "login.locked": "problem", "login.succeeded": "signin", "login.unblocked": "change",
  "mapping.created": "create", "mapping.updated": "change", "mapping.deleted": "delete",
  "password.change_failed": "problem", "password.changed": "change",
  "role.created": "create", "role.updated": "change", "role.deleted": "delete",
  "scan.finished": "other", "scan.started": "other",
  "scope.created": "create", "scope.updated": "change", "scope.deleted": "delete",
  "settings.sign_in_changed": "settings", "settings.timezone_changed": "settings", "setup.completed": "signin",
  "source.browsed": "other", "source.checked": "other", "source.created": "create", "source.deleted": "delete",
  "source.test_all": "other", "source.tested": "other", "source.updated": "change",
  "storage.changed": "settings", "storage.default_set": "settings",
  "tariff.created": "create", "tariff.updated": "change", "tariff.deleted": "delete",
  "user.created": "create", "user.deleted": "delete", "user.updated": "change",
};

describe("auditKind", () => {
  it("names the kind of every one of the 51 actions in the audit text table", () => {
    const source = readFileSync("src/lib/auditText.ts", "utf8"); // vitest runs from the frontend directory
    const table = source.slice(source.indexOf("const RULES"), source.indexOf("function build("));
    const actions = [...table.matchAll(/^ {2}"([a-z_.]+)":/gm)].map((m) => m[1]);
    expect(actions).toHaveLength(51);
    expect([...actions].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const action of actions) expect(auditKind(action), action).toBe(EXPECTED[action]);
  });

  it("uses all seven kinds", () => {
    expect(new Set(Object.values(EXPECTED))).toEqual(new Set(["signin", "problem", "create", "change", "delete", "settings", "other"]));
  });

  it("puts a failed sign-in, a block and a failed password change under problem, and a good sign-in and the first-run setup under signin", () => {
    for (const action of ["login.failed", "login.locked", "password.change_failed"]) expect(auditKind(action)).toBe("problem");
    for (const action of ["login.succeeded", "setup.completed"]) expect(auditKind(action)).toBe("signin");
  });

  it("reads the first matching rule: problem, signin, settings, delete, create, change, other", () => {
    expect(auditKind("settings.thing.deleted")).toBe("settings"); // the prefix comes before the suffix
    expect(auditKind("storage.default_set")).toBe("settings"); // not change
    expect(auditKind("billing.currency_changed")).toBe("settings");
    expect(auditKind("password.change_failed")).toBe("problem"); // not change, although it starts like password.changed
    expect(auditKind("dashboard.default_changed")).toBe("change");
    expect(auditKind("login.unblocked")).toBe("change");
    expect(auditKind("kind.renamed")).toBe("change"); // a rename is a change, not "other"
    expect(auditKind("kind.starter_pack_added")).toBe("create"); // the pack registers kinds: a creation, by name, not by a broad "_added" suffix
    expect(auditKind("tariff.rate_added")).toBe("other");
  });

  it("matches the whole string at its start or end, not a word inside it", () => {
    expect(auditKind("x.settings.updated")).toBe("change");
    expect(auditKind("deleted.thing")).toBe("other");
    expect(auditKind("login.failed.more")).toBe("other");
    expect(auditKind("createdx")).toBe("other");
  });

  it("is total: an unknown or empty string, or something that is not a string, is other", () => {
    expect(auditKind("something.new")).toBe("other");
    expect(auditKind("")).toBe("other");
    expect(auditKind(undefined as unknown as string)).toBe("other");
    expect(auditKind(null as unknown as string)).toBe("other");
    expect(auditKind(7 as unknown as string)).toBe("other");
  });
});
