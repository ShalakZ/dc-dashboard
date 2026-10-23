import type { Ref } from "react";
import type { Metric } from "../../api/types";
import type { NameFrom, Shape } from "../../api/shapes";
import {
  decisionOptions, derivedAsset, grouped, METRIC_WORDS, NAME_OPTIONS, plural, ruleSentence, rowWarnings, suggestionSentence, type Choice,
} from "../../lib/shapes";

interface Props {
  shape: Shape;
  choice: Choice;
  /** discovery.accept: without it the decision is text and nothing here can be changed. */
  canDecide: boolean;
  /** "Same decision for PDUB#_PM0_PENRG", or null when the page knows no similar shape. */
  similarText: string | null;
  ticked: boolean;
  /** The row a search hit or a deep link points at. */
  highlighted: boolean;
  onChoice: (patch: Partial<Choice>) => void;
  onTick: (on: boolean) => void;
  /** (T7b) Forget the row's saved rule. Given only when the person may decide (discovery.accept). */
  onForget?: () => void;
  /** (T7b) A forget is on its way: the button waits (aria-disabled, it keeps the focus). */
  forgetting?: boolean;
  rowRef?: Ref<HTMLDivElement>;
}

/**
 * One shape of a source: what it is (a label made from the tag text, how many tags, three of them, the unit, the suggestion), and the one decision about it.
 * Every row starts at Ignore, so nothing is mapped that the person did not choose. The label, the suggestion and the asset name are guesses and the row says so
 * where it matters. The slot under the row is always there (a fixed minimum height): a warning arriving moves nothing, and it also holds the row's saved rule (T7b, with Forget this rule).
 *
 * The row is found by its `data-shape` value (the key holds `#`: never an id built from it). It can take focus by script (tabIndex -1).
 */
export function ShapeRow({ shape, choice, canDecide, similarText, ticked, highlighted, onChoice, onTick, onForget, forgetting = false, rowRef }: Props) {
  const warnings = rowWarnings(shape, choice);
  const first = shape.examples[0];
  const asset = derivedAsset(first, choice.nameFrom);
  const counts = [plural(shape.count, "tag")];
  if (shape.mapped > 0) counts.push(`${grouped(shape.mapped)} already mapped`);
  const decision = choice.metric === null ? "Ignore" : `Map as ${METRIC_WORDS[choice.metric]}`;
  return (
    <div
      ref={rowRef} className="shape-row" role="group" aria-label={`Shape ${shape.label}`} tabIndex={-1}
      data-shape={shape.key} data-focus={highlighted ? "true" : undefined} data-chosen={choice.metric !== null ? "true" : undefined}
    >
      <div className="shape-info">
        <p className="shape-title"><span className="shape-label">{shape.label}</span><span className="muted">{counts.join(", ")}</span></p>
        <p className="muted shape-examples">
          {"For example "}
          {shape.examples.map((example, i) => (
            <span key={`${i}-${example.address}`}>{i > 0 ? ", " : ""}<span title={example.address}>{example.name}</span></span>
          ))}
        </p>
        <p className="muted shape-guess">{`${shape.unit_hints.length > 0 ? `Unit ${shape.unit_hints.join(", ")}. ` : ""}Suggested: ${suggestionSentence(shape)}.`}</p>
      </div>

      <div className="shape-decide">
        {canDecide ? (
          <>
            <select aria-label={`Decision for ${shape.label}`} value={choice.metric ?? ""} onChange={(event) => onChoice({ metric: event.target.value === "" ? null : (event.target.value as Metric) })}>
              {decisionOptions(shape).map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}
            </select>
            <div className="shape-name-pick">
              <span className="muted" aria-hidden="true">Asset name from</span>
              <select aria-label={`Asset name for ${shape.label}`} value={choice.nameFrom} onChange={(event) => onChoice({ nameFrom: event.target.value as NameFrom })}>
                {NAME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}
              </select>
            </div>
          </>
        ) : (
          <p className="shape-readonly">{`Decision: ${decision}`}</p>
        )}
        <p className="muted shape-asset">{asset === null ? "Asset: (no name from this example)" : `Asset: ${asset}`}</p>
        {canDecide && similarText !== null && (
          <label className="shape-tick">
            <input type="checkbox" checked={ticked} onChange={(event) => onTick(event.target.checked)} />
            {similarText}
          </label>
        )}
      </div>

      <div className="shape-warn">
        {shape.rule !== null && (
          <p className="muted shape-rule">
            {ruleSentence(shape.rule)}
            {canDecide && onForget !== undefined && (
              <button
                type="button" className="quiet" aria-label={`Forget this rule for ${shape.label}`} aria-disabled={forgetting ? true : undefined}
                onClick={() => { if (!forgetting) onForget(); }}
              >
                Forget this rule
              </button>
            )}
          </p>
        )}
        {warnings.map((text) => <p key={text} className="warning">{text}</p>)}
      </div>
    </div>
  );
}
