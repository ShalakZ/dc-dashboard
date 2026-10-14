import type { ReactNode } from "react";

// Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; always decorative (the label next to it is the name).
export const ICONS = {
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
  // Interface icons of the Audit and Storage pages (W7j): a tray arrow, a calendar, a clock face, a funnel, two stacked layers, a rising line, an hourglass,
  // rows with bullets, a tall can with two bands and a right-pointing chevron (CSS turns it when a row opens). None starts with "kind": the asset catalogue owns that prefix.
  download: <><path d="M12 4v11" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  filter: <path d="M4 5h16l-6.2 7.6V19l-3.6-2v-4.4L4 5Z" />,
  layers: <><path d="M12 4 21 9l-9 5-9-5 9-5Z" /><path d="m3 14 9 5 9-5" /></>,
  trend: <><path d="m3 17 6-6 4 4 8-9" /><path d="M15 6h6v6" /></>,
  hourglass: <><path d="M6.5 3h11M6.5 21h11" /><path d="M7.5 3c0 4.5 2.2 6 4.5 9-2.3 3-4.5 4.5-4.5 9" /><path d="M16.5 3c0 4.5-2.2 6-4.5 9 2.3 3 4.5 4.5 4.5 9" /></>,
  readings: <><path d="M9 6h12M9 12h12M9 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="2.5" /><path d="M4 5v14c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5" /><path d="M4 9.7c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5M4 14.4c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  // One per kind of audit event (`lib/auditKind.ts`): a door with an arrow in, a warning triangle, a plus, a pencil, a bin, upright sliders and an "i" in a circle.
  evSignIn: <><path d="M15 4h5v16h-5" /><path d="m10 8 4 4-4 4M14 12H4" /></>,
  evProblem: <><path d="M12 3.5 21.5 20h-19L12 3.5Z" /><path d="M12 10v4.5M12 17.5h.01" /></>,
  evCreate: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  evChange: <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  evDelete: <><path d="M6.5 9.5 7.4 20h9.2l.9-10.5" /><path d="M10 12.5v5M14 12.5v5" /><path d="M4 6.5h16" /><path d="M9 6.5V4h6v2.5" /></>,
  evSettings: <><path d="M6 4v5M6 13v7M12 4v9M12 17v3M18 4v3M18 11v9" /><circle cx="6" cy="11" r="2" /><circle cx="12" cy="15" r="2" /><circle cx="18" cy="9" r="2" /></>,
  evOther: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5h.01" /></>,
  // One per kind of asset (`lib/kindIcon.ts` picks from the kind text; `lib/assetIcons.ts` lists all 28 for the picker in the asset dialog):
  // a pin, a tower, a floor plan, a line of racks, one rack, a two-door switch cabinet,
  // a gauge, a switch, a battery, a socket strip, a motor, two coils, a snowflake and a cube for "anything else". The 14 after the cube are picker-only:
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
  // an upright cell (the UPS is the flat one with a bolt), a capsule tank on legs, a louvred cabinet blowing down, a bladed ring, a casing with two pipes,
  kindBattery: <><path d="M10 5V3h4v2" /><rect x="6.5" y="5" width="11" height="16.5" rx="1.5" /><path d="M12 9.5v4M10 11.5h4M10 17.5h4" /></>,
  kindFuelTank: <><rect x="2.5" y="7.5" width="19" height="9" rx="4.5" /><path d="M10.5 7.5V5h3v2.5" /><path d="M7 16.5V20M17 16.5V20M5 20.5h4M15 20.5h4" /></>,
  kindCrac: <><rect x="4" y="2.5" width="16" height="12.5" rx="1.5" /><path d="M7.5 6.5h9M7.5 10.5h9" /><path d="M7 17.5v3.5M5.9 19.9 7 21l1.1-1.1M12 17.5v3.5M10.9 19.9 12 21l1.1-1.1M17 17.5v3.5M15.9 19.9 17 21l1.1-1.1" /></>,
  kindFan: <><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="1.5" /><g><path d="M12 10.5C10.2 8.6 10.4 5.8 12 4c1.6 1.8 1.8 4.6 0 6.5Z" /></g><g transform="rotate(120 12 12)"><path d="M12 10.5C10.2 8.6 10.4 5.8 12 4c1.6 1.8 1.8 4.6 0 6.5Z" /></g><g transform="rotate(240 12 12)"><path d="M12 10.5C10.2 8.6 10.4 5.8 12 4c1.6 1.8 1.8 4.6 0 6.5Z" /></g></>,
  kindPump: <><circle cx="10" cy="14" r="6" /><path d="M10 8V4M7.5 4h5" /><path d="M16 14h5.5M21.5 11.5v5" /><circle cx="10" cy="14" r="1.5" /><path d="M6 21.5h8" /></>,
  // two stacked rack units, a long unit with a row of ports under a two-way arrow, a box with a screen and buttons, a thermometer,
  kindServer: <><rect x="3" y="3.5" width="18" height="7" rx="1.5" /><rect x="3" y="13.5" width="18" height="7" rx="1.5" /><path d="M6.5 7h.01M6.5 17h.01" /><path d="M11 7h7M11 17h7" /></>,
  kindSwitch: <><path d="M7 6.5h10M9.5 4 7 6.5 9.5 9M14.5 4 17 6.5 14.5 9" /><rect x="2.5" y="12" width="19" height="8" rx="1.5" /><path d="M6 15v2.5M10 15v2.5M14 15v2.5M18 15v2.5" /></>,
  kindController: <><rect x="4" y="2.5" width="16" height="19" rx="1.5" /><rect x="7" y="5.5" width="10" height="6" rx="1" /><path d="M8 16.5h.01M12 16.5h.01M16 16.5h.01" /></>,
  kindSensor: <><path d="M9 14.5V5a2.5 2.5 0 0 1 5 0v9.5a4.5 4.5 0 1 1-5 0Z" /><path d="M11.5 9.5v7" /><circle cx="11.5" cy="18" r="1.2" /><path d="M17.5 6h2.5M17.5 10h2.5" /></>,
  // a bulb with rays, a wall camera, a door in its frame, a flame and a drop over water.
  kindLighting: <><path d="M9.5 17v-1.3c0-1.3-3-2.6-3-6.2a5.5 5.5 0 0 1 11 0c0 3.6-3 4.9-3 6.2V17Z" /><path d="M9.5 20h5M10.5 22.5h3" /><path d="M12 1v1.5M4 4.5l1 1M20 4.5l-1 1" /></>,
  kindCamera: <><path d="M3 4v16" /><path d="M3 10h2.5" /><rect x="5.5" y="6.5" width="15" height="8" rx="1.5" /><circle cx="15.5" cy="10.5" r="2.3" /><path d="M8.5 9h.01" /></>,
  kindDoor: <><path d="M4.5 21V3.5h15V21" /><path d="M2.5 21h19" /><path d="M8.5 21V8h7v13" /><path d="M12.5 15h.01" /></>,
  kindFire: <><path d="M12 2.5c.5 3.5 5.5 6 5.5 11.2a5.5 5.5 0 0 1-11 0c0-2.3 1-3.8 2.3-5.2.2 1.5.9 2.4 1.8 2.8C10.2 8.3 10.5 5 12 2.5Z" /><path d="M12 20.2c-1.6 0-2.6-1-2.6-2.4 0-1.5 1.4-2.2 2.6-4 1.2 1.8 2.6 2.5 2.6 4 0 1.4-1 2.4-2.6 2.4Z" /></>,
  kindLeak: <><path d="M12 2.5c2.7 3.4 5 6 5 9a5 5 0 0 1-10 0c0-3 2.3-5.6 5-9Z" /><path d="M3 19c1.6-1.6 3-1.6 4.5 0s3 1.6 4.5 0 3-1.6 4.5 0 3 1.6 4.5 0" /></>,
  // W7k feedback: the saved check, a toast's close cross, and the info and alert signs on the toasts.
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.2h.01" /></>,
  kindGeneric: <><path d="M12 3 4 7.5v9l8 4.5 8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;
}
