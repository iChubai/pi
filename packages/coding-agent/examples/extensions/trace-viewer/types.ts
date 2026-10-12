import type { SessionEntry, SessionHeader, ToolInfo } from "@earendil-works/pi-coding-agent";

export interface UsageNumbers {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number | null;
}
export interface TreeLine {
	className: string;
	label: string;
	text: string;
}
export interface EntryRow {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	role?: string;
	customType?: string;
	display?: boolean;
	preview: string;
	label?: string;
	model?: string;
	usage?: UsageNumbers;
	tool?: string;
	toolCalls?: string[];
	toolCallIds?: string[];
	toolCallId?: string;
	lines?: TreeLine[];
	isError?: boolean;
	tokensBefore?: number;
	version: number;
}
export interface CallRow {
	id: string;
	kind: string;
	source: "live" | "history";
	status: "running" | "success" | "error" | "interrupted";
	startedAt: string;
	endedAt?: string;
	entryId?: string;
	anchorId?: string | null;
	model?: string;
	api?: string;
	turnIndex?: number;
	activity?: string;
	preview: string;
	usage?: UsageNumbers;
	durationMs?: number;
	firstOutputMs?: number;
	payloadBytes?: number;
	attempts: number;
	streamEvents: number;
	version: number;
}
export interface ToolRow {
	id: string;
	parentId?: string;
	callId?: string;
	entryId?: string;
	anchorId?: string | null;
	name: string;
	startedAt: string;
	durationMs?: number;
	status: "running" | "success" | "error" | "interrupted";
	version: number;
}
export interface TraceRecord {
	schemaVersion: 1;
	sessionId: string;
	sequence: number;
	timestamp: string;
	type: string;
	callId?: string;
	[key: string]: unknown;
}
export interface CallDetail {
	id: string;
	meta: CallRow;
	context?: unknown;
	compaction?: unknown;
	requests: Array<{ attempt: number; timestamp: string; payload: unknown }>;
	responses: Array<{ status: unknown; headers: unknown; timestamp: string }>;
	final?: unknown;
	error?: string;
	streamCount: number;
}
export interface SessionSource {
	id: string;
	cwd: string;
	name?: string;
	file?: string;
	header: SessionHeader | null;
	systemPrompt?(): string;
	tools?(): ToolInfo[];
	leafId(): string | null;
	entries(): SessionEntry[];
	entry(id: string): SessionEntry | undefined;
}
export interface SearchPage {
	ids: string[];
	next: number | null;
	total: number;
	scanned: number;
	unavailable: number;
}
export interface UpdatePacket {
	id: string;
	name?: string;
	createdAt?: string;
	cwd: string;
	leafId: string | null;
	revision: number;
	reset: boolean;
	active: boolean;
	capture: boolean;
	persistence: string;
	entryCount: number;
	entries: EntryRow[];
	calls: CallRow[];
	tools: ToolRow[];
}
