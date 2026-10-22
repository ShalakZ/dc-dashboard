import { keys } from "../api/queries";
import { ApiError } from "../api/client";
import type { Source } from "../api/types";
import { INSTANCE_MATCH, moveBody, movePreview, moveDone, moveUndone, NEW_NAME, OLD_NAME, POSSIBLY_MATCH, URI_MATCH } from "../test/moveFixtures";
import { mockFetch } from "../test/fetchMock";
import {
  addressOptions, effectLines, fromToLine, hostNameLine, hostPort, hostPortOfEndpoint, isChangedSincePreview, isIpAddress, MOVE_REFRESHED, moveButtonLabel,
  movedSentence, moveRequest, needsConfirmation, offerOf, previewMove, runMove, SCAN_RUNNING_TEXT, tickLabel, TWO_SERVERS_TEXT, undoMove, undoMoveSentence, undoRefusal, warningLines,
  whyLines,
} from "./moves";

describe("hostPort and hostPortOfEndpoint", () => {
  it("writes host:port as the preview shows it", () => {
    expect(hostPort({ host: "172.20.0.5", port: 4840 })).toBe("172.20.0.5:4840");
    expect(hostPort({ host: "simulator", port: 9000 })).toBe("simulator:9000");
  });

  it("reads host:port out of a display endpoint, keeping a port that a URL parser would drop", () => {
    expect(hostPortOfEndpoint("opc.tcp://172.20.0.5:4840/dcdash/")).toBe("172.20.0.5:4840");
    expect(hostPortOfEndpoint("http://simulator:9000/")).toBe("simulator:9000");
    expect(hostPortOfEndpoint("http://simulator:80/")).toBe("simulator:80");
    expect(hostPortOfEndpoint("opc.tcp://[fe80::1]:4840/x")).toBe("[fe80::1]:4840");
    expect(hostPortOfEndpoint("opc.tcp://meter-12/dcdash")).toBe("meter-12");
  });

  it("never prints a user name or a password, should an endpoint carry one", () => {
    expect(hostPortOfEndpoint("opc.tcp://user:secret@172.20.0.5:4840/dcdash/")).toBe("172.20.0.5:4840");
  });

  it("gives a text that is not an endpoint back as it is", () => {
    expect(hostPortOfEndpoint("not an endpoint")).toBe("not an endpoint");
  });
});

describe("isIpAddress", () => {
  it("is true for an IPv4 or IPv6 address and false for a name", () => {
    expect(isIpAddress("172.20.0.5")).toBe(true);
    expect(isIpAddress("fe80::1")).toBe(true);
    expect(isIpAddress("[fe80::1]")).toBe(true);
    expect(isIpAddress("simulator")).toBe(false);
    expect(isIpAddress("meter-12.plant.local")).toBe(false);
    expect(isIpAddress("999.20.0.5")).toBe(false);
  });
});

