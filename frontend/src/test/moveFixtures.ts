import type { SourceMoveDone, SourceMoveMatch, SourceMovePreview, SourceMoveUndoResult } from "../api/types";

/** Why a move is offered, for the tests of the move dialog (w33). No endpoint here carries a user name or a password. */
export const URI_MATCH: SourceMoveMatch = {
  kind: "same_server", evidence: "uri", value: "urn:dcdash:simulator:dev", addresses: 12, missing_addresses: 0, needs_tick: false,
};
export const INSTANCE_MATCH: SourceMoveMatch = {
  kind: "same_server", evidence: "instance", value: "dev", addresses: 12, missing_addresses: 0, needs_tick: false,
};
export const POSSIBLY_MATCH: SourceMoveMatch = {
  kind: "possibly", evidence: "addresses", value: null, addresses: 12, missing_addresses: 0, needs_tick: true,
};

export const OLD_NAME = "OPC UA server at 172.20.0.3:4840";
export const NEW_NAME = "OPC UA server at 172.20.0.5:4840";

/** The answer to the dry run of the owner's case: the same server (certificate and URI), 12 mappings on 3 assets, the name follows the address. */
export function movePreview(over: Partial<SourceMovePreview> = {}): SourceMovePreview {
  return {
    dry_run: true,
    scan_running: false,
    source: { id: 2, name: OLD_NAME },
    target: { id: 7, name: NEW_NAME, points: 40 },
    from: { host: "172.20.0.3", port: 4840, endpoint: "opc.tcp://172.20.0.3:4840/dcdash/" },
    to: { host: "172.20.0.5", port: 4840, endpoint: "opc.tcp://172.20.0.5:4840/dcdash/" },
    address: "as_found",
    name_hint: null,
    rename: { from: OLD_NAME, to: NEW_NAME },
    match: URI_MATCH,
    mappings: 12,
    mapped_points: 12,
    assets: 3,
    needs_tick: false,
    ...over,
  };
}

/** The answer to the real run. */
export function moveDone(over: Partial<SourceMoveDone> = {}): SourceMoveDone {
  return {
    dry_run: false,
    audit_id: 31,
    source: { id: 2, name: NEW_NAME },
    from: { host: "172.20.0.3", port: 4840, endpoint: "opc.tcp://172.20.0.3:4840/dcdash/" },
    to: { host: "172.20.0.5", port: 4840, endpoint: "opc.tcp://172.20.0.5:4840/dcdash/" },
    rename: { from: OLD_NAME, to: NEW_NAME },
    undo_until: "2026-10-23T08:00:00+00:00",
    ...over,
  };
}

/** The answer to the Undo of that move: the old source is back at its old address and name. */
export function moveUndone(over: Partial<SourceMoveUndoResult> = {}): SourceMoveUndoResult {
  return {
    source: { id: 2, name: OLD_NAME },
    restored: { host: "172.20.0.3", port: 4840, name: OLD_NAME },
    readings_since_move: 0,
    text: `Moved "${OLD_NAME}" back to 172.20.0.3:4840.`,
    ...over,
  };
}
