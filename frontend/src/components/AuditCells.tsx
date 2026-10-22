import type { AuditOutcome } from "../api/types";
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

/**
 * The square tag after the sentence of a started check or test: the word passed, failed or running (the colour never speaks alone), the whole sentence in
 * its title. Nothing for an outcome that is no longer kept, and nothing for an entry without one: the row is then exactly what it was. The tag is
 * the one of the System events page (styles/tags-events.css); `what-outcome` only spaces it from the sentence (styles/audit-outcome.css).
 */
export function OutcomeTag({ outcome }: { outcome: AuditOutcome | null }) {
  if (!outcome || outcome.state === "gone") return null;
  return <span className={`ev-tag ev-tag-${outcome.state} what-outcome`} title={outcome.text}>{outcome.state}</span>;
}
