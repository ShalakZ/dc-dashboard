import { checksText, claimedCount, outcomeLabel, plural, recognisedText, scopeDetail, scopeLine, sourcesAndPoints, statWords } from "./scanText";

describe("outcomeLabel", () => {
  it("writes outcomes as words; claimed stays as it is (the end-to-end test looks for it)", () => {
    expect(outcomeLabel("claimed")).toBe("claimed");
    expect(outcomeLabel("needs_credentials")).toBe("needs credentials");
    expect(outcomeLabel("unclaimed")).toBe("unidentified");
  });
  it("shows an outcome it does not know with its underscores turned into spaces", () => {
    expect(outcomeLabel("some_new_outcome")).toBe("some new outcome");
  });
});

describe("claimedCount", () => {
  it("leaves out the sources that rejected the credentials", () => {
    expect(claimedCount({ claimed: 5, needs_credentials: 2 })).toBe(3);
  });
  it("treats a missing counter as zero and never goes negative", () => {
    expect(claimedCount({})).toBe(0);
    expect(claimedCount({ claimed: 1 })).toBe(1);
    expect(claimedCount({ claimed: 1, needs_credentials: 3 })).toBe(0);
  });
});

describe("scopeLine", () => {
  it("writes the name, the targets and the ports", () => {
    expect(scopeLine("Simulator", ["172.20.0.0/24"], [9000, 4840, 5020])).toBe("Simulator: 172.20.0.0/24, ports 9000 (simulator), 4840 (OPC UA), 5020 (Modbus, simulator)");
  });
  it("says port, not ports, for one port", () => {
    expect(scopeLine("Simulator", ["172.20.0.0/24"], [9000])).toBe("Simulator: 172.20.0.0/24, port 9000 (simulator)");
  });
  it("keeps several targets in the order the scope has them", () => {
    expect(scopeLine("lab", ["10.0.0.0/30", "simulator"], [502])).toBe("lab: 10.0.0.0/30, simulator, port 502 (Modbus)");
  });
  it("never cuts the targets or the ports: a long scope is whole on the line", () => {
    const targets = ["a", "b", "c", "d", "e", "f", "g"];
    const ports = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(scopeLine("big", targets, ports)).toBe("big: a, b, c, d, e, f, g, ports 1, 2, 3, 4, 5, 6, 7, 8, 9, 10");
    const fifty = Array.from({ length: 50 }, (_, i) => `10.9.0.${i + 1}`);
    expect(scopeLine("fifty", fifty, [502, 4840])).toBe(`fifty: ${fifty.join(", ")}, ports 502 (Modbus), 4840 (OPC UA)`);
    expect(scopeLine("fifty", fifty, [502, 4840])).not.toMatch(/more/);
  });
  it("says ports for two ports", () => {
    expect(scopeLine("p", [], [1, 2])).toBe("p: ports 1, 2");
  });
  it("leaves out the half that is missing", () => {
    expect(scopeLine("only targets", ["simulator"], [])).toBe("only targets: simulator");
    expect(scopeLine("only ports", [], [9000])).toBe("only ports: port 9000 (simulator)");
  });
  it("is just the name when the scan has neither (an old scan, or a snapshot without them)", () => {
    expect(scopeLine("Simulator", [], [])).toBe("Simulator");
  });
});

describe("scopeDetail", () => {
  it("is the line without the name and without the cut, so every target and port is in it", () => {
    expect(scopeDetail(["172.20.0.0/24"], [9000, 4840, 5020])).toBe("172.20.0.0/24, ports 9000 (simulator), 4840 (OPC UA), 5020 (Modbus, simulator)");
    expect(scopeDetail(["a", "b", "c", "d", "e"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 4080])).toBe("a, b, c, d, e, ports 1, 2, 3, 4, 5, 6, 7, 8, 9, 4080");
  });
  it("says port for one, leaves out the missing half, and is empty for an old scan", () => {
    expect(scopeDetail(["simulator"], [4080])).toBe("simulator, port 4080");
    expect(scopeDetail([], [4080])).toBe("port 4080");
    expect(scopeDetail(["simulator"], [])).toBe("simulator");
    expect(scopeDetail([], [])).toBe("");
  });
});

