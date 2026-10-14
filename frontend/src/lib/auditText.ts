import type { AuditEntry, AuditRefs, RefKind } from "../api/types";
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
  link: { to: string; label: string } | null;
}

type Detail = Record<string, unknown>;
type AuditLink = NonNullable<AuditView["link"]>;
interface Sides { before: Detail; after: Detail }
interface Context { d: Detail; sides: Sides | null; fields: string; refs: AuditRefs | undefined }
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

// A friendly sentence never shows a database id (the Scan numbers excepted): a name comes from the stored detail or from
// the server's `refs` lookup, a target the lookup could not find reads "a deleted asset", and with no lookup at all
// (`refs` undefined: a test fixture or a future caller) it reads "an asset".
const REF_KINDS: readonly RefKind[] = ["asset", "user", "source", "dashboard", "point"];
const kindOf = (noun: string): RefKind | undefined => REF_KINDS.find((kind) => kind === noun);
const article = (noun: string) => `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;

/** What the lookup says about one id: the name it has now, gone (a lookup was made and the id is not in it) or unknown (none was made). */
type Found = { is: "name"; name: string } | { is: "gone" } | { is: "unknown" };

function ref(refs: AuditRefs | undefined, kind: RefKind, id: number): Found {
  if (!isObject(refs)) return { is: "unknown" };
  const names = get(refs, kind);
  const name = isObject(names) ? text(get(names, String(id))) : null;
  return name ? { is: "name", name } : { is: "gone" };
}

/** What stands for a target the lookup has no name for: "a deleted asset", or "an asset" when no lookup was made. */
const nameless = (found: Found, kind: RefKind) => (found.is === "gone" ? `a deleted ${kind}` : article(kind));

/** "asset Panel A", "a deleted asset" or "an asset"; null when `id` is not a usable id, so there is no target to name. */
function target(refs: AuditRefs | undefined, kind: RefKind, id: unknown): string | null {
  const n = idOf(id);
  if (n === null) return null;
  const found = ref(refs, kind, n);
  return found.is === "name" ? `${kind} ${found.name}` : nameless(found, kind);
}

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

// The fields of a before/after side that hold the id of another record: shown as a label without "id" and as the name.
const ID_FIELDS: Record<string, { kind: RefKind; label: string }> = {
  parent_id: { kind: "asset", label: "Parent asset" },
  asset_id: { kind: "asset", label: "Asset" },
  user_id: { kind: "user", label: "User" },
  source_id: { kind: "source", label: "Source" },
  dashboard_id: { kind: "dashboard", label: "Dashboard" },
  point_id: { kind: "point", label: "Point" },
};

/** An id field's value: the name, "a deleted asset", "an asset" without a lookup, "—" for none; anything that is not an id as it is stored. */
function idFieldValue(refs: AuditRefs | undefined, kind: RefKind, value: unknown): string {
  if (value === null || value === undefined) return "—";
  const id = idOf(value);
  if (id === null) return formatValue(value);
  const found = ref(refs, kind, id);
  return found.is === "name" ? found.name : nameless(found, kind);
}

// What a field is called, and how its value reads, where the stored form is not for people.
function describeChange(refs: AuditRefs | undefined, key: string, before: unknown, after: unknown): AuditChange {
  if (key === "widgets_hash") return { field: "Widget layout", before: "earlier layout", after: "the widget layout changed" };
  if (has(ID_FIELDS, key)) {
    const { kind, label } = ID_FIELDS[key];
    return { field: label, before: idFieldValue(refs, kind, before), after: idFieldValue(refs, kind, after) };
  }
  return { field: humanise(key), before: fieldValue(key, before), after: fieldValue(key, after) };
}

function diff(sides: Sides, refs: AuditRefs | undefined): { changes: AuditChange[]; unchanged: number } {
  const changes: AuditChange[] = [];
  let unchanged = 0;
  // dashboard.default_changed keeps the dashboard's name beside its id; the name row says it, so the id row would say it twice.
  const namedDashboard = has(sides.before, "dashboard") || has(sides.after, "dashboard");
  for (const key of new Set([...Object.keys(sides.before), ...Object.keys(sides.after)])) {
    const before = get(sides.before, key);
    const after = get(sides.after, key);
    if (stable(before) === stable(after)) {
      if (has(sides.before, key) && has(sides.after, key)) unchanged += 1;
    } else if (!(key === "dashboard_id" && namedDashboard)) {
      changes.push(describeChange(refs, key, before, after));
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

/**
 * "asset Panel A", else the lookup's "asset Panel B" / "a deleted asset" (only for a `kind` the server looks up), else "asset".
 * The name stored in the entry wins (R2): it is the name at the time of the event, and "Deleted asset Panel A" must keep saying Panel A.
 * `fit` shapes a stored name for the sentence.
 */
function thing(c: Context, noun: string, idKey: string, kind?: RefKind, fit: (name: string) => string = (name) => name): string {
  const name = text(c.d.name) ?? text(c.d.username);
  if (name) return `${noun} ${fit(name)}`;
  const id = idOf(c.d[idKey]);
  if (kind && id !== null) {
    const found = ref(c.refs, kind, id);
    if (found.is === "name") return `${noun} ${found.name}`;
    if (found.is === "gone") return `a deleted ${noun}`;
  }
  return noun;
}

const MAX_NAME_LENGTH = 80;

/** A name cut at 80 characters with an ellipsis (the server caps a role name at 64, but an entry is stored data). Counts characters, so no emoji is split. */
function shortName(name: string): string {
  const characters = [...name];
  return characters.length > MAX_NAME_LENGTH ? `${characters.slice(0, MAX_NAME_LENGTH).join("")}…` : name;
}

/** "role Executive", else "role", with the name cut. */
const roleThing = (c: Context) => thing(c, "role", "role_id", undefined, shortName);

const page = (to: string, label: string) => (): AuditLink => ({ to, label });

/**
 * "Open asset Panel A" to /assets/7. No link for a target the lookup says is gone (R6: it would lead to a not-found page),
 * none without a usable id, and "Open asset" when no name is known. The stored name wins, like in the sentence.
 */
function linkTo(c: Context, kind: "asset" | "dashboard", id: unknown, storedName?: string | null): AuditLink | null {
  const n = idOf(id);
  if (n === null) return null;
  const found = ref(c.refs, kind, n);
  if (found.is === "gone") return null;
  const name = storedName ?? (found.is === "name" ? found.name : null);
  return { to: `/${kind}s/${n}`, label: name ? `Open ${kind} ${name}` : `Open ${kind}` };
}

// The ref kind of a noun, when the server looks that kind up (a role, scan scope, mapping or tariff has no name to look up).
const made = (noun: string, idKey: string, link?: Rule["link"]): Rule => ({
  summary: (c) => `Created ${thing(c, noun, idKey, kindOf(noun))}`, link,
});
const changed = (noun: string, idKey: string, link?: Rule["link"]): Rule => ({
  summary: (c) => withFields(`Changed ${thing(c, noun, idKey, kindOf(noun))}`, c.fields), link,
});
// A deleted record is gone by definition: with no stored name the sentence says only what kind it was, never "a deleted user".
const removed = (noun: string, idKey: string): Rule => ({ summary: (c) => `Deleted ${thing(c, noun, idKey)}` });

const ownAsset = (c: Context): AuditLink | null => linkTo(c, "asset", c.d.asset_id, text(c.d.name));
const ownDashboard = (c: Context): AuditLink | null => linkTo(c, "dashboard", c.d.dashboard_id, text(c.d.name));
const assetOfDetail = (c: Context): AuditLink | null => linkTo(c, "asset", c.d.asset_id);
// audit_change keeps only the changed fields, so a mapping moved to another asset carries the new one in `after`.
const assetOfAfter = (c: Context): AuditLink | null => (c.sides ? linkTo(c, "asset", get(c.sides.after, "asset_id")) : null);

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
function userUpdate(c: Context): string | null {
  const { d, sides } = c;
  if (!sides) return null;
  // audit_change keeps only the fields that changed; a side that shows no difference is not claimed as a change.
  const changedKey = (key: string) => has(sides.after, key) && stable(get(sides.before, key)) !== stable(get(sides.after, key));
  // The stored username, else the account's name now; an account the lookup cannot find is "a deleted user" and one with no id "a user".
  const stored = text(d.username);
  const userId = idOf(d.user_id);
  const found = userId !== null ? ref(c.refs, "user", userId) : null;
  const name = stored ?? (found?.is === "name" ? found.name : null);
  const who = name ?? (found?.is === "gone" ? "a deleted user" : "a user");
  const parts: string[] = [];
  if (changedKey("role")) {
    const from = text(get(sides.before, "role"));
    const to = formatValue(get(sides.after, "role"));
    parts.push(`Changed the role of ${who}${from ? ` from ${from}` : ""} to ${to}${roleDifference(d)}`);
  }
  if (changedKey("active")) {
    const now = get(sides.after, "active");
    // "Deactivated user bob", "Deactivated a deleted user", "Deactivated user" (no id to go by).
    const whom = name ? `user ${name}` : found?.is === "gone" ? "a deleted user" : "user";
    if (now === false) parts.push(`Deactivated ${whom}`);
    else if (now === true && get(sides.before, "active") === false) parts.push(`Reactivated ${whom}`);
  }
  // `before.password` is always "set"; `after.password` is "changed" when an admin set a new one ("set" would mean unchanged and is never kept).
  if (changedKey("password") && get(sides.after, "password") === "changed") {
    parts.push(`Reset the password of ${who}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The permissions a role edit gave and took away: the entry's own lists, else worked out from the permissions before and after. */
