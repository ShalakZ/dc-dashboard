import type { AuditEntry } from "../api/types";
import { assetIconLabel } from "./assetIcons";
import { PERMISSION_LABELS, type PermissionId } from "./permissions";

/** One field whose value changed; the texts are already formatted ("—" = absent or null). */
export interface AuditChange { field: string; before: string; after: string }

export interface AuditView {
  /** One sentence without the actor ("Deleted asset Panel A"). */
  summary: string;
  /** Only the fields whose value changed. */
  changes: AuditChange[];
  /** Fields on both sides with equal values (a storage save lists every field). */
  unchanged: number;
  /** The stored fields when there is no before/after, else the subject fields (everything except before and after). */
  facts: { label: string; value: string }[];
  link: { to: string; label: string } | null;
}

type Detail = Record<string, unknown>;
type AuditLink = NonNullable<AuditView["link"]>;
interface Sides { before: Detail; after: Detail }
interface Context { d: Detail; sides: Sides | null; fields: string }
interface Rule { summary: (c: Context) => string; link?: (c: Context) => AuditLink | null }

const isObject = (value: unknown): value is Detail => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (object: Detail, key: string) => Object.prototype.hasOwnProperty.call(object, key);
// Own keys only: a stored key such as "__proto__" or "constructor" must not read the prototype.
const get = (object: Detail, key: string): unknown => (has(object, key) ? object[key] : undefined);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
/** A usable record id; a link path is built only from one of these. */
const idOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "rate_per_kwh" -> "Rate per kwh". */
export function humanise(key: string): string {
  const words = key.replace(/[_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A stored value as text: "—" for absent, yes/no for booleans, strings as they are, structures as JSON. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Key order does not matter and an absent value equals null. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

/** How a field's value reads: an asset's icon id as its catalogue label ("Automatic" when null or absent, the raw id when unlisted). */
function fieldValue(key: string, value: unknown): string {
  if (key !== "icon") return formatValue(value);
  if (value === null || value === undefined) return "Automatic";
  return (typeof value === "string" ? assetIconLabel(value) : null) ?? formatValue(value);
}

// What a field is called, and how its value reads, where the stored form is not for people.
function describeChange(key: string, before: unknown, after: unknown): AuditChange {
  if (key === "widgets_hash") return { field: "Widget layout", before: "earlier layout", after: "the widget layout changed" };
  return { field: humanise(key), before: fieldValue(key, before), after: fieldValue(key, after) };
}

function diff(sides: Sides): { changes: AuditChange[]; unchanged: number } {
  const changes: AuditChange[] = [];
  let unchanged = 0;
  for (const key of new Set([...Object.keys(sides.before), ...Object.keys(sides.after)])) {
    const before = get(sides.before, key);
    const after = get(sides.after, key);
    if (stable(before) === stable(after)) {
      if (has(sides.before, key) && has(sides.after, key)) unchanged += 1;
    } else {
      changes.push(describeChange(key, before, after));
    }
  }
  return { changes, unchanged };
}

const MAX_NAMED_FIELDS = 5;

/** "name, parent id" for the sentence; the long tail is counted. */
function fieldList(changes: AuditChange[]): string {
  const names = changes.map((change) => change.field.toLowerCase());
  if (names.length <= MAX_NAMED_FIELDS) return names.join(", ");
  return `${names.slice(0, MAX_NAMED_FIELDS).join(", ")} and ${names.length - MAX_NAMED_FIELDS} more`;
}

const withFields = (sentence: string, fields: string) => (fields ? `${sentence}: ${fields}` : sentence);

/** "asset Panel A", else "asset #7", else "asset". */
function thing(noun: string, d: Detail, idKey: string): string {
  const name = text(d.name) ?? text(d.username);
  const id = idOf(d[idKey]);
  return name ? `${noun} ${name}` : id !== null ? `${noun} #${id}` : noun;
}

const page = (to: string, label: string) => (): AuditLink => ({ to, label });
const assetLink = (id: number, name?: string | null): AuditLink => ({
  to: `/assets/${id}`, label: name ? `Open asset ${name}` : `Open asset #${id}`,
});

const made = (noun: string, idKey: string, link?: Rule["link"]): Rule => ({
  summary: (c) => `Created ${thing(noun, c.d, idKey)}`, link,
});
const changed = (noun: string, idKey: string, link?: Rule["link"]): Rule => ({
  summary: (c) => withFields(`Changed ${thing(noun, c.d, idKey)}`, c.fields), link,
});
const removed = (noun: string, idKey: string): Rule => ({ summary: (c) => `Deleted ${thing(noun, c.d, idKey)}` });

const ownAsset = ({ d }: Context): AuditLink | null => {
  const id = idOf(d.asset_id);
  return id === null ? null : assetLink(id, text(d.name));
};
const ownDashboard = ({ d }: Context): AuditLink | null => {
  const id = idOf(d.dashboard_id);
  return id === null ? null : { to: `/dashboards/${id}`, label: `Open ${thing("dashboard", d, "dashboard_id")}` };
};
const assetOfDetail = ({ d }: Context): AuditLink | null => {
  const id = idOf(d.asset_id);
  return id === null ? null : assetLink(id);
};
// audit_change keeps only the changed fields, so a mapping moved to another asset carries the new one in `after`.
const assetOfAfter = ({ sides }: Context): AuditLink | null => {
  const id = sides ? idOf(get(sides.after, "asset_id")) : null;
  return id === null ? null : assetLink(id);
};

/** " (wrong password)" from the stored reason ("wrong_password"), or "" when there is none. */
function reasonSuffix(d: Detail): string {
  const reason = text(d.reason);
  return reason ? ` (${reason.replace(/_/g, " ")})` : "";
}

/** A permission id as people read it: its label, else the id itself (one this build does not know, or not text). */
function permissionLabel(id: unknown): string {
  const raw = typeof id === "string" ? id : formatValue(id);
  return has(PERMISSION_LABELS, raw) ? PERMISSION_LABELS[raw as PermissionId] : raw;
}

/** The labels of a stored permission list; empty when the value is not a list. */
const permissionLabels = (value: unknown): string[] => (Array.isArray(value) ? value.map(permissionLabel) : []);

const MAX_NAMED_PERMISSIONS = 6;

/** "See billing, Change tariffs and 3 more": the long tail is counted. */
function labelList(labels: string[]): string {
  if (labels.length <= MAX_NAMED_PERMISSIONS) return labels.join(", ");
  return `${labels.slice(0, MAX_NAMED_PERMISSIONS).join(", ")} and ${labels.length - MAX_NAMED_PERMISSIONS} more`;
}

/** " (adds See billing; removes Export billing as CSV)" from the permissions a change of role gave and took away; "" when the entry has none. */
function roleDifference(d: Detail): string {
  const added = permissionLabels(d.added);
  const removed = permissionLabels(d.removed);
  const parts = [added.length > 0 ? `adds ${labelList(added)}` : "", removed.length > 0 ? `removes ${labelList(removed)}` : ""].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/** What a user.updated entry did to the account, as one sentence; null when it changed none of role, active and password. */
function userUpdate({ d, sides }: Context): string | null {
  if (!sides) return null;
  // audit_change keeps only the fields that changed; a side that shows no difference is not claimed as a change.
  const changedKey = (key: string) => has(sides.after, key) && stable(get(sides.before, key)) !== stable(get(sides.after, key));
  const name = text(d.username) ?? (idOf(d.user_id) !== null ? `#${idOf(d.user_id)}` : null);
  const parts: string[] = [];
  if (changedKey("role")) {
    const from = text(get(sides.before, "role"));
    const to = formatValue(get(sides.after, "role"));
    parts.push(`Changed the role of ${name ?? "a user"}${from ? ` from ${from}` : ""} to ${to}${roleDifference(d)}`);
  }
  if (changedKey("active")) {
    const now = get(sides.after, "active");
    if (now === false) parts.push(`Deactivated user${name ? ` ${name}` : ""}`);
    else if (now === true && get(sides.before, "active") === false) parts.push(`Reactivated user${name ? ` ${name}` : ""}`);
  }
  // `before.password` is always "set"; `after.password` is "changed" when an admin set a new one ("set" would mean unchanged and is never kept).
  if (changedKey("password") && get(sides.after, "password") === "changed") {
    parts.push(`Reset the password of ${name ?? "a user"}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** What a role.updated entry did to the role, as one sentence; null when it changed none of name, description and permissions. */
function roleUpdate({ d, sides }: Context): string | null {
  const parts: string[] = [];
  const name = text(d.name);
  const changedKey = (key: string) => sides !== null && has(sides.after, key) && stable(get(sides.before, key)) !== stable(get(sides.after, key));
  if (sides && changedKey("name")) {
    const from = text(get(sides.before, "name"));
    parts.push(from ? `renamed from ${from}` : "renamed");
  }
  const added = permissionLabels(d.added);
  const removed = permissionLabels(d.removed);
  if (added.length > 0) parts.push(`added ${labelList(added)}`);
  if (removed.length > 0) parts.push(`removed ${labelList(removed)}`);
  if (changedKey("description")) parts.push("changed the description");
  return parts.length > 0 ? `Changed ${name ? `role ${name}` : thing("role", d, "role_id")}: ${parts.join("; ")}` : null;
}

const sourcesPage = page("/sources", "Open Sources");
const scansPage = page("/scans", "Open Scans");
const usersPage = page("/users", "Open Users");
const tariffsPage = page("/tariffs", "Open Tariffs");
const storagePage = page("/storage", "Open Storage");

/** "QAR", or "not set" when the side is missing or empty. */
function settingSide(side: Detail | undefined, key: string): string {
  return (side && text(get(side, key))) || "not set";
}

/** "tariff 0.1 per kWh from 2026-01-01 (site default)" from the stored fields, else "tariff #3". */
function tariffName(d: Detail): string {
  if (typeof d.rate_per_kwh !== "number") return thing("tariff", d, "tariff_id");
  const from = text(d.effective_from);
  const asset = idOf(d.asset_id);
  const where = d.asset_id === null ? " (site default)" : asset !== null ? ` for asset #${asset}` : "";
  return `tariff ${d.rate_per_kwh} per kWh${from ? ` from ${from}` : ""}${where}`;
}

function scanName(d: Detail): string {
  const id = idOf(d.scan_id);
  return id !== null ? `Scan #${id}` : "A scan";
}

// One entry per action the backend writes. backend/tests/test_audit_describers.py fails when an action is missing.
const RULES: Record<string, Rule> = {
  "asset.created": made("asset", "asset_id", ownAsset),
  "asset.updated": changed("asset", "asset_id", ownAsset),
  "asset.deleted": removed("asset", "asset_id"),

  "billing.currency_changed": {
    summary: ({ sides }) =>
      sides
        ? `Changed the site currency from ${settingSide(sides.before, "currency")} to ${settingSide(sides.after, "currency")}`
        : "Changed the site currency",
    link: tariffsPage,
  },

  "dashboard.created": made("dashboard", "dashboard_id", ownDashboard),
  "dashboard.updated": changed("dashboard", "dashboard_id", ownDashboard),
  "dashboard.deleted": {
    summary: (c) => `Deleted ${thing("dashboard", c.d, "dashboard_id")}${c.d.was_default === true ? " (it was the default dashboard)" : ""}`,
  },
  // before/after carry the dashboard's id and name, null when there was none.
  "dashboard.default_changed": {
    summary: ({ sides }) => {
      const from = sides ? text(get(sides.before, "dashboard")) : null;
      const to = sides ? text(get(sides.after, "dashboard")) : null;
      if (from && to) return `Changed the default dashboard from ${from} to ${to}`;
      if (to) return `Made dashboard ${to} the default dashboard`;
      if (from) return `Cleared the default dashboard (was ${from})`;
      return "Changed the default dashboard";
    },
    link: ({ sides }) => {
      const id = sides ? idOf(get(sides.after, "dashboard_id")) : null;
      const name = sides ? text(get(sides.after, "dashboard")) : null;
      return id === null ? null : { to: `/dashboards/${id}`, label: name ? `Open dashboard ${name}` : `Open dashboard #${id}` };
    },
  },

  // The report text is never stored: this row says only how it was asked for.
  "diagnostics.report": {
    summary: ({ d }) => {
      const source = idOf(d.source_id);
      const detail = d.detail === "full" ? "full" : "summary";
      return `Generated a diagnostics report (${detail}, ${d.mask === true ? "masked" : "not masked"}${source !== null ? `, source #${source}` : ""})`;
    },
    link: page("/diagnostics", "Open Diagnostics"),
  },

  "discovery.accepted": {
    summary: ({ d }) => {
      const asset = idOf(d.asset_id);
      const mappings = typeof d.mappings === "number" ? count(d.mappings, "mapping") : null;
      const target = asset !== null ? `asset #${asset}` : "an asset";
      if (d.created_asset === true) return `Accepted discovery: created ${target}${mappings ? ` with ${mappings}` : ""}`;
      return `Accepted discovery: added ${mappings ?? "mappings"} to ${target}`;
    },
    link: assetOfDetail,
  },

  // In these rows the User column is the account that was attacked (unknown when the name did not exist), not someone who acted.
  "login.failed": {
    // A typed name that matches no account is stored without an account, so the sentence must not say "this account".
    summary: ({ d }) => (text(d.reason) === "unknown_account" ? "Failed sign-in to an unknown account" : `Failed sign-in to this account${reasonSuffix(d)}`),
  },
  "login.locked": { summary: ({ d }) => `Sign-in blocked after repeated failures${reasonSuffix(d)}` },
  "login.succeeded": { summary: () => "Signed in" },
  // The User column is the admin who unblocked; user_id in the detail is the account that was unblocked.
  "login.unblocked": { summary: (c) => `Unblocked sign-in for ${thing("user", c.d, "user_id")}`, link: usersPage },

  "mapping.created": {
    summary: ({ d }) => {
      const point = idOf(d.point_id);
      const asset = idOf(d.asset_id);
      const metric = text(d.metric);
      return [
        point !== null ? `Mapped point #${point}` : "Created a mapping",
        asset !== null ? ` to asset #${asset}` : "",
        metric ? ` as ${metric}` : "",
      ].join("");
    },
    link: assetOfDetail,
  },
  "mapping.updated": {
    summary: (c) => withFields(`Changed ${thing("mapping", c.d, "mapping_id")}`, c.fields),
    link: assetOfAfter,
  },
  "mapping.deleted": removed("mapping", "mapping_id"),

  "password.change_failed": { summary: () => "Failed password change (wrong current password)" },
  "password.changed": { summary: () => "Changed own password" },

  "role.created": {
    summary: ({ d }) => {
      const copied = text(d.copied_from);
      const labels = permissionLabels(d.permissions);
      const granted = Array.isArray(d.permissions) ? `: ${labels.length > 0 ? labelList(labels) : "no permissions"}` : "";
      return `Created ${thing("role", d, "role_id")}${copied ? ` as a copy of ${copied}` : ""}${granted}`;
    },
  },
  "role.deleted": removed("role", "role_id"),
  "role.updated": {
    summary: (c) => roleUpdate(c) ?? withFields(`Changed ${thing("role", c.d, "role_id")}`, c.fields),
  },

  "scan.finished": {
    summary: ({ d }) => {
      const status = text(d.status);
      return `${scanName(d)} finished${status ? ` (${status})` : ""}`;
    },
    link: scansPage,
  },
  "scan.started": {
    summary: ({ d }) => {
      const id = idOf(d.scan_id);
      const scope = text(d.scope_name);
      return `Started scan${id !== null ? ` #${id}` : ""}${scope ? ` of scope ${scope}` : ""}`;
    },
    link: scansPage,
  },

  "scope.created": { summary: (c) => `Created scan ${thing("scope", c.d, "scope_id")}`, link: scansPage },
  "scope.updated": {
    summary: (c) => withFields(`Changed scan ${thing("scope", c.d, "scope_id")}`, c.fields),
    link: scansPage,
  },
  "scope.deleted": { summary: (c) => `Deleted scan ${thing("scope", c.d, "scope_id")}` },

  "settings.sign_in_changed": {
    summary: ({ d, sides, fields }) => {
      // audit_change keeps only the changed fields, so `enabled` is in `after` exactly when the switch was thrown.
      const now = sides ? get(sides.after, "enabled") : undefined;
      if (!sides || typeof now !== "boolean" || stable(get(sides.before, "enabled")) === stable(now)) {
        return withFields("Changed the sign-in protection", fields);
      }
      const numbers = fieldList(diff(sides).changes.filter((change) => change.field !== "Enabled"));
      // Switching off ends every current block; the subject says how many.
      const ended = idOf(d.blocks_ended); // a positive whole number, which is all this needs
      return withFields(`Sign-in protection switched ${now ? "on" : "off"}${ended !== null ? ` (${count(ended, "block")} ended)` : ""}`, numbers);
    },
    link: page("/settings", "Open Settings"),
  },
  "settings.timezone_changed": {
    summary: ({ sides }) =>
      sides
        ? `Changed the site time zone from ${settingSide(sides.before, "timezone")} to ${settingSide(sides.after, "timezone")}`
        : "Changed the site time zone",
    link: page("/settings", "Open Settings"),
  },

  "setup.completed": { summary: () => "Completed the first-run setup" },

  "source.browsed": { summary: (c) => `Started a browse of ${thing("source", c.d, "source_id")}`, link: sourcesPage },
  "source.checked": {
    summary: (c) => `Started a connection check of ${thing("source", c.d, "source_id")}`,
    link: sourcesPage,
  },
  "source.created": made("source", "source_id", sourcesPage),
  "source.deleted": removed("source", "source_id"),
  "source.test_all": {
    summary: ({ d }) =>
      typeof d.sources === "number" ? `Started a connection test of ${count(d.sources, "source")}` : "Started a connection test of all sources",
    link: sourcesPage,
  },
  "source.tested": {
    summary: (c) => `Started a connection test of ${thing("source", c.d, "source_id")}`,
    link: sourcesPage,
  },
  "source.updated": changed("source", "source_id", sourcesPage),

  "storage.changed": {
    summary: (c) =>
      c.fields ? `Changed the storage settings: ${c.fields}` : "Saved the storage settings (policies re-applied)",
    link: storagePage,
  },
  "storage.default_set": {
    summary: () => "Saved the storage settings as this site's default",
    link: storagePage,
  },

  "tariff.created": { summary: ({ d }) => `Created ${tariffName(d)}`, link: tariffsPage },
  "tariff.updated": changed("tariff", "tariff_id", tariffsPage),
  "tariff.deleted": { summary: ({ d }) => `Deleted ${tariffName(d)}` },

  "user.created": {
    summary: ({ d }) => {
      const role = text(d.role);
      return `Created ${thing("user", d, "user_id")}${role ? ` (${role})` : ""}`;
    },
    link: usersPage,
  },
  "user.deleted": removed("user", "user_id"),
  "user.updated": {
    summary: (c) => userUpdate(c) ?? withFields(`Changed ${thing("user", c.d, "user_id")}`, c.fields),
    link: usersPage,
  },
};

function factLabel(action: string, key: string): string {
  // In a user.* entry user_id is the account that was changed; the actor is the entry's own user.
  return (action.startsWith("user.") || action === "login.unblocked") && key === "user_id" ? "Account id" : humanise(key);
}

function build(entry: AuditEntry): AuditView {
  const action = typeof entry.action === "string" ? entry.action : "";
  const detail: Detail = isObject(entry.detail) ? entry.detail : {};
  const sides: Sides | null =
    isObject(detail.before) && isObject(detail.after) ? { before: detail.before, after: detail.after } : null;
  const { changes, unchanged } = sides ? diff(sides) : { changes: [], unchanged: 0 };
  const context: Context = { d: detail, sides, fields: fieldList(changes) };

  const rule = Object.prototype.hasOwnProperty.call(RULES, action) ? RULES[action] : null;
  const hidden = sides ? ["before", "after"] : [];
  return {
    summary: rule ? rule.summary(context) : humanise(action),
    changes,
    unchanged,
    facts: Object.keys(detail)
      .filter((key) => !hidden.includes(key))
      .map((key) => ({ label: factLabel(action, key), value: fieldValue(key, get(detail, key)) })),
    link: rule?.link ? rule.link(context) : null,
  };
}

/** What an audit entry says, as plain text. Never throws: an entry it cannot read comes back as its humanised action. */
export function describeAudit(entry: AuditEntry): AuditView {
  try {
    return build(entry);
  } catch {
    const action = typeof entry?.action === "string" ? entry.action : "";
    return { summary: humanise(action), changes: [], unchanged: 0, facts: [], link: null };
  }
}
