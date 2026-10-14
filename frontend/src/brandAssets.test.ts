import { readFileSync } from "node:fs";

// The static brand files (W7n) are made by scripts/make-brand-assets.mjs from the owner's docs/brand/logo-original.svg.
// vitest runs from the frontend directory.
const original = readFileSync("../docs/brand/logo-original.svg", "utf8");
const logoMark = readFileSync("public/logo-mark.svg", "utf8");
const favicon = readFileSync("public/favicon.svg", "utf8");

const pathLines = (text: string) => text.split("\n").filter((line) => line.startsWith("<path "));
const fillOf = (line: string) => /fill="([^"]+)"/.exec(line)?.[1];
const originalLines = pathLines(original);

const view = (path: string) => {
  const bytes = readFileSync(path);
  // Node hands back small files as slices of a shared pool, so the offset and length matter
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const signatureAt = (data: DataView, at: number) => PNG_SIGNATURE.map((_, i) => data.getUint8(at + i));
const pngSize = (data: DataView, at = 0) => ({ width: data.getUint32(at + 16), height: data.getUint32(at + 20) }); // IHDR, big-endian

describe("logo-mark.svg", () => {
  it("holds exactly the owner's square, M and wedge, in that order", () => {
    expect((logoMark.match(/<path/g) ?? []).length).toBe(3);
    expect(pathLines(logoMark).map(fillOf)).toEqual(["#D29E12", "#FCFBF7", "#161616"]);
  });

  it("keeps each path line byte for byte from the original", () => {
    for (const line of pathLines(logoMark)) expect(originalLines).toContain(line);
  });

  it("has no white wordmark, comment, size or metadata", () => {
    expect(logoMark).not.toMatch(/#ffffff/i);
    expect(logoMark).not.toContain("<!--");
    expect(logoMark).not.toMatch(/\b(width|height)=/);
    expect(logoMark).toContain('viewBox="33 32 155 150"');
  });
});

describe("favicon.svg", () => {
  it("holds the same three path lines", () => {
    expect((favicon.match(/<path/g) ?? []).length).toBe(3);
    expect(pathLines(favicon)).toEqual(pathLines(logoMark));
    for (const line of pathLines(favicon)) expect(originalLines).toContain(line);
  });

  it("is square, with the 2.5 unit bands above and below the mark", () => {
    expect(favicon).toContain('viewBox="33 29.5 155 155"');
    expect(favicon).not.toMatch(/#ffffff/i);
    expect(favicon).not.toContain("<!--");
    expect(favicon).not.toMatch(/\b(width|height)=/);
  });
});

describe("favicon.ico", () => {
  const ico = view("public/favicon.ico");

  it("is an icon file with three frames", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => ico.getUint8(i))).toEqual([0, 0, 1, 0, 3, 0]);
  });

  it("has a 16, a 32 and a 48 px PNG frame, each inside the file", () => {
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const at = 6 + i * 16;
      const width = ico.getUint8(at);
      expect(ico.getUint8(at + 1)).toBe(width);
      const size = ico.getUint32(at + 8, true);
      const offset = ico.getUint32(at + 12, true);
      expect(offset + size).toBeLessThanOrEqual(ico.byteLength);
      expect(signatureAt(ico, offset)).toEqual(PNG_SIGNATURE);
      expect(pngSize(ico, offset)).toEqual({ width, height: width });
      sizes.push(width);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });
});

describe("the PNG icons", () => {
  it.each([
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ])("%s is %d px square, small, with a colour type that takes pixels", (name, side) => {
    const png = view(`public/${name}`);
    expect(signatureAt(png, 0)).toEqual(PNG_SIGNATURE);
    expect(pngSize(png)).toEqual({ width: side, height: side });
    expect(png.byteLength).toBeLessThan(60 * 1024);
    expect([2, 6]).toContain(png.getUint8(25));
  });
});

describe("docs/brand/logo-original.svg", () => {
  it("is the owner's file: 13 paths, three of them the mark", () => {
    expect((original.match(/<path/g) ?? []).length).toBe(13);
    for (const line of pathLines(logoMark)) expect(original).toContain(line);
  });
});

describe("the head of index.html (N7)", () => {
  const html = readFileSync("index.html", "utf8");
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
  const links = head.match(/<link\b[^>]*>/g) ?? [];

  it("links the ICO, then the SVG with sizes=any, then the apple touch icon, in that order", () => {
    expect(links).toEqual([
      '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" sizes="any" />',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    ]);
  });

  it("preloads nothing", () => {
    expect(head).not.toMatch(/rel="preload"/);
  });
});

describe("pages-auth.css (the sign-in mark)", () => {
  const css = readFileSync("src/styles/pages-auth.css", "utf8");
  const rule = (selector: string) => new RegExp(`(?:^|\\n)\\s*${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("has no .auth-mark svg rule left", () => {
    expect(css).not.toMatch(/\.auth-mark\s+svg/);
  });

  it(".auth-mark is only a box: no background, border, radius or filter", () => {
    const body = rule(".auth-mark");
    expect(body).not.toBe("");
    for (const property of ["background", "border", "border-radius", "filter"]) expect(body).not.toContain(`${property}:`);
  });

  it("the brand name is 18px (--fs-lg), weight 600", () => {
    const body = rule(".auth-brand");
    expect(body).toContain("font-size: var(--fs-lg)");
    expect(body).toContain("font-weight: 600");
  });
});
