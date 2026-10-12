import type { CallRow, EntryRow, ToolRow, TreeLine } from "../types.ts";
export interface ViewData {
	entries: EntryRow[];
	calls: CallRow[];
	tools: ToolRow[];
	leafId: string | null;
}
export interface Point {
	index: number;
	value: number | null;
	id?: string;
	at?: string;
	label?: string;
}
export function escapeHtml(value: unknown): string;
export function number(value: number | null | undefined): string;
export function bytes(value: number | null | undefined): string;
export function time(value: number | null | undefined): string;
export function clock(value: string | undefined): string;
export function shortModel(value: string | undefined): string;
export function branchIds(entries: EntryRow[], leafId: string | null): Set<string>;
export function branchPath(entries: EntryRow[], leafId: string | null): EntryRow[];
export function entryMatches(entry: EntryRow, filter: string): boolean;
export function scoped(data: ViewData, scope: string): ViewData;
export function statistics(data: ViewData): {
	input: number;
	output: number;
	cache: number;
	cost: number;
	recorded: number;
	cacheRatio: number | null;
	medianMs: number | null;
	timedCalls: number;
	calls: number;
	errors: number;
	retries: number;
	tools: Array<{ name: string; count: number; errors: number; duration: number; timed: number }>;
};
export function flattenTree(entries: EntryRow[]): Array<{ entry: EntryRow; depth: number }>;
export function sessionTree(
	entries: EntryRow[],
	visibleEntries: EntryRow[],
): Array<{ entry: EntryRow; depth: number; prefix: string }>;
export function sessionLines(entry: EntryRow, toolCalls?: Map<string, string>): TreeLine[];
export function rowOffsets(heights: number[]): number[];
export function variableWindow(
	offsets: number[],
	scrollTop: number,
	height: number,
	overscan?: number,
): { start: number; end: number; before: number; after: number };
export function virtualWindow(
	length: number,
	scrollTop: number,
	height: number,
	rowHeight?: number,
	overscan?: number,
): { start: number; end: number; before: number; after: number };
export function sample<T extends Point>(points: T[], limit?: number): T[];
