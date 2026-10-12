import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useAppearance } from "../auth/AppearanceProvider";
import { useAuth } from "../auth/AuthProvider";
import { THEMES, type Mode, type ThemeId } from "../lib/appearance";
import { Icon } from "./Icon";
import { ROLE_LABEL } from "./navItems";
import { SignOutDialog } from "./SignOutDialog";

const MODE_OPTIONS: { id: Mode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match my device" },
];

/**
 * The signed-in user in the top bar: a button that opens a small panel with the appearance choice, the way to the password page and
 * Sign out. A disclosure, not an ARIA menu (the panel holds two selects, a link and a button, plus a heading line), so the keys are the
 * plain ones plus the arrows; Tab walks through it and out of it, which closes it. The arrows on a select belong to the select.
 */
export function ProfileMenu() {
  const { user } = useAuth();
  const { mode, theme, setMode, setTheme, error } = useAppearance();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const modeId = useId();
  const themeId = useId();
  const focusFirst = useRef(false); // set by ArrowDown; the panel is still hidden, so the focus moves once it has been shown

  const name = user?.username ?? "";
  const role = user ? ROLE_LABEL[user.role] ?? user.role : "";
  const current = THEMES.find((option) => option.id === theme) ?? THEMES[0];
  const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>("a[href], button") ?? []);

  useEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    items()[0]?.focus();
  }, [open]);

  // While it is open: Escape, a press outside and a focus that lands outside close it. Listeners on the document, so they
  // hold wherever the focus is (a click on a button does not focus it in every browser).
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && !!root.current?.contains(target);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) setOpen(false); };
    const onFocusIn = (event: FocusEvent) => { if (!inside(event.target)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (open) items()[0]?.focus();
    else {
      focusFirst.current = true;
      setOpen(true);
    }
  };
  const onPanelKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.target instanceof HTMLSelectElement) return; // the select's own arrows change its value; cancelling them would block that
    event.preventDefault();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    all[(at + step + all.length) % all.length]?.focus();
  };
  const closeToTrigger = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  // The focus is on the trigger before the dialog mounts, so Cancel and Escape give it back there.
  const askSignOut = () => {
    closeToTrigger();
    setSigningOut(true);
  };

  return (
    <>
      <div className="profile" ref={root}>
        <button
          type="button"
          className="who"
          ref={trigger}
          aria-expanded={open}
          aria-controls="profile-panel"
          onClick={() => setOpen((was) => !was)}
          onKeyDown={onTriggerKey}
        >
          <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
          <span className="lbl">
            <span className="who-name">{name}</span>{" "}
            <span className="who-role">{role}</span>
          </span>
          <Icon name="caret" />
        </button>
        <div className="prof-menu" id="profile-panel" ref={panel} hidden={!open} onKeyDown={onPanelKey}>
          <div className="prof-head">
            <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
            <div>
              <strong>{name}</strong>
              <span className="r">{role}</span>
            </div>
          </div>
          <div className="prof-field">
            <label htmlFor={modeId}>Mode</label>
            <select id={modeId} value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
              {MODE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
          <div className="prof-field">
            <label htmlFor={themeId}>Theme colour</label>
            <div className="prof-pick">
              <span className="swatch" aria-hidden="true" style={{ "--sw-bg": current.swatch.bg, "--sw-dot": current.swatch.dot } as CSSProperties} />
              <select id={themeId} value={theme} onChange={(event) => setTheme(event.target.value as ThemeId)}>
                {THEMES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
            {error && <p role="alert" className="error">{error}</p>}
          </div>
          <Link to="/password" className="prof-item" onClick={closeToTrigger}>
            <Icon name="password" />
            <span>Password</span>
          </Link>
          <button type="button" className="prof-item" onClick={askSignOut}>
            <Icon name="signOut" />
            <span>Sign out</span>
          </button>
        </div>
      </div>
      {signingOut && <SignOutDialog onCancel={() => setSigningOut(false)} />}
    </>
  );
}
