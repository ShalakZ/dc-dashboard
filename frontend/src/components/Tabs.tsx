import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef { id: string; label: string }

/**
 * A strip of tabs over one panel (WAI-ARIA tabs with automatic activation): the arrow keys, Home and End move between the tabs and select the
 * one they land on, and only the selected tab is in the Tab order. The parent owns `active` (on the Users & Roles page it is the address), so the
 * strip is a controlled component and only the panel of the active tab is drawn. With ONE tab there is nothing to choose: no strip, just the children.
 */
export function Tabs({ label, tabs, active, onSelect, children }: { label: string; tabs: readonly TabDef[]; active: string; onSelect: (id: string) => void; children: ReactNode }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  if (tabs.length < 2) return <>{children}</>;

  const move = (event: KeyboardEvent, from: number) => {
    const last = tabs.length - 1;
    let to: number;
    switch (event.key) {
      case "ArrowRight": to = from === last ? 0 : from + 1; break;
      case "ArrowLeft": to = from === 0 ? last : from - 1; break;
      case "Home": to = 0; break;
      case "End": to = last; break;
      default: return;
    }
    event.preventDefault();
    if (tabs[to].id !== active) onSelect(tabs[to].id); // Home on the first tab, End on the last: nothing to select (and no second history entry)
    buttons.current.get(tabs[to].id)?.focus();
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => { if (el) buttons.current.set(tab.id, el); else buttons.current.delete(tab.id); }}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === active}
            aria-controls={tab.id === active ? `panel-${tab.id}` : undefined} // only the selected tab's panel is drawn; the others have no element to point at
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => { if (tab.id !== active) onSelect(tab.id); }}
            onKeyDown={(event) => move(event, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0}>
        {children}
      </div>
    </>
  );
}