function permissionsChanged({ d, sides }: Context): { added: unknown[]; removed: unknown[] } {
  if (Array.isArray(d.added) || Array.isArray(d.removed)) {
    return { added: Array.isArray(d.added) ? d.added : [], removed: Array.isArray(d.removed) ? d.removed : [] };
  }
  const before = sides ? get(sides.before, "permissions") : undefined;
  const after = sides ? get(sides.after, "permissions") : undefined;
  if (!Array.isArray(before) || !Array.isArray(after)) return { added: [], removed: [] };
  const was = new Set(before.map(stable));
  const now = new Set(after.map(stable));
  return { added: after.filter((id) => !was.has(stable(id))), removed: before.filter((id) => !now.has(stable(id))) };
}

/** What a role.updated entry did to the role, as one sentence; null when it changed none of name, description and permissions. */
function roleUpdate(c: Context): string | null {
  const { d, sides } = c;
  const parts: string[] = [];
  const name = text(d.name);
  const changedKey = (key: string) => sides !== null && has(sides.after, key) && stable(get(sides.before, key)) !== stable(get(sides.after, key));
  if (sides && changedKey("name")) {
    const from = text(get(sides.before, "name"));
    parts.push(from ? `renamed from ${shortName(from)}` : "renamed");
  }
  const changes = permissionsChanged(c);
  const added = permissionLabels(changes.added);
  const removed = permissionLabels(changes.removed);
  if (added.length > 0) parts.push(`added ${labelList(added)}`);
  if (removed.length > 0) parts.push(`removed ${labelList(removed)}`);
  if (changedKey("description")) parts.push("changed the description");
  return parts.length > 0 ? `Changed ${name ? `role ${shortName(name)}` : roleThing(c)}: ${parts.join("; ")}` : null;
}

