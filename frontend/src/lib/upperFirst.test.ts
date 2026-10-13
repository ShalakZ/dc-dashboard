import { upperFirst } from "./upperFirst";

describe("upperFirst", () => {
  it("capitalises the first letter and leaves the rest alone", () => {
    expect(upperFirst("invalid username or password")).toBe("Invalid username or password");
    expect(upperFirst("too many failed attempts, try again in about 1 minute")).toBe("Too many failed attempts, try again in about 1 minute");
    expect(upperFirst("OPC UA is down")).toBe("OPC UA is down");
  });
  it("copes with an empty text and one that starts with a digit or a symbol", () => {
    expect(upperFirst("")).toBe("");
    expect(upperFirst("502 Bad Gateway")).toBe("502 Bad Gateway");
  });
});
