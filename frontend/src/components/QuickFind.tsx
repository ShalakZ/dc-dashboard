import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useAssets } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { findHits, type FindHit } from "../lib/quickFind";
import { Icon } from "./Icon";
import { GROUPS } from "./navItems";

const INPUT_ID = "quick-find";
const LIST_ID = "quick-find-list";
const optionId = (index: number) => `quick-find-opt-${index}`;

/**
 * The quick find in the top bar: assets and the pages the user may open, found by a few letters. An ARIA 1.2 combobox with a
 * listbox popup: the focus stays in the field, `aria-activedescendant` names the option the arrows are on, and the listbox is
 * in the DOM only while it has something to show. The popup is open while the field has the focus and has not been dismissed.
 */
export function QuickFind() {
  const { hasRole } = useAuth();
  const { data: assets } = useAssets(); // a failed request just means no asset hits; the pages still work
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1); // index into `hits`, -1 until an arrow is pressed
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // A viewer never sees Users, Sources, ...: the pages are the sidebar's, gated the same way.
  const pages = useMemo(() => GROUPS.filter((group) => !group.min || hasRole(group.min)).flatMap((group) => group.items), [hasRole]);
  const hits = useMemo(() => findHits(query, assets ?? [], pages), [query, assets, pages]);
  const popup = open && query.trim() !== "";
  const listed = popup && hits.length > 0; // the listbox exists only now, and so do aria-controls and aria-expanded

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Ctrl+K / Cmd+K from anywhere. Behind a modal dialog it would take the focus from the form being typed in, so it does nothing there.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return; // Ctrl+Shift+K opens the console in Firefox
      if ((event.key ?? "").toLowerCase() !== "k") return; // autofill sends keydown events without a key
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A press outside closes it. Blur does too, but a press on a page that does not take the focus has to be caught as well.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && root.current?.contains(event.target))) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const choose = (hit: FindHit) => {
    navigate(hit.to);
    setQuery("");
    close();
    document.getElementById("main")?.focus();
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setOpen(true);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setOpen(true); // after Escape an arrow brings the popup back, on the first (or last) option
      setActive((at) => (at < 0 ? (step > 0 ? 0 : hits.length - 1) : (at + step + hits.length) % hits.length));
    } else if (event.key === "Enter") {
      if (listed && hits[active]) {
        event.preventDefault();
        choose(hits[active]);
      }
    } else if (event.key === "Escape") {
      event.preventDefault(); // Chromium also clears a search field on Escape: the first press closes, the second clears
      if (popup) close();
      else setQuery("");
    }
  };

  const groups = [
    { name: "Tree matches", caption: "Assets", hits: hits.filter((hit) => hit.kind === "asset") },
    { name: "Page matches", caption: "Pages", hits: hits.filter((hit) => hit.kind === "page") },
  ].filter((group) => group.hits.length > 0);
  const pageIcon = (to: string) => pages.find((page) => page.to === to)?.icon ?? "assets";

  return (
    <div className="qf" role="search" ref={root}>
      <label className="sr-only" htmlFor={INPUT_ID}>Quick find</label>
      <div className="qf-field">
        <Icon name="search" />
        <input
          id={INPUT_ID}
          ref={input}
          type="search"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          placeholder="Find an asset or page"
          value={query}
          aria-expanded={listed}
          aria-controls={listed ? LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={listed && active >= 0 ? optionId(active) : undefined}
          onChange={onChange}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        <kbd aria-hidden="true">Ctrl K</kbd>
      </div>
      {popup && (
        // A press in the popup must not take the focus from the field (it would close the popup before the click lands); this also holds for its scrollbar.
        <div className="qf-pop" onMouseDown={(event) => event.preventDefault()}>
          {hits.length === 0 ? (
            <p className="qf-empty" role="status">No match</p>
          ) : (
            <ul className="qf-list" id={LIST_ID} role="listbox" aria-label="Suggestions">
              {groups.map((group) => (
                <li role="group" aria-label={group.name} key={group.name}>
                  <span className="qf-cap" aria-hidden="true">{group.caption}</span>
                  <ul role="presentation">
                    {group.hits.map((hit) => {
                      const index = hits.indexOf(hit);
                      return (
                        <li
                          role="option"
                          id={optionId(index)}
                          aria-selected={index === active}
                          className="qf-opt"
                          key={hit.key}
                          onClick={() => choose(hit)}
                        >
                          <Icon name={hit.kind === "asset" ? "assets" : pageIcon(hit.to)} />
                          <span className="qf-label">{hit.label}</span>
                          {hit.detail && (
                            <>
                              {" "}
                              <small>{hit.detail}</small>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