describe("sourcesAndPoints", () => {
  it("reads the sources recognised and the points found, as words", () => {
    expect(sourcesAndPoints({ claimed: 2, needs_credentials: 1, points: 60 })).toBe("1 source, 60 points");
    expect(sourcesAndPoints({ claimed: 3, points: 120 })).toBe("3 sources, 120 points");
  });
  it("is plural-aware for points too, and zero is plural", () => {
    expect(sourcesAndPoints({ claimed: 1, points: 1 })).toBe("1 source, 1 point");
    expect(sourcesAndPoints({})).toBe("0 sources, 0 points");
  });
});

describe("recognisedText", () => {
  it("is the longer wording of the Recent scans title", () => {
    expect(recognisedText({ claimed: 2, needs_credentials: 1, points: 60 })).toBe("1 source recognised, 60 points found");
    expect(recognisedText({ claimed: 3, points: 1 })).toBe("3 sources recognised, 1 point found");
    expect(recognisedText({})).toBe("0 sources recognised, 0 points found");
  });
});

describe("checksText", () => {
  it("says what was checked and how: hosts times ports, when the checks are exactly that", () => {
    expect(checksText({ hosts: 254, pairs: 762, checked: 762 }, false)).toBe("762 checks (254 hosts × 3 ports)");
    expect(checksText({ hosts: 1, pairs: 3, checked: 3 }, false)).toBe("3 checks (1 host × 3 ports)");
    expect(checksText({ hosts: 3, pairs: 3, checked: 3 }, false)).toBe("3 checks (3 hosts × 1 port)");
    expect(checksText({ hosts: 1, pairs: 1, checked: 1 }, false)).toBe("1 check (1 host × 1 port)");
  });
  it("says how far a scan got while it runs", () => {
    expect(checksText({ hosts: 254, pairs: 762, checked: 310 }, true)).toBe("310 of 762 checks");
    expect(checksText({ hosts: 1, pairs: 3, checked: 2, open: 1 }, true)).toBe("2 of 3 checks");
    expect(checksText({ hosts: 1, pairs: 1, checked: 0 }, true)).toBe("0 of 1 check");
  });
  it("says just the number when the split is not exact, or there are no hosts", () => {
    expect(checksText({ hosts: 254, pairs: 763, checked: 763 }, false)).toBe("763 checks");
    expect(checksText({ hosts: 0, pairs: 0, checked: 0 }, false)).toBe("0 checks");
    expect(checksText({ hosts: 0, pairs: 6, checked: 6 }, false)).toBe("6 checks");
  });
  it("treats a missing counter as zero, whatever the state", () => {
    expect(checksText({}, false)).toBe("0 checks");
    expect(checksText({}, true)).toBe("0 checks");
    expect(checksText({ pairs: 6 }, true)).toBe("0 of 6 checks");
    expect(checksText({ pairs: 6, hosts: 2 }, false)).toBe("6 checks (2 hosts × 3 ports)");
  });
});

describe("statLine words (the drawer's stats row)", () => {
  it("counts in words with the plural the number needs", () => {
    expect(statWords({ open: 3, claimed: 2, needs_credentials: 1, points: 1, unidentified: 0 })).toEqual([
      "3 open", "1 source recognised", "1 point", "1 needs credentials", "0 unidentified",
    ]);
    expect(statWords({ open: 1, claimed: 4, needs_credentials: 2, points: 60, unidentified: 1 })).toEqual([
      "1 open", "2 sources recognised", "60 points", "2 need credentials", "1 unidentified",
    ]);
    expect(statWords({})).toEqual(["0 open", "0 sources recognised", "0 points", "0 need credentials", "0 unidentified"]);
  });
});

describe("plural", () => {
  it("puts the count before the word and adds an s except for one", () => {
    expect(plural(1, "host")).toBe("1 host");
    expect(plural(0, "host")).toBe("0 hosts");
    expect(plural(3, "port")).toBe("3 ports");
  });
  it("takes the many-form when the word does not just add an s", () => {
    expect(plural(1, "match", "matches")).toBe("1 match");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
});

describe("names of the ports in the scope text", () => {
  it("names a known port and leaves a typo as the bare number beside its named neighbours", () => {
    expect(scopeDetail(["simulator"], [9000, 4080])).toBe("simulator, ports 9000 (simulator), 4080");
    expect(scopeDetail([], [4080])).toBe("port 4080");
    expect(scopeLine("Typo", ["simulator"], [9000, 4080])).toBe("Typo: simulator, ports 9000 (simulator), 4080");
  });
});
