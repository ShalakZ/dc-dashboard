import { RANGES, type Range } from "../lib/timeRange";

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="row" role="group" aria-label="Time range">
      {RANGES.map((r) => <button key={r} type="button" aria-pressed={r === value} onClick={() => onChange(r)}>{r}</button>)}
    </div>
  );
}
