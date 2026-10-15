// The alignment guides' types (the functions arrive with W7u Task 2).
export interface Rect { x: number; y: number; w: number; h: number }
export interface Guide { at: number; from: number; to: number }
export interface Guides { vertical: Guide[]; horizontal: Guide[] }
