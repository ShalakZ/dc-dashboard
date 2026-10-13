/** What an audit entry did, for its icon and colour: one of seven, a pure function of the action string. The sentence is always there too; the kind is decoration. */
export type AuditKind = "signin" | "problem" | "create" | "change" | "delete" | "settings" | "other";

const PROBLEMS = new Set(["login.failed", "login.locked", "password.change_failed"]);
const SIGN_INS = new Set(["login.succeeded", "setup.completed"]);
const SETTINGS_PREFIXES = ["settings.", "storage.", "billing."];
const CHANGE_SUFFIXES = [".updated", ".changed", "_changed", ".unblocked", ".default_set"];

/**
 * The first rule that matches wins: problem, signin, settings, delete, create, change; anything else (checks, scans, browsing,
 * diagnostics, discovery, an action this table does not know yet) is `other`. Total: it never throws.
 */
export function auditKind(action: string): AuditKind {
  if (typeof action !== "string") return "other";
  if (PROBLEMS.has(action)) return "problem";
  if (SIGN_INS.has(action)) return "signin";
  if (SETTINGS_PREFIXES.some((prefix) => action.startsWith(prefix))) return "settings";
  if (action.endsWith(".deleted")) return "delete";
  if (action.endsWith(".created")) return "create";
  if (CHANGE_SUFFIXES.some((suffix) => action.endsWith(suffix))) return "change";
  return "other";
}
