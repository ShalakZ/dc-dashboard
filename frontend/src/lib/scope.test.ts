import { parsePorts, parseTargets } from "./scope";

describe("scope parsing", () => {
  it("splits targets on lines and commas and drops blanks", () => {
    expect(parseTargets("10.0.0.0/24\n simulator ,, http://plc:8080 \n")).toEqual(["10.0.0.0/24", "simulator", "http://plc:8080"]);
    expect(parseTargets("  \n ")).toEqual([]);
  });
  it("parses ports separated by commas or spaces", () => {
    expect(parsePorts("9000, 4840 5020")).toEqual([9000, 4840, 5020]);
  });
  it.each(["", "  ", "0", "70000", "80,abc", "1.5", "-2"])("rejects %j", (text) => {
    expect(() => parsePorts(text)).toThrow();
  });
});