const kindsPage = page("/assets/kinds", "Open Asset kinds");

/** "asset kind Rack" (the name cut), else "an asset kind". The id is never part of it: a kind entry stores its name. */
function kindThing(name: unknown): string {
  const stored = text(name);
  return stored ? `asset kind ${shortName(stored)}` : "an asset kind";
}

/** An icon id as people read it: the catalogue label, else the id as stored; null when there is none. */
function iconText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? assetIconLabel(value) : null) ?? formatValue(value);
}

/** The side of a before/after pair that an entry has, or null. */
const sideValue = (c: Context, side: "before" | "after", key: string): unknown => (c.sides ? get(c.sides[side], key) : undefined);

/** " (12 assets follow)" from the number of assets a rename rewrote; "" for none or for a value that is not a count. */
function followers(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return "";
  return ` (${count(value, "asset")} ${value === 1 ? "follows" : "follow"})`;
}

/** "Added 36 data-centre asset kinds: UPS, Battery, PDU, RPP, ATS, STS and 30 more" from the stored count and names (kind names, no ids); still a sentence when either is missing. */
function starterPackAdded(d: Detail): string {
  const names = Array.isArray(d.names) ? d.names.map(text).filter((name): name is string => name !== null).map(shortName) : [];
  const stored = typeof d.count === "number" && Number.isSafeInteger(d.count) && d.count > 0 ? d.count : names.length;
  const what = stored > 0 ? `Added ${count(stored, "data-centre asset kind")}` : "Added data-centre asset kinds";
  return names.length > 0 ? `${what}: ${labelList(names)}` : what;
}

