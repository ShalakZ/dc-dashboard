// The frontend has no @types/node; the one test that reads a source file as text (app.css.test.ts) needs only this.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
