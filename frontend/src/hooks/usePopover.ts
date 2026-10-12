import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const DWELL_MS = 200; // a mouse has to rest (and have moved) over the trigger this long before hover opens it
const LEAVE_MS = 150; // grace to cross the gap between the trigger and its panel
const SETTLE_MS = 300; // a scroll that began before it opened (the row was scrolled into view, then clicked) must not close it: its event arrives late

/** The popover that is open now. Opening another one closes it: a row menu and a tip never stand open side by side. */
let current: { id: symbol; hide: () => void } | null = null;

export interface Popover {
  open: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  /** Opens it; `pinned` keeps it open when the pointer leaves. */
  show: (pinned: boolean) => void;
  /** Keeps an open popover open when the pointer leaves. */
  pin: () => void;
  /** Closes it because the user asked to (click, Escape, a chosen item, Tab): the pointer may still rest on the trigger, which then does not hover it open again. */
  dismiss: () => void;
  /** What a click on the trigger does: closed -> open and pinned, hover-open -> pinned, pinned -> closed. */
  toggle: () => "open" | "pinned" | "closed";
  triggerHover: {
    onPointerEnter: (event: ReactPointerEvent) => void;
    onPointerMove: (event: ReactPointerEvent) => void;
    onPointerLeave: (event: ReactPointerEvent) => void;
  };
  panelHover: { onPointerEnter: (event: ReactPointerEvent) => void; onPointerLeave: (event: ReactPointerEvent) => void };
}

/**
 * The open/close behaviour shared by the row menu and the info tip: a click opens it and pins it, a mouse resting on the trigger opens it
 * unpinned, leaving closes an unpinned one, Escape, a press outside and a focus that lands outside close it. The panel is NOT assumed to
 * be a DOM child of the trigger's parent (the row menu is a portal), so "inside" means the trigger or the panel.
 * `closeOnScroll`: also close on any scroll outside the panel and on resize (a fixed panel would be left behind).
 */
export function usePopover({ hover = true, closeOnScroll = false }: { hover?: boolean; closeOnScroll?: boolean } = {}): Popover {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const me = useRef<symbol>(Symbol("popover"));
  const now = useRef({ open: false, pinned: false, quiet: false }); // quiet: no hover-open until the pointer has left and come back
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openedAt = useRef(0);

  const clearTimers = useCallback(() => {
    clearTimeout(dwell.current);
    clearTimeout(leave.current);
    dwell.current = leave.current = undefined;
  }, []);
  const hide = useCallback(() => {
    clearTimers();
    now.current.open = now.current.pinned = false;
    setOpen(false);
    if (current?.id === me.current) current = null;
  }, [clearTimers]);
  const show = useCallback((pinned: boolean) => {
    clearTimers();
    if (current && current.id !== me.current) current.hide();
    current = { id: me.current, hide };
    now.current.open = true;
    now.current.pinned = pinned;
    openedAt.current = performance.now();
    setOpen(true);
  }, [clearTimers, hide]);
  const dismiss = useCallback(() => {
    now.current.quiet = true;
    hide();
  }, [hide]);
  const pin = useCallback(() => { now.current.pinned = true; }, []);
  const toggle = useCallback(() => {
    clearTimers();
    if (!now.current.open) {
      show(true);
      return "open" as const;
    }
    if (!now.current.pinned) {
      now.current.pinned = true;
      return "pinned" as const;
    }
    dismiss();
    return "closed" as const;
  }, [clearTimers, show, dismiss]);

  useEffect(() => () => {
    clearTimeout(dwell.current);
    clearTimeout(leave.current);
    if (current?.id === me.current) current = null;
  }, []);

  // While it is open. Listeners on the document so they hold wherever the focus is (a click on a button does not focus it in every browser).
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!(trigger.current?.contains(target) || panel.current?.contains(target));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const hadFocus = inside(document.activeElement); // a menu that only hover opened must not take the focus from a field being typed in
      dismiss();
      if (hadFocus) trigger.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) hide(); };
    const onFocusIn = (event: FocusEvent) => { if (!inside(event.target)) hide(); };
    // Scroll and resize also take the focus back to the trigger when it was inside the menu (PageDown on an item, a resize): a closed
    // menu would otherwise leave it on <body>. A focus that was elsewhere (a hover-opened menu) is not touched.
    const close = () => {
      const hadFocus = inside(document.activeElement);
      hide();
      if (hadFocus) trigger.current?.focus({ preventScroll: true });
    };
    const onScroll = (event: Event) => {
      if (performance.now() - openedAt.current < SETTLE_MS) return;
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    if (closeOnScroll) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    }
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, closeOnScroll, hide, dismiss]);

  const mouse = (event: ReactPointerEvent) => event.pointerType === "mouse";
  const cancelLeave = () => { clearTimeout(leave.current); leave.current = undefined; };
  const onLeave = (event: ReactPointerEvent) => {
    if (!hover || !mouse(event)) return;
    clearTimeout(dwell.current);
    dwell.current = undefined;
    if (now.current.open && !now.current.pinned) {
      clearTimeout(leave.current);
      leave.current = setTimeout(hide, LEAVE_MS);
    }
  };
  const triggerHover = {
    onPointerEnter: (event: ReactPointerEvent) => {
      if (!mouse(event)) return;
      now.current.quiet = false;
      cancelLeave();
    },
    // Hover opens only after the pointer MOVED over the trigger and rested: a pointer sitting under a dialog that has just closed
    // produces an enter but no move, and must not open a menu.
    onPointerMove: (event: ReactPointerEvent) => {
      if (!hover || !mouse(event) || now.current.quiet) return;
      if (now.current.open) return cancelLeave();
      dwell.current ??= setTimeout(() => {
        dwell.current = undefined;
        show(false);
      }, DWELL_MS);
    },
    onPointerLeave: onLeave,
  };
  const panelHover = {
    onPointerEnter: (event: ReactPointerEvent) => { if (mouse(event)) cancelLeave(); },
    onPointerLeave: onLeave,
  };

  return { open, trigger, panel, show, pin, dismiss, toggle, triggerHover, panelHover };
}