describe("the sentences of the preview", () => {
  it("says from where to where, with the endpoints the server answered", () => {
    expect(fromToLine(movePreview())).toBe("From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://172.20.0.5:4840/dcdash/");
  });

  it("says why, in words: the application URI, the simulator instance, or the mapped addresses", () => {
    expect(whyLines(movePreview({ match: URI_MATCH }))).toEqual(["Both answer with the application URI urn:dcdash:simulator:dev."]);
    expect(whyLines(movePreview({ match: INSTANCE_MATCH }))).toEqual(['Both are DCDash simulator instance "dev".']);
    expect(whyLines(movePreview({ match: POSSIBLY_MATCH }))).toEqual(["All 12 mapped addresses and their names exist on the new server."]);
    expect(whyLines(movePreview({ match: { ...POSSIBLY_MATCH, addresses: 1 } }))).toEqual(["The only mapped address and its name exist on the new server."]);
  });

  it("adds that a server without a certificate is known by its URI only, when the dialog asks for a tick", () => {
    expect(whyLines(movePreview({ match: URI_MATCH, needs_tick: true }))).toEqual([
      "Both answer with the application URI urn:dcdash:simulator:dev.", "It is identified by its application URI only.",
    ]);
    expect(whyLines(movePreview({ match: INSTANCE_MATCH, needs_tick: true }))[1]).toBe("It is identified by its instance id only.");
  });

  it("does not add that to a possible match (it is worded by the tick)", () => {
    expect(whyLines(movePreview({ match: POSSIBLY_MATCH, needs_tick: true }))).toHaveLength(1);
  });

  it("warns, with numbers, about addresses the new server lacks, and says so when it could not be browsed", () => {
    expect(warningLines(movePreview({ match: { ...URI_MATCH, addresses: 9, missing_addresses: 3 } }))).toEqual([
      "3 of 12 mapped addresses were not found on the new server; their values will read as bad until they exist.",
    ]);
    expect(warningLines(movePreview({ match: { ...URI_MATCH, addresses: 11, missing_addresses: 1 } }))).toEqual([
      "1 of 12 mapped addresses was not found on the new server; its value will read as bad until it exists.",
    ]);
    expect(warningLines(movePreview({ match: { ...URI_MATCH, addresses: 0, missing_addresses: null } }))).toEqual([
      "The new address could not be browsed without credentials; this source's credentials will be used.",
    ]);
    expect(warningLines(movePreview())).toEqual([]);
  });

  it("says what else happens: the mappings stay, the duplicate goes, the name changes or stays, readings stay after an Undo", () => {
    expect(effectLines(movePreview())).toEqual([
      "Its 12 mappings on 3 assets keep their points and readings.",
      "The new source found by the scan (40 points) is removed; its points were never mapped.",
      `The name changes from "${OLD_NAME}" to "${NEW_NAME}".`,
      "Readings taken after the move stay after an Undo.",
    ]);
    expect(effectLines(movePreview({ rename: null, mappings: 1, assets: 1, target: { id: 7, name: NEW_NAME, points: 1 } }))).toEqual([
      "Its 1 mapping on 1 asset keeps its point and readings.",
      "The new source found by the scan (1 point) is removed; its point was never mapped.",
      `The name stays "${OLD_NAME}".`,
      "Readings taken after the move stay after an Undo.",
    ]);
    expect(effectLines(movePreview({ target: { id: 7, name: NEW_NAME, points: 0 } }))[1]).toBe("The new source found by the scan is removed; it has no points.");
    expect(effectLines(movePreview({ mappings: 1234 }))[0]).toBe("Its 1,234 mappings on 3 assets keep their points and readings.");
  });

  it("names the old host when it is a name and not an address (F7b)", () => {
    expect(hostNameLine(movePreview())).toBeNull();
    const named = movePreview({ from: { host: "simulator", port: 4840, endpoint: "opc.tcp://simulator:4840/dcdash/" } });
    expect(hostNameLine(named)).toBe("This source uses the name simulator; the move replaces it with the address 172.20.0.5.");
    const both = movePreview({
      from: { host: "sim-old", port: 4840, endpoint: "opc.tcp://sim-old:4840/dcdash/" },
      to: { host: "simulator", port: 4840, endpoint: "opc.tcp://simulator:4840/dcdash/" }, address: "name",
    });
    expect(hostNameLine(both)).toBe("This source uses the name sim-old; the move replaces it with the name simulator.");
  });

  it("words the tick for a possible match and for a server known by its URI only, and asks for none otherwise", () => {
    expect(tickLabel(movePreview())).toBeNull();
    expect(tickLabel(movePreview({ match: POSSIBLY_MATCH, needs_tick: true }))).toBe("I checked that this is the same device");
    expect(tickLabel(movePreview({ match: URI_MATCH, needs_tick: true }))).toBe("I checked that this is the same server");
  });

  it("words the Move button with the number of mappings, singular for one", () => {
    expect(moveButtonLabel(12)).toBe("Move 12 mappings");
    expect(moveButtonLabel(1)).toBe("Move 1 mapping");
    expect(moveButtonLabel(1234)).toBe("Move 1,234 mappings");
    expect(moveButtonLabel(null)).toBe("Move");
  });

  it("offers the container's name first when the address has one, and the address as the other way", () => {
    expect(addressOptions(movePreview(), "172.20.0.5")).toEqual([]);
    expect(addressOptions(movePreview({ name_hint: "simulator" }), "172.20.0.5")).toEqual([
      { value: "name", label: "Use the name simulator (it keeps working when Docker gives the container a new address)" },
      { value: "as_found", label: "Use the address 172.20.0.5" },
    ]);
  });

  it("has the two fixed sentences", () => {
    expect(SCAN_RUNNING_TEXT).toBe("A scan is running; you can move when it has finished");
    expect(TWO_SERVERS_TEXT).toBe("Two servers could be this one; edit the address by hand");
  });

  it("words the toast of a finished move from the answer: the new name and address, and how many mappings were kept", () => {
    expect(movedSentence(moveDone(), 12)).toBe(`Moved "${NEW_NAME}" to 172.20.0.5:4840. 12 mappings kept.`);
    expect(movedSentence(moveDone(), 1)).toBe(`Moved "${NEW_NAME}" to 172.20.0.5:4840. 1 mapping kept.`);
    expect(movedSentence(moveDone(), 1234)).toBe(`Moved "${NEW_NAME}" to 172.20.0.5:4840. 1,234 mappings kept.`);
  });

  it("leaves the count of mappings out, and still ends the sentence, when the opener does not know it", () => {
    expect(movedSentence(moveDone())).toBe(`Moved "${NEW_NAME}" to 172.20.0.5:4840.`);
    expect(movedSentence(moveDone(), null)).toBe(`Moved "${NEW_NAME}" to 172.20.0.5:4840.`);
  });
});

