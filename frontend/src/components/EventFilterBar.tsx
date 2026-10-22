import { useId } from "react";
import type { EventFilters, EventLevel, EventOptions } from "../api/types";
import { FIRST_DAY, isFiltered, LAST_DAY, LEVELS, NO_FILTERS } from "../lib/eventFilters";
import { kindName, LEVEL_WORDS } from "../lib/eventText";
import { Icon } from "./Icon";

// The value of the Kind select's disabled option, shown while the filter holds several kinds (a link can carry them); no real kind contains "*".
const GROUP = "*group";

interface Props {
  filters: EventFilters;
  onChange: (next: EventFilters) => void;
  /** The sources and kinds that occur in the journal; undefined while they load (the selects then hold only "All"). */
  options: EventOptions | undefined;
  onExport: () => void;
  exporting: boolean;
  /** One line about an export that failed (the server's sentence), or null. */
  error: string | null;
}

/** The filters of the System events page: Source, Kind, Level, From and To, Open only, and Export CSV. It holds no state of its own: the address does. */
export function EventFilterBar({ filters, onChange, options, onExport, exporting, error }: Props) {
  const ids = { source: useId(), kind: useId(), level: useId(), from: useId(), to: useId() };

  const sources = options?.sources ?? [];
  const sourceKnown = filters.source === "" || sources.some((source) => String(source.id) === filters.source);

  // The Kind select picks ONE kind. Several kinds (a link) get a disabled option that names them, so it never reads "All kinds" while a filter is on.
  const kinds = options?.kinds ?? [];
  const single = filters.kinds.length === 1 ? filters.kinds[0] : null;
  const group = filters.kinds.length > 1;
  const kindValue = group ? GROUP : (single ?? "");

  function toggleLevel(level: EventLevel) {
    const levels = filters.levels.includes(level) ? filters.levels.filter((each) => each !== level) : LEVELS.filter((each) => each === level || filters.levels.includes(each));
    onChange({ ...filters, levels });
  }

  return (
    <div role="search" aria-label="Filter the system events" className="filter-bar">
      <div className="row">
        <div className="field">
          <label htmlFor={ids.source}>Source</label>
          <select id={ids.source} value={filters.source} onChange={(e) => onChange({ ...filters, source: e.target.value })}>
            <option value="">All sources</option>
            {sources.map((source) => <option key={source.id} value={String(source.id)}>{source.name}</option>)}
            {!sourceKnown && <option value={filters.source}>{`Source #${filters.source}`}</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.kind}>Kind</label>
          <select id={ids.kind} value={kindValue} onChange={(e) => onChange({ ...filters, kinds: e.target.value ? [e.target.value] : [] })}>
            <option value="">All kinds</option>
            {group && <option value={GROUP} disabled>{`${filters.kinds.length} kinds (filter)`}</option>}
            {single !== null && !kinds.includes(single) && <option value={single}>{kindName(single)}</option>}
            {kinds.map((kind) => <option key={kind} value={kind}>{kindName(kind)}</option>)}
          </select>
        </div>
        <div className="field">
          <span id={ids.level} className="field-label">Level</span>
          <div className="seg-switch" role="group" aria-labelledby={ids.level}>
            {LEVELS.map((level) => (
              <button key={level} type="button" aria-pressed={filters.levels.includes(level)} onClick={() => toggleLevel(level)}>{LEVEL_WORDS[level]}</button>
            ))}
          </div>
        </div>
        <div className="range-group">
          <div className="field">
            <label htmlFor={ids.from}>From</label>
            <input id={ids.from} type="date" min={FIRST_DAY} max={filters.to || LAST_DAY} value={filters.from} onChange={(e) => onChange({ ...filters, from: e.target.value })} />
          </div>
          <span className="range-sep" aria-hidden="true">to</span>
          <div className="field">
            <label htmlFor={ids.to}>To</label>
            <input id={ids.to} type="date" min={filters.from || FIRST_DAY} max={LAST_DAY} value={filters.to} onChange={(e) => onChange({ ...filters, to: e.target.value })} />
          </div>
        </div>
      </div>
      <div className="row quick-row">
        <div className="row">
          <button type="button" className="filter-chip" aria-pressed={filters.open} onClick={() => onChange({ ...filters, open: !filters.open })}>
            <Icon name="evProblem" />
            Open only
          </button>
          {isFiltered(filters) && <button type="button" className="quiet" onClick={() => onChange(NO_FILTERS)}>Clear filters</button>}
        </div>
        <div className="row filter-tools">
          <button type="button" onClick={onExport} disabled={exporting}><Icon name="download" />Export CSV</button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
