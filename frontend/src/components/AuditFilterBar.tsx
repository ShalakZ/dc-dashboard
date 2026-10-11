import { useEffect, useId, useRef, useState } from "react";
import type { AuditOptions } from "../api/types";
import { FIRST_DAY, isFiltered, LAST_DAY, NO_FILTERS, QUICK_FILTERS, quickActive, type AuditFilters } from "../lib/auditFilters";

const SEARCH_PAUSE_MS = 400;
// The value of the Action select's disabled option, shown while the filter is a pattern or several actions.
const GROUP = "*group"; // no real action contains "*"

/** Whitespace alone is no search (the address drops it too). */
const searchValue = (text: string) => (text.trim() === "" ? "" : text);

interface Props {
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  /** Today on the site's calendar, for the Today and Last 7 days buttons. */
  today: string;
  options: AuditOptions | undefined;
  onJump: (date: string) => void;
  jumping: boolean;
  onExport: () => void;
  exporting: boolean;
  error: string | null;
  notice: string | null;
}

/** The audit log's filters, quick filters, "Go to date" and Export CSV. It holds no filter state of its own except the unsent search text. */
export function AuditFilterBar({ filters, onChange, today, options, onJump, jumping, onExport, exporting, error, notice }: Props) {
  const ids = { user: useId(), action: useId(), from: useId(), to: useId(), search: useId(), jump: useId() };
  const [jumpDate, setJumpDate] = useState("");

  // The search box keeps what is typed; it applies after a pause or on Enter. `latest` lets that late call build on the
  // filters as they are then, and `written` is the value the box itself last sent, so only a different value in the
  // filters (Back, a link, Clear) replaces the text and a value the box wrote does not eat keystrokes typed since.
  const [text, setText] = useState(filters.q);
  const latest = useRef({ filters, onChange });
  useEffect(() => { latest.current = { filters, onChange }; });
  const written = useRef(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (filters.q !== written.current) {
      clearTimeout(timer.current); // a different value arrived: what was typed before it no longer applies
      written.current = filters.q;
      setText(filters.q);
    }
  }, [filters.q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function applySearch(value: string) {
    clearTimeout(timer.current);
    const q = searchValue(value);
    if (q === latest.current.filters.q) return;
    written.current = q;
    latest.current.onChange({ ...latest.current.filters, q });
  }

  function typeSearch(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => applySearch(value), SEARCH_PAUSE_MS);
  }

  function clearAll() {
    clearTimeout(timer.current);
    written.current = "";
    setText("");
    onChange(NO_FILTERS);
  }

  function toggleQuick(id: string) {
    const quick = QUICK_FILTERS.find((candidate) => candidate.id === id)!;
    if (quickActive(quick, filters, today)) {
      const keys = Object.keys(quick.patch(today)) as (keyof AuditFilters)[];
      onChange({ ...filters, ...Object.fromEntries(keys.map((key) => [key, NO_FILTERS[key]])) });
    } else {
      onChange({ ...filters, ...quick.patch(today) });
    }
  }

  // The Action select picks ONE exact action. A pattern or several actions (a quick filter, or a link) get a disabled
  // option that names them, so the select never shows "All actions" while a filter is on.
  const single = filters.actions.length === 1 && !filters.actions[0].includes("*") ? filters.actions[0] : null;
  const group = filters.actions.length > 0 && single === null;
  const groupQuick = group ? QUICK_FILTERS.find((quick) => "actions" in quick.patch(today) && quickActive(quick, filters, today)) : undefined;
  const groupName = groupQuick ? `${groupQuick.label} (quick filter)` : `${filters.actions.join(", ")} (filter)`;
  const actions = options?.actions ?? [];
  const actionValue = group ? GROUP : (single ?? "");

  const users = options?.users ?? [];
  const userKnown = filters.user === "" || filters.user === "none" || users.some((u) => String(u.id) === filters.user);
  const showNoUser = Boolean(options?.unattributed) || filters.user === "none";

  return (
    <div role="search" aria-label="Filter the audit log" className="filter-bar">
      <div className="row">
        <div className="field">
          <label htmlFor={ids.user}>User</label>
          <select id={ids.user} value={filters.user} onChange={(e) => onChange({ ...filters, user: e.target.value })}>
            <option value="">All users</option>
            {showNoUser && <option value="none">(no user)</option>}
            {users.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
            {!userKnown && <option value={filters.user}>{`User #${filters.user}`}</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.action}>Action</label>
          <select
            id={ids.action}
            value={actionValue}
            onChange={(e) => onChange({ ...filters, actions: e.target.value ? [e.target.value] : [] })}
          >
            <option value="">All actions</option>
            {group && <option value={GROUP} disabled>{groupName}</option>}
            {single !== null && !actions.includes(single) && <option value={single}>{single}</option>}
            {actions.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.from}>From</label>
          <input
            id={ids.from}
            type="date"
            min={FIRST_DAY}
            max={filters.to || LAST_DAY}
            value={filters.from}
            onChange={(e) => onChange({ ...filters, from: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.to}>To</label>
          <input
            id={ids.to}
            type="date"
            min={filters.from || FIRST_DAY}
            max={LAST_DAY}
            value={filters.to}
            onChange={(e) => onChange({ ...filters, to: e.target.value })}
          />
        </div>
        <div className="field grow">
          <label htmlFor={ids.search}>Search</label>
          <input
            id={ids.search}
            type="text"
            value={text}
            placeholder="Search action, user and details"
            onChange={(e) => typeSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applySearch(text); }}
          />
        </div>
      </div>
      <div className="row" role="group" aria-label="Quick filters">
        {QUICK_FILTERS.map((quick) => (
          <button key={quick.id} type="button" aria-pressed={quickActive(quick, filters, today)} onClick={() => toggleQuick(quick.id)}>
            {quick.label}
          </button>
        ))}
        {isFiltered(filters) && <button type="button" onClick={clearAll}>Clear filters</button>}
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={ids.jump}>Go to date</label>
          <input id={ids.jump} type="date" min={FIRST_DAY} max={LAST_DAY} value={jumpDate} onChange={(e) => setJumpDate(e.target.value)} />
        </div>
        <button type="button" onClick={() => onJump(jumpDate)} disabled={jumpDate === "" || jumping}>Go</button>
        <button type="button" onClick={onExport} disabled={exporting}>Export CSV</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
    </div>
  );
}