describe("moveRequest", () => {
  it("builds the real request from the preview the person saw, not from the radio state", () => {
    expect(moveRequest(movePreview())).toEqual(moveBody());
    const byName = movePreview({ address: "name", name_hint: "simulator", to: { host: "simulator", port: 4840, endpoint: "opc.tcp://simulator:4840/dcdash/" }, rename: null });
    expect(moveRequest(byName)).toEqual(moveBody({ address: "name", expect: { address_after: "simulator:4840", name_after: null } }));
  });

  it("sends what the match was, so the server can refuse if the reason for the move has changed", () => {
    const body = moveRequest(movePreview({ match: POSSIBLY_MATCH, needs_tick: true }));
    expect(body.expect).toMatchObject({ match_kind: "possibly", needs_tick: true });
    expect(moveRequest(movePreview({ match: INSTANCE_MATCH })).expect).toMatchObject({ match_kind: "same_server", needs_tick: false });
  });

  it("says ticked false unless the box was ticked, and true exactly when it was", () => {
    const needsTick = movePreview({ match: POSSIBLY_MATCH, needs_tick: true });
    expect(moveRequest(needsTick)).toHaveProperty("ticked", false);
    expect(moveRequest(needsTick, false)).toHaveProperty("ticked", false);
    expect(moveRequest(needsTick, true)).toEqual(moveBody({ expect: { match_kind: "possibly", needs_tick: true }, ticked: true }));
    expect(moveRequest(movePreview())).toHaveProperty("ticked", false);
  });
});

describe("needsConfirmation", () => {
  it("knows the refusal that says the match must be confirmed", () => {
    expect(needsConfirmation(new ApiError(409, "The match needs your confirmation: tick that you checked it is the same device"))).toBe(true);
    expect(needsConfirmation(new ApiError(409, "the match needs your confirmation: tick that you checked it is the same device"))).toBe(true);
    expect(needsConfirmation(new ApiError(409, "changed since the preview: it was 12 mappings, now 11"))).toBe(false);
    expect(needsConfirmation(new ApiError(422, "The match needs your confirmation"))).toBe(false);
    expect(needsConfirmation(new Error("The match needs your confirmation"))).toBe(false);
  });
});

describe("the calls", () => {
  it("asks the dry run with dry_run=1 and the body {to, address}", async () => {
    const seen: { url: string; body: unknown }[] = [];
    mockFetch({ "POST /api/sources/2/move": ({ url, body }) => { seen.push({ url, body }); return { body: movePreview() }; } });
    const got = await previewMove(2, { to: 7, address: "as_found" });
    expect(got.mappings).toBe(12);
    expect(seen).toEqual([{ url: "/api/sources/2/move?dry_run=1", body: { to: 7, address: "as_found" } }]);
  });

  it("sends the real run with dry_run=0 and the expect block", async () => {
    const seen: { url: string; body: unknown }[] = [];
    mockFetch({ "POST /api/sources/2/move": ({ url, body }) => { seen.push({ url, body }); return { body: moveDone() }; } });
    const request = moveRequest(movePreview());
    const got = await runMove(2, request);
    expect(got.audit_id).toBe(31);
    expect(seen).toEqual([{ url: "/api/sources/2/move?dry_run=0", body: request }]);
  });

  it("knows the refusal that means the preview is out of date", () => {
    expect(isChangedSincePreview(new ApiError(409, "changed since the preview: it was 12 mappings, now 11"))).toBe(true);
    expect(isChangedSincePreview(new ApiError(409, "a scan is running"))).toBe(false);
    expect(isChangedSincePreview(new ApiError(422, "changed since the preview"))).toBe(false);
    expect(isChangedSincePreview(new Error("changed since the preview"))).toBe(false);
  });
});

