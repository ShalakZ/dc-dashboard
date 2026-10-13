import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/** A react-query mutation's `status` fits as it is. */
export type SaveState = "idle" | "pending" | "success" | "error";

type Phase = "idle" | "saved" | "fading";

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; } // a matchMedia that fails is like none: the fade is drawn
}

/**
 * The Save button of a form that stays on screen after saving. It is its own confirmation: while the request runs it reads "Saving…"
 * (disabled, which is also the double-click guard), and when the save worked it turns green and reads "Saved" for `holdMs`, then fades back
 * over `fadeMs`. The form needs no "saved" word of its own.
 *
 * The three labels are three stacked faces in one grid cell (app styles: feedback-save.css), so the button is as wide as the widest one in
 * every state and nothing around it moves. Only the current face is exposed; the other two are aria-hidden and visibility: hidden.
 * `ariaLabel`, when given, is the name in every phase (a page with two "Save" buttons tells them apart by it); the polite live line, a
 * sibling of the button so it does not become part of the name, announces "Saved" either way.
 */
export function SaveButton({
  state, label = "Save", ariaLabel, className, disabled, type = "submit", onClick, holdMs = 2500, fadeMs = 600,
}: {
  state: SaveState;
  label?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
  holdMs?: number; // tests only
  fadeMs?: number; // tests only
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  // The previous state, kept as state and compared while rendering (React's documented way to reset on a prop change): the render that
  // follows a change is already right, with no frame of the wrong face. It starts as the first state, so a success that was already
  // there when the button mounted (a form shown again after a save) flashes nothing.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    // Entering success starts the green; pending, error or idle (the form was edited, the mutation reset) drops it at once.
    setPhase(state === "success" ? "saved" : "idle");
  }

  // The timers are a function of the phase, so a new phase (or unmounting) clears the old one and no timer can outlive the button.
  useEffect(() => {
    if (phase === "saved") {
      const id = setTimeout(() => setPhase(fadeMs > 0 && !prefersReducedMotion() ? "fading" : "idle"), holdMs); // reduced motion: no fade to wait for
      return () => clearTimeout(id);
    }
    if (phase === "fading") {
      const id = setTimeout(() => setPhase("idle"), fadeMs);
      return () => clearTimeout(id);
    }
  }, [phase, holdMs, fadeMs]);

  const saving = state === "pending";
  const shown = saving ? "saving" : phase;
  const face = saving ? 1 : phase === "saved" ? 2 : 0; // fading shows the idle label while the colour fades back
  const faceProps = (index: number) => ({ className: "save-face", "aria-hidden": index === face ? undefined : (true as const) });
  return (
    <>
      <button
        type={type}
        className={["save-btn", className].filter(Boolean).join(" ")}
        data-phase={shown}
        aria-label={ariaLabel}
        disabled={saving || disabled}
        onClick={onClick}
      >
        <span {...faceProps(0)}>{label}</span>
        <span {...faceProps(1)}>Saving…</span>
        <span {...faceProps(2)}><Icon name="check" />Saved</span>
      </button>
      <span className="sr-only save-live" aria-live="polite">{shown === "saved" ? "Saved" : null}</span>
    </>
  );
}