const sourcesPage = page("/sources", "Open Sources");
const scansPage = page("/scans", "Open Scans");
const usersPage = page("/users", "Open Users & Roles");
const rolesPage = page("/users/roles", "Open Roles");
const tariffsPage = page("/tariffs", "Open Tariffs");
const storagePage = page("/storage", "Open Storage");

/** "QAR", or "not set" when the side is missing or empty. */
function settingSide(side: Detail | undefined, key: string): string {
  return (side && text(get(side, key))) || "not set";
}

/** "tariff 0.1 per kWh from 2026-01-01 for asset Panel A" ("(site default)" for no asset) from the stored fields, else "tariff". */
function tariffName(c: Context): string {
  const { d } = c;
  if (typeof d.rate_per_kwh !== "number") return "tariff";
  const from = text(d.effective_from);
  const asset = target(c.refs, "asset", d.asset_id);
  const where = d.asset_id === null ? " (site default)" : asset !== null ? ` for ${asset}` : "";
  return `tariff ${d.rate_per_kwh} per kWh${from ? ` from ${from}` : ""}${where}`;
}

/** Which tariff an update was to: "the tariff for asset Panel A", "the site default tariff", else "a tariff". */
function tariffOf(c: Context): string {
  if (c.d.asset_id === null) return "the site default tariff";
  const asset = target(c.refs, "asset", c.d.asset_id);
  return asset !== null ? `the tariff for ${asset}` : "a tariff";
}

function scanName(d: Detail): string {
  const id = idOf(d.scan_id);
  return id !== null ? `Scan #${id}` : "A scan";
}