describe("the Undo of a move", () => {
  it("posts to /api/sources/moves/{audit_id}/undo and gives the answer back", async () => {
    const seen: { url: string; body: unknown }[] = [];
    mockFetch({ "POST /api/sources/moves/31/undo": ({ url, body }) => { seen.push({ url, body }); return { body: moveUndone() }; } });
    const got = await undoMove(31);
    expect(got.restored).toEqual({ host: "172.20.0.3", port: 4840, name: OLD_NAME });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/sources/moves/31/undo");
  });

  it("says the server's sentence when readings were taken at the new address, and adds the readings that stay", () => {
    const plain = moveUndone({ readings_since_move: 0 });
    expect(undoMoveSentence(plain)).toBe(plain.text);
    expect(undoMoveSentence(moveUndone({ readings_since_move: 120 }))).toBe(`${plain.text} 120 readings taken at the new address stay.`);
    expect(undoMoveSentence(moveUndone({ readings_since_move: 1 }))).toBe(`${plain.text} 1 reading taken at the new address stays.`);
    expect(undoMoveSentence(moveUndone({ readings_since_move: 12_345 }))).toContain("12,345 readings taken at the new address stay.");
  });

  it("does not say the readings twice when the server's own sentence already tells about them, and closes a sentence that has no full stop", () => {
    const told = moveUndone({ text: "Moved back to 172.20.0.3:4840. 120 readings taken at the new address stay.", readings_since_move: 120 });
    expect(undoMoveSentence(told)).toBe(told.text);
    expect(undoMoveSentence(moveUndone({ text: "Moved back", readings_since_move: 3 }))).toBe("Moved back. 3 readings taken at the new address stay.");
  });

  it("falls back to its own words from the restored address when an answer carries no sentence", () => {
    expect(undoMoveSentence(moveUndone({ text: "", readings_since_move: 0 }))).toBe(`"${OLD_NAME}" is back at 172.20.0.3:4840.`);
    expect(undoMoveSentence(moveUndone({ text: "  ", readings_since_move: 2 }))).toBe(`"${OLD_NAME}" is back at 172.20.0.3:4840. 2 readings taken at the new address stay.`);
  });

  it("starts the server's refusal with a capital and ends it with a full stop (409 already undone, 410 too old)", () => {
    expect(undoRefusal(new ApiError(409, "this move was already undone"))).toBe("This move was already undone.");
    expect(undoRefusal(new ApiError(410, "this move is older than 24 hours and can no longer be undone."))).toBe("This move is older than 24 hours and can no longer be undone.");
    expect(undoRefusal(new Error("Failed to fetch"))).toBe("Failed to fetch.");
    expect(undoRefusal("odd")).toBe("Odd.");
  });
});

describe("what a move makes stale", () => {
  it("refreshes the sources (and so their points), the graph, the scans, the audit log and the events", () => {
    expect(MOVE_REFRESHED).toEqual([keys.sources, keys.graph, keys.scans, keys.auditAll, keys.eventsAll]);
  });

  it("covers the points queries of a source: they sit under the sources prefix, which the refresh matches by prefix", () => {
    expect(keys.points(2).slice(0, keys.sources.length)).toEqual([...keys.sources]);
  });
});

describe("offerOf", () => {
  const base: Source = { id: 2, name: OLD_NAME, connector_type: "opcua", config: {}, origin: "manual", enabled: true, status: "offline", last_seen: null, last_error: null, has_secret: false };
  const offer = { kind: "offer" as const, to_source_id: 7, to_name: NEW_NAME, to_endpoint: "opc.tcp://172.20.0.5:4840/dcdash/", match: URI_MATCH };

  it("returns the offer of a source, and nothing for 'two', null or a missing field", () => {
    expect(offerOf({ ...base, move_candidate: offer })).toBe(offer);
    expect(offerOf({ ...base, move_candidate: { kind: "two", count: 2 } })).toBeNull();
    expect(offerOf({ ...base, move_candidate: null })).toBeNull();
    expect(offerOf(base)).toBeNull();
  });
});
