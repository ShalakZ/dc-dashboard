import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useCreateDashboard, useDashboardTemplates } from "../../api/queries";
import type { RangePreset } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { useToast } from "../Toasts";
import { BLANK_TEMPLATE, TemplateGallery, type TemplateChoice } from "./TemplateGallery";
import { TemplatePreview } from "./TemplatePreview";

/**
 * New dashboard, in two steps (w27). Step 1 "Choose a template" is the gallery; step 2 asks for the Name and the Range and says what was chosen.
 * A template comes filled with its widgets (the server builds them from `recipe`) and opens in view mode, with its own range as the default (an empty
 * Name means the template's title); Blank sends no recipe, needs a name and opens in edit mode. `initialChoice` opens straight on step 2 (a card of the
 * empty Dashboards page was clicked). Focus: the first card on step 1, Name on step 2, and Back to templates returns to the card that was chosen.
 * Escape closes the dialog from either step. The buttons that can have the focus are never natively disabled, so the focus stays where it is.
 */
export function CreateDashboardDialog({ onClose, initialChoice = null }: { onClose: () => void; initialChoice?: TemplateChoice | null }) {
  const navigate = useNavigate();
  const create = useCreateDashboard();
  const templates = useDashboardTemplates();
  const toast = useToast();
  const { run, busy, error, clear } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const rangeId = useId();
  const hintId = useId();
  const [choice, setChoice] = useState<TemplateChoice | null>(initialChoice);
  const [name, setName] = useState("");
  const [range, setRange] = useState<RangePreset>(() => (initialChoice === null || initialChoice === "blank" ? BLANK_TEMPLATE.range : templates.data?.templates.find((t) => t.id === initialChoice)?.range ?? BLANK_TEMPLATE.range));
  // Step 2 needs the card itself (title, line, range): a choice the list no longer holds sends the person back to step 1.
  const picked = choice === "blank" ? BLANK_TEMPLATE : choice === null ? null : templates.data?.templates.find((t) => t.id === choice) ?? null;
  const [lastChoice, setLastChoice] = useState<TemplateChoice | null>(initialChoice); // the card Back to templates returns to
  useDialogFocus(root, onClose, { busy, initial: nameInput });

  // The card that was clicked is gone from the page, and the focus with it: Name takes it (the first time round the hook has already put it there).
  const step = picked ? 2 : 1;
  useEffect(() => {
    if (step === 2) nameInput.current?.focus();
  }, [step]);

  const finalName = name.trim() === "" ? (picked && picked.id !== "blank" ? picked.title : "") : name.trim();
  const blocked = busy || finalName === "";

  const pick = (next: TemplateChoice) => {
    const card = next === "blank" ? BLANK_TEMPLATE : templates.data?.templates.find((t) => t.id === next);
    if (!card) return;
    clear(); // an earlier "name already taken" is about another attempt
    setRange(card.range);
    setLastChoice(next);
    setChoice(next);
  };
  const back = () => {
    if (busy) return;
    clear();
    setChoice(null);
  };
  const cancel = () => {
    if (!busy) onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked || !picked) return;
    void run(async () => {
      const created = await create.mutateAsync(picked.id === "blank" ? { name: finalName, range } : { name: finalName, range, recipe: picked.id });
      toast.success("Dashboard created"); // the new page does not say it was just made
      navigate(`/dashboards/${created.id}`, picked.id === "blank" ? { state: { edit: true } } : undefined);
    });
  };

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label="New dashboard" className="dialog tpl-dialog">
        <h2>New dashboard</h2>
        {picked === null ? (
          <div className="tpl-pane">
            <div className="tpl-body">
              <h3 className="tpl-step">Choose a template</h3>
              <TemplateGallery data={templates.data} error={templates.error} onPick={pick} focusChoice={lastChoice} level={4} />
            </div>
            <div className="row tpl-foot">
              <button type="button" onClick={onClose}>Cancel</button>
            </div>
          </div>
        ) : (
          <form className="tpl-pane" onSubmit={submit}>
            <div className="tpl-body">
              <div className="tpl-chosen">
                <div className="tpl-chosen-preview"><TemplatePreview widgets={picked.widgets} /></div>
                <div className="tpl-chosen-text">
                  <span className="tpl-chosen-title">{picked.title}</span>
                  <span className="muted">{picked.description}</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor={nameId}>Name</label>
                <input id={nameId} ref={nameInput} value={name} maxLength={100} placeholder={picked.id === "blank" ? undefined : picked.title} aria-describedby={hintId} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={rangeId}>Range</label>
                <select id={rangeId} value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
                  {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
                </select>
              </div>
              {/* The line is always there (templates.css reserves its height), so the dialog does not change size when the typing starts; it describes Name, not Create. */}
              <p id={hintId} className="muted tpl-hint">{finalName === "" ? "Enter a name." : ""}</p>
              {error && <p className="error" role="alert">{error}</p>}
            </div>
            <div className="row tpl-foot">
              <button type="button" className="tpl-back" aria-disabled={busy ? true : undefined} onClick={back}>Back to templates</button>
              <button type="button" aria-disabled={busy ? true : undefined} onClick={cancel}>Cancel</button>
              <button type="submit" className="primary tpl-create" aria-disabled={blocked ? true : undefined}>Create</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