/** One side of dashboard.default_changed: the stored name, else the lookup's, else "a deleted dashboard"; null when the side has no dashboard. `bare` suits "from X to Y", `full` suits "Made X the default". */
function defaultSide(c: Context, side: Detail | undefined): { bare: string; full: string } | null {
  if (!side) return null;
  const name = text(get(side, "dashboard"));
  if (name) return { bare: name, full: `dashboard ${name}` };
  const named = target(c.refs, "dashboard", get(side, "dashboard_id"));
  if (named === null) return null;
  return { bare: named.replace(/^dashboard /, ""), full: named };
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
    summary: (c) => `Deleted ${thing(c, "dashboard", "dashboard_id")}${c.d.was_default === true ? " (it was the default dashboard)" : ""}`,
  },
  // before/after carry the dashboard's id and name, null when there was none.
  "dashboard.default_changed": {
    summary: (c) => {
      const from = defaultSide(c, c.sides?.before);
      const to = defaultSide(c, c.sides?.after);
      if (from && to) return `Changed the default dashboard from ${from.bare} to ${to.bare}`;
      if (to) return `Made ${to.full} the default dashboard`;
      if (from) return `Cleared the default dashboard (was ${from.bare})`;
      return "Changed the default dashboard";
    },
    link: (c) => (c.sides ? linkTo(c, "dashboard", get(c.sides.after, "dashboard_id"), text(get(c.sides.after, "dashboard"))) : null),
  },

  // The report text is never stored: this row says only how it was asked for.
  "diagnostics.report": {
    summary: (c) => {
      const source = target(c.refs, "source", c.d.source_id);
      const detail = c.d.detail === "full" ? "full" : "summary";
      return `Generated a diagnostics report (${detail}, ${c.d.mask === true ? "masked" : "not masked"}${source !== null ? `, ${source}` : ""})`;
    },
    link: page("/diagnostics", "Open Diagnostics"),
  },

  "discovery.accepted": {
    summary: ({ d, refs }) => {
      const mappings = typeof d.mappings === "number" ? count(d.mappings, "mapping") : null;
      const asset = target(refs, "asset", d.asset_id) ?? "an asset";
      if (d.created_asset === true) return `Accepted discovery: created ${asset}${mappings ? ` with ${mappings}` : ""}`;
      return `Accepted discovery: added ${mappings ?? "mappings"} to ${asset}`;
    },
    link: assetOfDetail,
  },

  // The detail keeps the kind's name (kind_id is only there for the raw Details JSON): a rename stores it in before/after.
  "kind.created": { summary: (c) => `Created ${kindThing(c.d.name)}`, link: kindsPage },
  "kind.deleted": { summary: (c) => `Deleted ${kindThing(c.d.name)}` },
  "kind.icon_changed": {
    summary: (c) => {
      const from = iconText(sideValue(c, "before", "icon"));
      const to = iconText(sideValue(c, "after", "icon"));
      const what = `Changed the icon of ${kindThing(c.d.name)}`;
      return from && to ? `${what} from ${from} to ${to}` : to ? `${what} to ${to}` : what;
    },
    link: kindsPage,
  },
  "kind.renamed": {
    summary: (c) => {
      const from = text(sideValue(c, "before", "name"));
      const to = text(sideValue(c, "after", "name"));
      const was = kindThing(from);
      const now = to ? ` to ${shortName(to)}` : "";
      return `Renamed ${was}${now}${followers(c.d.assets)}`;
    },
    link: kindsPage,
  },
  "kind.starter_pack_added": { summary: (c) => starterPackAdded(c.d), link: kindsPage },

  // In these rows the User column is the account that was attacked (unknown when the name did not exist), not someone who acted.
  "login.failed": {
    // A typed name that matches no account is stored without an account, so the sentence must not say "this account".
    summary: ({ d }) => (text(d.reason) === "unknown_account" ? "Failed sign-in to an unknown account" : `Failed sign-in to this account${reasonSuffix(d)}`),
  },
  "login.locked": { summary: ({ d }) => `Sign-in blocked after repeated failures${reasonSuffix(d)}` },
  "login.succeeded": { summary: () => "Signed in" },
  // The User column is the admin who unblocked; user_id in the detail is the account that was unblocked.
  "login.unblocked": { summary: (c) => `Unblocked sign-in for ${thing(c, "user", "user_id", "user")}`, link: usersPage },

  // A mapping has no name: it is described by its point and its asset, never by its own id.
  "mapping.created": {
    summary: ({ d, refs }) => {
      const point = target(refs, "point", d.point_id);
      const asset = target(refs, "asset", d.asset_id);
      const metric = text(d.metric);
      return [point !== null ? `Mapped ${point}` : "Created a mapping", asset !== null ? ` to ${asset}` : "", metric ? ` as ${metric}` : ""].join("");
    },
    link: assetOfDetail,
  },
  "mapping.updated": {
    summary: (c) => {
      const point = target(c.refs, "point", c.d.point_id);
      return withFields(point !== null ? `Changed the mapping of ${point}` : "Changed a mapping", c.fields);
    },
    link: assetOfAfter,
  },
  "mapping.deleted": {
    summary: ({ d, refs }) => {
      const point = target(refs, "point", d.point_id);
      const asset = target(refs, "asset", d.asset_id);
      return `Deleted ${point !== null ? `the mapping of ${point}` : "a mapping"}${asset !== null ? ` to ${asset}` : ""}`;
    },
  },

  "password.change_failed": { summary: () => "Failed password change (wrong current password)" },
  "password.changed": { summary: () => "Changed own password" },

  "role.created": {
    summary: (c) => {
      const { d } = c;
      const copied = text(d.copied_from);
      const labels = permissionLabels(d.permissions);
      const granted = Array.isArray(d.permissions) ? `: ${labels.length > 0 ? labelList(labels) : "no permissions"}` : "";
      return `Created ${roleThing(c)}${copied ? ` as a copy of ${shortName(copied)}` : ""}${granted}`;
    },
    link: rolesPage,
  },
  "role.deleted": { summary: (c) => `Deleted ${roleThing(c)}` },
  "role.updated": {
    summary: (c) => roleUpdate(c) ?? withFields(`Changed ${roleThing(c)}`, c.fields),
    link: rolesPage,
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

  "scope.created": { summary: (c) => `Created scan ${thing(c, "scope", "scope_id")}`, link: scansPage },
  "scope.updated": {
    summary: (c) => withFields(`Changed scan ${thing(c, "scope", "scope_id")}`, c.fields),
    link: scansPage,
  },
  "scope.deleted": { summary: (c) => `Deleted scan ${thing(c, "scope", "scope_id")}` },

  "settings.sign_in_changed": {
    summary: ({ d, sides, fields, refs }) => {
      // audit_change keeps only the changed fields, so `enabled` is in `after` exactly when the switch was thrown.
      const now = sides ? get(sides.after, "enabled") : undefined;
      if (!sides || typeof now !== "boolean" || stable(get(sides.before, "enabled")) === stable(now)) {
        return withFields("Changed the sign-in protection", fields);
      }
      const numbers = fieldList(diff(sides, refs).changes.filter((change) => change.field !== "Enabled"));
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

  "source.browsed": { summary: (c) => `Started a browse of ${thing(c, "source", "source_id", "source")}`, link: sourcesPage },
  "source.checked": {
    summary: (c) => `Started a connection check of ${thing(c, "source", "source_id", "source")}`,
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
    summary: (c) => `Started a connection test of ${thing(c, "source", "source_id", "source")}`,
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

  "tariff.created": { summary: (c) => `Created ${tariffName(c)}`, link: tariffsPage },
  "tariff.updated": { summary: (c) => withFields(`Changed ${tariffOf(c)}`, c.fields), link: tariffsPage },
  "tariff.deleted": { summary: (c) => `Deleted ${tariffName(c)}` },

  "user.created": {
    summary: (c) => {
      const role = text(c.d.role);
      return `Created ${thing(c, "user", "user_id", "user")}${role ? ` (${role})` : ""}`;
    },
    link: usersPage,
  },
  "user.deleted": removed("user", "user_id"),
  "user.updated": {
    summary: (c) => userUpdate(c) ?? withFields(`Changed ${thing(c, "user", "user_id", "user")}`, c.fields),
    link: usersPage,
  },
};

function build(entry: AuditEntry): AuditView {
  const action = typeof entry.action === "string" ? entry.action : "";
  const detail: Detail = isObject(entry.detail) ? entry.detail : {};
  const sides: Sides | null =
    isObject(detail.before) && isObject(detail.after) ? { before: detail.before, after: detail.after } : null;
  // undefined = the server made no lookup; an object (even an empty one) = it did, and what it lacks no longer exists.
  const refs = isObject(entry.refs) ? entry.refs : undefined;
  const { changes, unchanged } = sides ? diff(sides, refs) : { changes: [], unchanged: 0 };
  const context: Context = { d: detail, sides, fields: fieldList(changes), refs };

  const rule = Object.prototype.hasOwnProperty.call(RULES, action) ? RULES[action] : null;
  return {
    summary: rule ? rule.summary(context) : humanise(action),
    changes,
    unchanged,
    link: rule?.link ? rule.link(context) : null,
  };
}

/** What an audit entry says, as plain text. Never throws: an entry it cannot read comes back as its humanised action. */
export function describeAudit(entry: AuditEntry): AuditView {
  try {
    return build(entry);
  } catch {
    const action = typeof entry?.action === "string" ? entry.action : "";
    return { summary: humanise(action), changes: [], unchanged: 0, link: null };
  }
}
