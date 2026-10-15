// The Find box's types (the functions arrive with W7u Task 2).
export type FindKind = "source" | "asset" | "cluster" | "point";
export interface FindEntry { id: string; kind: FindKind; label: string; context: string; text: string }
export interface FindResult { items: FindEntry[]; more: number }
