import type { ReactNode } from "react";

// Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; always decorative (the label next to it is the name).
export const ICONS = {
  brand: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  assets: <><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></>,
  dashboards: <><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></>,
  billing: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  sources: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v4" /></>,
  scans: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 7v4l2.5 2" /></>,
  discovery: <><circle cx="5" cy="12" r="2.2" /><circle cx="19" cy="5" r="2.2" /><circle cx="19" cy="19" r="2.2" /><path d="M7 11 17 6M7 13l10 5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  settings: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  tariffs: <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.5" /></>,
  storage: <><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" /><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></>,
  audit: <><path d="M9 4h10v16H5V8" /><path d="M9 4 5 8h4V4Z" /><path d="M9 13l2 2 4-4" /></>,
  diagnostics: <><path d="M3 12h4l2-6 4 12 2-6h6" /></>,
  password: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></>,
  signOut: <><path d="M14 4h5v16h-5" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  collapse: <><path d="M4 4v16" /><path d="m15 7-5 5 5 5" /><path d="M10 12h10" /></>,
  caret: <path d="m7 9 5 5 5-5" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></>,
  more: <><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>,
  // The lid is its own group so the trash button can lift and tilt it about its left end (app.css, `.trash-btn .lid`).
  trash: <><path d="M6.5 9.5 7.4 20h9.2l.9-10.5" /><path d="M10 12.5v5M14 12.5v5" /><g className="lid"><path d="M4 6.5h16" /><path d="M9 6.5V4h6v2.5" /></g></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7" /><path d="M12 17h.01" /></>,
  // Tariffs section heads: a coin, a bolt (the price of energy) and a building (one asset's own rate).
  currency: <><circle cx="12" cy="12" r="9" /><path d="M14.8 9.4c-.4-.9-1.4-1.4-2.8-1.4-1.6 0-2.7.8-2.7 2 0 2.8 5.5 1.4 5.5 4.1 0 1.2-1.2 2-2.8 2-1.4 0-2.5-.6-2.9-1.5" /><path d="M12 6v2M12 16v2" /></>,
  rate: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  override: <><path d="M5 21V4h9v17" /><path d="M14 9h5v12" /><path d="M3 21h18" /><path d="M8.5 8h2M8.5 12h2M8.5 16h2" /></>,
  // The Energy tile's own icon: a bolt in a circle (the Live power tile reuses `rate`, the Cost tile `currency`).
  energy: <><circle cx="12" cy="12" r="9" /><path d="M13 6 8.5 13H12l-1 5 4.5-7H12l1-5Z" /></>,
  // One per kind of asset (`lib/kindIcon.ts` picks): a pin, a tower, a floor plan, a line of racks, one rack, a two-door switch cabinet,
  // a gauge, a switch, a battery, a socket strip, a motor, two coils, a snowflake and a cube for "anything else".
  kindSite: <><path d="M12 21s-6.5-5.4-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.6 12 21 12 21Z" /><circle cx="12" cy="10.5" r="2.3" /></>,
  kindBuilding: <><path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21" /><path d="M3 21h18" /><path d="M9.5 7.5h1M13.5 7.5h1M9.5 11.5h1M13.5 11.5h1" /><path d="M10.5 21v-4h3v4" /></>,
  kindRoom: <><path d="M4 3.5h16v17H4Z" /><path d="M4 13h7v7.5" /><path d="M11 13a4 4 0 0 1 4-4" /></>,
  kindRow: <><rect x="2.5" y="5" width="5" height="14" rx="1" /><rect x="9.5" y="5" width="5" height="14" rx="1" /><rect x="16.5" y="5" width="5" height="14" rx="1" /><path d="M4 9h2M11 9h2M18 9h2" /></>,
  kindRack: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M5 9h14M5 15h14" /><path d="M8.5 6h.01M8.5 12h.01M8.5 18h.01" /></>,
  kindPanel: <><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M12 3v18" /><path d="M9.5 10.5v3M14.5 10.5v3" /></>,
  kindMeter: <><path d="M3.5 17a8.5 8.5 0 0 1 17 0" /><path d="M12 17l3.8-5" /><circle cx="12" cy="17" r="1.4" /><path d="M12 8.2v1.4M6.2 11.2l1 1M17.8 11.2l-1 1" /><path d="M3.5 21h17" /></>,
  kindCircuit: <><path d="M2 16h5.5M16.5 16H22" /><circle cx="9" cy="16" r="1.5" /><circle cx="15" cy="16" r="1.5" /><path d="M9.6 14.6 15.5 6.5" /></>,
  kindUps: <><rect x="2.5" y="7" width="16" height="10" rx="1.5" /><path d="M21.5 10.5v3" /><path d="M11.5 9.5 8.5 12.5h4l-2.5 3" /></>,
  kindPdu: <><rect x="6" y="7" width="16" height="10" rx="1.5" /><path d="M2 12h4" /><path d="M10.5 12h.01M14 12h.01M17.5 12h.01" /></>,
  kindGenerator: <><rect x="2.5" y="5.5" width="15" height="12.5" rx="2" /><path d="M17.5 11.75h4" /><path d="M6 11.75c1.3-3.2 2.7-3.2 4 0s2.7 3.2 4 0" /><path d="M5 18v2.5M15 18v2.5" /></>,
  kindTransformer: <><circle cx="9.5" cy="12" r="5" /><circle cx="14.5" cy="12" r="5" /><path d="M2 12h2.5M19.5 12H22" /></>,
  kindChiller: <><g><path d="M12 3v18M9.5 5.3 12 7.8l2.5-2.5M9.5 18.7 12 16.2l2.5 2.5" /></g><g transform="rotate(60 12 12)"><path d="M12 3v18M9.5 5.3 12 7.8l2.5-2.5M9.5 18.7 12 16.2l2.5 2.5" /></g><g transform="rotate(120 12 12)"><path d="M12 3v18M9.5 5.3 12 7.8l2.5-2.5M9.5 18.7 12 16.2l2.5 2.5" /></g></>,
  kindGeneric: <><path d="M12 3 4 7.5v9l8 4.5 8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;
}
