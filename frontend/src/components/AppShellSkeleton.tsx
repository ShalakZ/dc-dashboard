import { initialSidebar, type SidebarState } from "../lib/sidebarState";
import { ICONS } from "./Icon";

// The shell before the user is known: the navy bar and the sidebar with grey placeholders, in the real shell's own classes so the bar
// height, the sidebar width and the origin of main come from the real CSS and cannot differ. index.html carries a static copy of this
// markup (it paints before any script runs), so it is classes only: no style attribute, no text of its own (the brand name is drawn by CSS,
// `.sk-shell .brand .lbl::before`), and AppShellSkeleton.test.tsx fails if the two drift apart. The page area holds the status line and
// nothing else: grey shapes there would be a second skeleton chain in front of the pages' own (W7f's fade-in rule).
// The roles are unknown while the sign-in check is out, so the sidebar shows three groups of three rows whatever the user's role. The bar's
// right side has the real bar's parts (chip, clock, user) with the real classes where there are some (`.vr`, `.site-time`, `.profile`, `.who`),
// so the user's avatar lands about where the real one will; the real narrow-window rules hide the clock's zone and the role there too.

/** A text placeholder: width `sk-w-<n>` (in ch), in a plain span of its own as `Skeleton` does. */
function Line({ w }: { w: number }) {
  return <span><span className={`sk sk-line sk-w-${w}`} /></span>;
}

function Row({ w }: { w: number }) {
  return (
    <div className="side-row">
      <span className="sk sk-circle" />
      <span className="lbl"><Line w={w} /></span>
    </div>
  );
}

const GROUPS: ReadonlyArray<{ heading: number; rows: readonly number[] }> = [
  { heading: 7, rows: [10, 12, 8] },
  { heading: 8, rows: [9, 11, 10] },
  { heading: 10, rows: [8, 12, 9] },
];

export function AppShellSkeleton({ sidebar = initialSidebar() }: { sidebar?: SidebarState }) {
  return (
    <div className="shell sk-shell" data-sidebar={sidebar}>
      <header className="navbar" aria-hidden="true">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24">{ICONS.brand}</svg></span>
          <span className="lbl" />
        </div>
        <div className="bar-in">
          <div className="qf"><span className="sk-find" /></div>
          <span className="grow" />
          <span className="sk sk-chip" />
          <span className="vr" aria-hidden="true" />
          <span className="site-time"><Line w={6} /><span className="zone"><Line w={3} /></span></span>
          <span className="vr" aria-hidden="true" />
          <div className="profile">
            <div className="who">
              <span className="avatar sk-avatar" />
              <span className="lbl">
                <span className="who-name"><Line w={5} /></span>
                <span className="who-role"><Line w={11} /></span>
              </span>
              <span className="sk sk-caret" />
            </div>
          </div>
        </div>
      </header>
      <div className="frame">
        <div className="side" aria-hidden="true">
          <nav>
            <div className="nav-groups">
              {GROUPS.map((group) => (
                <div className="nav-group" key={group.heading}>
                  <span className="nav-heading"><Line w={group.heading} /></span>
                  {group.rows.map((w, i) => <Row w={w} key={i} />)}
                </div>
              ))}
            </div>
            <div className="side-foot"><Row w={12} /></div>
          </nav>
        </div>
        <main>
          <div role="status" aria-busy="true"><span className="sr-only">Loading</span></div>
        </main>
      </div>
    </div>
  );
}
