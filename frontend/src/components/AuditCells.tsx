import { auditKind, type AuditKind } from "../lib/auditKind";
import { Icon, type IconName } from "./Icon";

// The icon of each kind of event (lib/auditKind.ts); it is decoration, the sentence says the same.
const KIND_ICON: Record<AuditKind, IconName> = {
  signin: "evSignIn", problem: "evProblem", create: "evCreate", change: "evChange", delete: "evDelete", settings: "evSettings", other: "evOther",
};

/** The tile of an event's kind, the same in a row of the log and in the drawer that opens from it. */
export function KindTile({ action }: { action: string }) {
  const kind = auditKind(action);
  return <span className="ev-tile" data-kind={kind} aria-hidden="true"><Icon name={KIND_ICON[kind]} /></span>;
}

/** Who did it: an initial disc (decoration) and the name; no user is a dash. */
export function UserLabel({ name }: { name: string | null }) {
  const initial = name ? (Array.from(name.trim())[0] ?? "").toUpperCase() : "";
  return name ? <><span className="user-disc" aria-hidden="true">{initial}</span>{name}</> : <>—</>;
}
