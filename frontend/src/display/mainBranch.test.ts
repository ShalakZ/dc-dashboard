import { readdirSync, readFileSync, statSync } from "node:fs";

// main.tsx runs when it is imported, so it is read as text (the same way the CSS tests read the stylesheets): the display branch must hold
// the screen and nothing of the app, and the app must hold everything the screen must not have.
const main = readFileSync("src/main.tsx", "utf8"); // vitest runs from the frontend directory
const branchStart = main.indexOf("if (isDisplayPath(");
const branch = main.slice(branchStart, main.indexOf("} else {", branchStart));
const mountApp = main.slice(main.indexOf("function mountApp()"), branchStart);

describe("main.tsx: the /display branch", () => {
  it("takes the secret out of the address first, before it renders anything", () => {
    expect(branchStart).toBeGreaterThan(-1);
    expect(branch).toMatch(/isDisplayPath\(window\.location\.pathname\)\) \{\s*const handle = holdSecret\(takeFragment\(\)\);/);
    expect(branch.indexOf("takeFragment()")).toBeLessThan(branch.indexOf("render("));
  });

  it("watches for a link opened in the open tab (a fragment-only change loads nothing), after the first take of the secret and before it renders", () => {
    expect(branch).toContain("reloadOnLink();");
    expect(branch.indexOf("takeFragment()")).toBeLessThan(branch.indexOf("reloadOnLink();"));
    expect(branch.indexOf("reloadOnLink();")).toBeLessThan(branch.indexOf("render("));
    expect(main).toMatch(/^import \{ reloadOnLink \} from "\.\/display\/reloadOnLink";$/m);
    expect(mountApp).not.toContain("reloadOnLink");
  });

  it("hands the screen a handle, never the secret: no variable of main.tsx holds the string (the claim releases it at the first definite answer)", () => {
    expect(branch).not.toMatch(/\b(?:const|let|var)\s+secret\b/);
    expect(branch).not.toMatch(/secret=\{/);
    expect(branch).toContain("<DisplayApp handle={handle} />");
    expect(main).toMatch(/^import \{ holdSecret \} from "\.\/display\/secretHandle";$/m);
  });

  it("renders only the DisplayApp: no query client, no sign-in, no appearance, no toasts, no router, no chunk reload", () => {
    expect(branch).toContain("<DisplayApp handle={handle} />");
    for (const name of ["QueryClient", "AuthProvider", "AppearanceProvider", "ToastProvider", "RouterProvider", "createBrowserRouter", "installChunkReload", "App />"]) {
      expect(branch, name).not.toContain(name);
    }
  });

  it("imports the DisplayApp statically (a lazy chunk could fail to load on a screen nobody is watching)", () => {
    expect(main).toMatch(/^import \{ DisplayApp \} from "\.\/display\/DisplayApp";$/m);
    expect(main).not.toMatch(/lazy\(|import\(\s*["']\.\/display/);
  });

  it("builds the app, the router and the chunk reload inside mountApp(), which runs in the else branch only", () => {
    expect(mountApp).toContain("const router = createBrowserRouter(");
    expect(mountApp).toContain("installChunkReload();");
    expect(mountApp).toContain("<QueryClientProvider client={queryClient}>");
    expect(main.slice(0, main.indexOf("function mountApp()"))).not.toMatch(/createBrowserRouter\(|installChunkReload\(\)|new QueryClient\(/);
    expect(main.slice(branchStart)).toMatch(/\} else \{\s*mountApp\(\);\s*\}\s*$/);
  });

  it("is tested in one place only", () => {
    expect(main.match(/isDisplayPath\(/g)).toHaveLength(1);
  });
});

// A router Link or navigate() to /display would change the address without a page load and skip the branch above (the admin Displays page at
// /displays is another path: the pattern ends at the closing quote).
const TO_DISPLAY = /\b(?:to\s*[:=]\s*\{?\s*|navigate\(\s*|redirect\(\s*)["'`]\/display\/?["'`]/;

/** Every non-test .tsx or .ts file under `dir`, as [path, text] (the frontend has no @types/node: see src/test/nodeFs.d.ts). */
function sources(dir: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.startsWith("src/test/")) found.push([path, readFileSync(path, "utf8")]);
  }
  return found;
}

describe("nothing in the app links to the display screen with the router", () => {
  it("no Link, NavLink, Navigate, navigate() or nav item names /display (a full page load only)", () => {
    const all = sources("src");
    expect(all.length, "the walk finds the sources").toBeGreaterThan(50);
    expect(all.filter(([, text]) => TO_DISPLAY.test(text)).map(([path]) => path)).toEqual([]);
  });

  it("the guard can see one, and spares /displays", () => {
    for (const sample of ['<Link to="/display">', "<NavLink to={'/display/'}>", 'navigate("/display")', 'redirect(`/display`)', '{ to: "/display", label: "x" }']) {
      expect(TO_DISPLAY.test(sample), sample).toBe(true);
    }
    for (const sample of ['<Link to="/displays">', 'navigate("/displays")', '{ to: "/displays" }', '<Link to="/display/x">', 'const link = "/display#"']) {
      expect(TO_DISPLAY.test(sample), sample).toBe(false);
    }
  });
});
