// What the cascade gives an element under <html data-mode data-theme>, for the tests that check the stylesheets as text (themes.css.test.ts,
// styles/widgets.css.test.ts). vitest runs from the frontend directory with `css: false`, so app.css and themes.css are read as text.
import { readFileSync } from "node:fs";
import type { ThemeId } from "../lib/appearance";
import { customProperties, parseRules, stripComments } from "./cssTools";

const appRules = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themeRules = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));

/** The tokens of app.css's one `:root` block (the light values; the look blocks of themes.css override them). */
export const baseTokens: ReadonlyMap<string, string> = customProperties(appRules.filter((r) => r.selector === ":root")[0].body);

function only(selector: string) {
  const found = themeRules.filter((r) => r.selector === selector);
  if (found.length !== 1) throw new Error(`themes.css: expected exactly one rule for "${selector}", found ${found.length}`);
  return found[0];
}

/** The tokens the cascade gives <html>: the base, the preset, the dark block (dark only), then the look's accent block. Values are as written (`var(--x)` stays). */
export function cascade(themeId: ThemeId | string, mode: "light" | "dark"): Map<string, string> {
  const map = new Map(baseTokens);
  for (const [name, value] of customProperties(only(`:root[data-theme="${themeId}"]`).body)) map.set(name, value);
  if (mode === "dark") for (const [name, value] of customProperties(only(':root[data-mode="dark"]').body)) map.set(name, value);
  for (const [name, value] of customProperties(only(`:root[data-theme="${themeId}"][data-mode="${mode}"]`).body)) map.set(name, value);
  return map;
}

/**
 * A token's final value with every `var(--x)` followed through `map`. All tokens sit on <html>, so a reference resolves against the
 * look's own values (`--widget-bg: var(--bg)` is the dark page in a dark look). A missing name or a loop is an error, never a guess.
 */
export function resolveVar(map: ReadonlyMap<string, string>, name: string, trail: readonly string[] = []): string {
  if (trail.includes(name)) throw new Error(`--${name} refers to itself: ${[...trail, name].join(" -> ")}`);
  const raw = map.get(name);
  if (raw === undefined) throw new Error(`--${name} is not defined${trail.length ? ` (used by --${trail[trail.length - 1]})` : ""}`);
  return raw.replace(/var\(--([\w-]+)\)/g, (_, inner: string) => resolveVar(map, inner, [...trail, name]));
}
