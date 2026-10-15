import { COMMON_PORTS, INDUSTRIAL_PORTS, knownPorts, PORT_NAMES, portHint, portHints, portLabel, portName, portsLine, readPorts } from "./ports";

describe("port names", () => {
  it("names the ports the connectors and the dev simulator use", () => {
    expect(PORT_NAMES).toEqual({ 502: "Modbus", 4840: "OPC UA", 9000: "simulator", 5020: "Modbus, simulator" });
    expect(portName(4840)).toBe("OPC UA");
    expect(portName(4080)).toBeUndefined();
  });
  it("writes a label as the number with its name in brackets, or the bare number", () => {
    expect(portLabel(4840)).toBe("4840 (OPC UA)");
    expect(portLabel(5020)).toBe("5020 (Modbus, simulator)");
    expect(portLabel(4080)).toBe("4080");
  });
  it("reads a list of ports as labels, in the order given", () => {
    expect(portsLine([9000, 4840, 4080])).toBe("9000 (simulator), 4840 (OPC UA), 4080");
    expect(portsLine([502])).toBe("502 (Modbus)");
    expect(portsLine([])).toBe("");
  });
  it("lists the known ports: the named ones plus the server's, each once, in order", () => {
    expect(knownPorts()).toEqual([502, 4840, 5020, 9000]);
    expect(knownPorts([4840, 502, 20000])).toEqual([502, 4840, 5020, 9000, 20000]);
  });
});

describe("portHint (the typo guard)", () => {
  // The table of the plan, Decision 6: a port that looks like a typo of a known one warns; everything else is left alone.
  const WARNS: [number, number][] = [
    [4080, 4840], // two letters off, same length and first digit
    [4048, 4840],
    [4804, 4840], // two neighbours swapped
    [484, 4840], // a digit missing
    [48400, 4840], // a digit too many
    [5022, 5020], // same length beats the shorter 502
    [503, 502],
  ];
  it.each(WARNS)("%i looks like %i", (typed, near) => {
    const hint = portHint(typed);
    expect(hint?.near).toBe(near);
    expect(hint?.port).toBe(typed);
  });
  it("says it as a plain sentence naming the likely port", () => {
    expect(portHint(4080)?.text).toBe("4080 is not a port any connector uses; did you mean 4840 (OPC UA)?");
    expect(portHint(5022)?.text).toBe("5022 is not a port any connector uses; did you mean 5020 (Modbus, simulator)?");
  });

  const QUIET = [502, 4840, 9000, 5020, 4843, 802, 102, 1502, 9100, 9600, 9300, 9001, 6000, 7000, 2000, 1000, 80, 443, 8080, 8443, 3306, 22, 65535, 1, 7, 12345];
  it.each(QUIET)("%i is left alone", (typed) => {
    expect(portHint(typed)).toBeNull();
  });
  it("leaves alone the common and industrial ports it knows by number", () => {
    for (const port of [...COMMON_PORTS, ...INDUSTRIAL_PORTS]) expect(portHint(port), String(port)).toBeNull();
    expect(COMMON_PORTS).toEqual(expect.arrayContaining([5001, 4000, 4443]));
  });
  it("may still warn about a port one digit off a known one (a gentle warning, never a block)", () => {
    expect(portHint(4800)?.near).toBe(4840);
    expect(portHint(5002)?.near).toBe(5020);
  });
  it("does not warn about a port with fewer than three digits, whatever it looks like", () => {
    expect(portHint(50)).toBeNull();
    expect(portHint(48)).toBeNull();
  });

  it("is not nagged by the demo port: 9000 is named but is not something to chase (9001 is exempt anyway, 9010 and 8000 are not close)", () => {
    expect(portHint(9010)).toBeNull();
    expect(portHint(9100)).toBeNull();
    expect(portHint(8000)).toBeNull();
  });

  it("uses the server's suggested ports too, and still works from the static names alone", () => {
    expect(portHint(20001)).toBeNull(); // not near anything the page knows by itself
    expect(portHint(20001, knownPorts([20000]))?.near).toBe(20000);
    expect(portHint(4080, knownPorts([]))?.near).toBe(4840);
    expect(portHint(4080, [])).toBeNull(); // an empty list is the caller's choice: nothing to compare with
  });
  it("picks the nearer port first, then the one of the same length, then the smaller", () => {
    // 5021 is one letter off 5020 and one digit more than 502: 5020 (distance 1) and 502 (distance 1) tie, the same length wins
    expect(portHint(5021)?.near).toBe(5020);
    // 4841 vs 4840 (1) and 484? none: the nearer wins over a farther anchor of the same length
    expect(portHint(4841)?.near).toBe(4840);
    // equal in every respect: the smaller of two anchors
    expect(portHint(1002, [1000, 1004])?.near).toBe(1000);
  });
});

describe("portHints (the warnings for a typed list)", () => {
  it("is empty for good ports and carries one warning per suspect port, once each", () => {
    expect(portHints([502, 4840, 9000]).lines).toEqual([]);
    expect(portHints([9000, 4080, 4080]).lines).toEqual(["4080 is not a port any connector uses; did you mean 4840 (OPC UA)?"]);
  });
  it("lists at most three and counts the rest", () => {
    const out = portHints([4080, 4048, 4804, 503, 5022]);
    expect(out.lines).toHaveLength(3);
    expect(out.more).toBe(2);
    expect(portHints([4080, 4048, 4804]).more).toBe(0);
  });
});

describe("readPorts (what the Ports field holds, leniently)", () => {
  it("reads ports separated by commas or spaces, in order, and keeps a repeat", () => {
    expect(readPorts("9000, 4840 5020,502")).toEqual([9000, 4840, 5020, 502]);
    expect(readPorts("502 502")).toEqual([502, 502]);
  });
  it("leaves out what is not a port while it is typed: a word, zero, too big, a half-typed number", () => {
    expect(readPorts("")).toEqual([]);
    expect(readPorts("abc 80 0 99999 65536 12x 65535")).toEqual([80, 65535]);
    expect(readPorts("4840,")).toEqual([4840]);
  });
});
