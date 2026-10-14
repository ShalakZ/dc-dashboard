// Makes the static brand files in public/ from the owner's docs/brand/logo-original.svg (W7n).
// Run from frontend/: node scripts/make-brand-assets.mjs   (CHROMIUM_PATH overrides the browser executable)
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const GOLD = "#D29E12";
const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);

const original = readFileSync(new URL("../../docs/brand/logo-original.svg", import.meta.url), "utf8");
const pathLines = original.split("\n").filter((line) => line.startsWith("<path "));
const pick = (fill, transform) => {
  const hits = pathLines.filter((l) => l.includes(`fill="${fill}"`) && (!transform || l.includes(`transform="${transform}"`)));
  if (hits.length !== 1) throw new Error(`expected one path for ${fill}, found ${hits.length}`);
  return hits[0];
};
// The square, the M and the wedge in document order; the white wordmark paths are never picked.
const mark = [pick(GOLD, "translate(33,32)"), pick("#FCFBF7"), pick("#161616")];
const svg = (viewBox) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n${mark.join("\n")}\n</svg>\n`;

const logoMark = svg("33 32 155 150");
const favicon = svg("33 29.5 155 155"); // square: 2.5 units above and below the mark
writeFileSync(publicFile("logo-mark.svg"), logoMark);
writeFileSync(publicFile("favicon.svg"), favicon);

function buildIco(frames) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size, at);
    dir.writeUInt8(size, at + 1); // 0 would mean 256; every frame here is smaller
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...frames.map((f) => f.png)]);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // Transparent frames for the ICO; an opaque gold ground for the touch icons (iOS paints transparency black).
  const render = async (size, opaque) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:${opaque ? GOLD : "transparent"}}svg{display:block;width:${size}px;height:${size}px}</style>${favicon}`,
    );
    return page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
  };

  const frames = [];
  for (const size of [16, 32, 48]) frames.push({ size, png: await render(size, false) });
  writeFileSync(publicFile("favicon.ico"), buildIco(frames));
  writeFileSync(publicFile("apple-touch-icon.png"), await render(180, true));
  writeFileSync(publicFile("icon-192.png"), await render(192, true));
  writeFileSync(publicFile("icon-512.png"), await render(512, true));
} finally {
  await browser.close();
}
console.log("wrote logo-mark.svg, favicon.svg, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png");
