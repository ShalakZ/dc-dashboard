import { readFileSync } from "node:fs";
import { auditKind, type AuditKind } from "./auditKind";

// The expected kind of every action the backend writes (lib/auditText.ts keeps the table; the test below reads its keys, so a new action fails here until it is listed).
const EXPECTED: Record<string, AuditKind> = {
  "asset.created": "create", "asset.updated": "change", "asset.deleted": "delete", "asset.moved": "change",
  "billing.closed": "settings", "billing.currency_changed": "settings", "billing.reopened": "settings",
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
  "playlist.created": "create", "playlist.updated": "change", "playlist.deleted": "delete",
  "display.created": "create", "display.updated": "change", "display.revoked": "delete", "display.deleted": "delete",
  "display.connected": "signin", "display.claim_blocked": "problem",
  "readings.imported": "create", "import_profile.saved": "change", "import_profile.deleted": "delete",
  "tags.mapped": "create", "tags.unmapped": "delete", "history.fill_requested": "other",
};

describe("auditKind", () => {
  it("names the kind of every one of the 68 actions in the audit text table", () => {
    const source = readFileSync("src/lib/auditText.ts", "utf8"); // vitest runs from the frontend directory
    const table = source.slice(source.indexOf("const RULES"), source.indexOf("function build("));
    const actions = [...table.matchAll(/^ {2}"([a-z_.]+)":/gm)].map((m) => m[1]);
    expect(actions).toHaveLength(68);
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
    expect(auditKind("billing.closed")).toBe("settings"); // the billing prefix, not the delete or create suffix rules
    expect(auditKind("billing.reopened")).toBe("settings");
    expect(auditKind("password.change_failed")).toBe("problem"); // not change, although it starts like password.changed
    expect(auditKind("dashboard.default_changed")).toBe("change");
    expect(auditKind("login.unblocked")).toBe("change");
    expect(auditKind("kind.renamed")).toBe("change"); // a rename is a change, not "other"
    expect(auditKind("kind.starter_pack_added")).toBe("create"); // the pack registers kinds: a creation, by name, not by a broad "_added" suffix
    expect(auditKind("tariff.rate_added")).toBe("other");
  });

  it("reads an import and a mapped tag list as creations, an undone tag list as a delete and a saved profile as a change, each by name or suffix", () => {
    expect(auditKind("readings.imported")).toBe("create"); // by name: no broad ".imported" suffix
    expect(auditKind("tags.mapped")).toBe("create");
    expect(auditKind("tags.unmapped")).toBe("delete"); // by name: no broad "unmapped" suffix
    expect(auditKind("import_profile.saved")).toBe("change");
    expect(auditKind("import_profile.deleted")).toBe("delete");
    expect(auditKind("history.fill_requested")).toBe("other"); // a request to the source, like a check
    expect(auditKind("x.imported")).toBe("other");
    expect(auditKind("x.unmapped")).toBe("other");
    expect(auditKind("x.saved.more")).toBe("other"); // the end of the string, not a word inside it
  });

  it("reads a revoked display link as a delete, a display that connected as a sign-in and a blocked claim as a problem", () => {
    expect(auditKind("display.revoked")).toBe("delete"); // the link is ended for good, like a removal
    expect(auditKind("display.connected")).toBe("signin");
    expect(auditKind("display.claim_blocked")).toBe("problem");
    expect(auditKind("playlist.deleted")).toBe("delete");
    expect(auditKind("x.revoked.more")).toBe("other"); // the end of the string, not a word inside it
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
