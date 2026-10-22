/** What an audit entry did, for its icon and colour: one of seven, a pure function of the action string. The sentence is always there too; the kind is decoration. */
export type AuditKind = "signin" | "problem" | "create" | "change" | "delete" | "settings" | "other";

// A blocked display claim is an address guessing links; a display that connected is the screen's own sign-in.
const PROBLEMS = new Set(["login.failed", "login.locked", "password.change_failed", "display.claim_blocked"]);
const SIGN_INS = new Set(["login.succeeded", "setup.completed", "display.connected"]);
const SETTINGS_PREFIXES = ["settings.", "storage.", "billing."];
// Actions that add things without ending in ".created": the data-centre starter pack registers kinds, an import adds readings and a tag list adds mappings, assets and points.
const CREATE_ACTIONS = new Set(["kind.starter_pack_added", "readings.imported", "tags.mapped"]);
// Undoing a tag list takes its mappings and assets away again.
const DELETE_ACTIONS = new Set(["tags.unmapped"]);
// Undoing the move of a source puts its address back, an update like the move itself (which the ".moved" suffix below already reads as a change).
const CHANGE_ACTIONS = new Set(["source.move_undone"]);
// A saved import profile is a create or an update in one (a PUT), so it is a change.
const CHANGE_SUFFIXES = [".updated", ".changed", "_changed", ".unblocked", ".default_set", ".renamed", ".moved", ".saved"];

/**
 * The first rule that matches wins: problem, signin, settings, delete, create, change; anything else (checks, scans, browsing,
 * diagnostics, discovery, an action this table does not know yet) is `other`. Total: it never throws.
 */
export function auditKind(action: string): AuditKind {
  if (typeof action !== "string") return "other";
  if (PROBLEMS.has(action)) return "problem";
  if (SIGN_INS.has(action)) return "signin";
  if (SETTINGS_PREFIXES.some((prefix) => action.startsWith(prefix))) return "settings";
  // A revoked display link ends for good, like a removal (no other action ends in ".revoked").
  if (action.endsWith(".deleted") || action.endsWith(".revoked") || DELETE_ACTIONS.has(action)) return "delete";
  if (action.endsWith(".created") || CREATE_ACTIONS.has(action)) return "create";
  if (CHANGE_ACTIONS.has(action) || CHANGE_SUFFIXES.some((suffix) => action.endsWith(suffix))) return "change";
  return "other";
}
