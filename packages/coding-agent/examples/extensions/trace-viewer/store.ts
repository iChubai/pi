import { performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { entryRow, finite, messageKey, record, text, usage } from "./format.ts";
import { Journal } from "./journal.ts";
import type {
	CallDetail,
	CallRow,
	EntryRow,
	SearchPage,
	SessionSource,
	ToolRow,
	TraceRecord,
	UpdatePacket,
} from "./types.ts";

/** Only compact indexes are resident. Request bodies and stream events are fetched from the journal on demand. */
export class TraceStore {
	readonly journal: Journal;
	readonly id: string;
	active = true;
	capture = true;
	revision = 1;
	private source: SessionSource;
	private rows = new Map<string, EntryRow>();
	private calls = new Map<string, CallRow>();
	private tools = new Map<string, ToolRow>();
	private finalKeys = new Map<string, string>();
	private nativeKeys = new Map<string, string[]>();
	private removed = new Map<string, number>();
	private dirty = true;
	private listeners = new Set<() => void>();

	constructor(source: SessionSource) {
		this.source = source;
		this.id = source.id;
		this.journal = new Journal(source.cwd, source.id, () => {
			this.touch();
		});
	}
	async initialize(): Promise<void> {
		await this.journal.initialize((value) => this.apply(value));
		for (const call of this.calls.values())
			if (call.status === "running") {
				call.status = "interrupted";
				call.version = ++this.revision;
			}
		for (const tool of this.tools.values())
			if (tool.status === "running") {
				tool.status = "interrupted";
				tool.version = ++this.revision;
			}
		this.sync();
	}
	bind(source: SessionSource): void {
		this.source = source;
		this.active = true;
		this.invalidate();
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	touch(): number {
		const version = ++this.revision;
		for (const listener of this.listeners) listener();
		return version;
	}
	invalidate(): void {
		this.dirty = true;
		this.touch();
	}
	append(value: Parameters<Journal["append"]>[0]): TraceRecord {
		const trace = this.journal.append(value);
		this.apply(trace);
		return trace;
	}
	private apply(value: TraceRecord): void {
		const version = this.touch();
		if (!value.callId) return;
		if (value.type === "call_started") {
			const model = record(value.model) ? `${value.model.provider}/${value.model.id}` : undefined;
			this.calls.set(value.callId, {
				id: value.callId,
				kind: typeof value.kind === "string" ? value.kind : "unknown",
				source: value.captureSource === "session_entry" ? "history" : "live",
				status: "running",
				startedAt: value.timestamp,
				anchorId: typeof value.leafId === "string" ? value.leafId : null,
				entryId: typeof value.sourceEntryId === "string" ? value.sourceEntryId : undefined,
				model,
				api: record(value.model) && typeof value.model.api === "string" ? value.model.api : undefined,
				turnIndex: finite(value.turnIndex),
				preview: "",
				attempts: 0,
				streamEvents: 0,
				version,
			});
			return;
		}
		if (value.type === "tool_started") {
			if (typeof value.toolId !== "string" || typeof value.toolName !== "string") return;
			this.tools.set(value.toolId, {
				id: value.toolId,
				parentId: typeof value.parentId === "string" ? value.parentId : undefined,
				callId: value.callId,
				anchorId: typeof value.leafId === "string" ? value.leafId : null,
				name: value.toolName,
				startedAt: value.timestamp,
				status: "running",
				version,
			});
			return;
		}
		if (value.type === "tool_completed" || value.type === "tool_interrupted") {
			const tool = typeof value.toolId === "string" ? this.tools.get(value.toolId) : undefined;
			if (tool) {
				tool.durationMs = finite(value.durationMs);
				tool.status = value.type === "tool_interrupted" ? "interrupted" : value.isError ? "error" : "success";
				tool.version = version;
			}
			return;
		}
		const call = this.calls.get(value.callId);
		if (!call) return;
		call.version = version;
		if (value.type === "generic_context" && record(value.context)) {
			const messages = Array.isArray(value.context.messages) ? value.context.messages : [];
			const last = messages.findLast((message) => record(message) && message.role === "user");
			call.preview = record(last) ? text(last.content) : "Model call";
		} else if (value.type === "provider_request") {
			call.attempts++;
			const bytes = Buffer.byteLength(JSON.stringify(value.payload) ?? "null");
			call.payloadBytes = bytes;
		} else if (value.type === "output_event") {
			call.streamEvents++;
			if (
				record(value.event) &&
				["text_delta", "thinking_delta", "toolcall_start"].includes(String(value.event.type)) &&
				call.firstOutputMs === undefined
			)
				call.firstOutputMs =
					finite(value.elapsedMs) ?? finite(Date.parse(value.timestamp) - Date.parse(call.startedAt));
		} else if (
			[
				"call_completed",
				"call_failed",
				"call_interrupted",
				"compaction_completed",
				"branch_summary_completed",
			].includes(value.type)
		) {
			call.status =
				value.type === "call_interrupted" || (record(value.message) && value.message.stopReason === "aborted")
					? "interrupted"
					: value.type === "call_failed"
						? "error"
						: "success";
			call.endedAt = value.timestamp;
			if (call.source === "live")
				call.durationMs =
					finite(value.durationMs) ?? finite(Date.parse(value.timestamp) - Date.parse(call.startedAt));
			if (typeof value.sourceEntryId === "string") call.entryId = value.sourceEntryId;
			if (record(value.message)) {
				if (typeof value.message.provider === "string" && typeof value.message.model === "string")
					call.model = `${value.message.provider}/${value.message.model}`;
				call.usage = usage(value.message.usage);
				if (typeof value.message.api === "string") call.api = value.message.api;
				call.activity =
					text(value.message.content) || (typeof value.error === "string" ? text(value.error) : undefined);
				const key = messageKey(value.message);
				if (key) this.finalKeys.set(call.id, key);
			}
			if (value.type === "compaction_completed") call.preview = "Context compaction";
			if (value.type === "branch_summary_completed") call.preview = "Branch summary";
			this.dirty = true;
		}
	}
	private sync(): void {
		if (!this.dirty) return;
		this.dirty = false;
		const version = this.touch();
		for (const entry of this.source.entries()) {
			if (this.rows.has(entry.id)) continue;
			const row = entryRow(entry, version);
			this.rows.set(entry.id, row);
			if (entry.type === "label") {
				const target = this.rows.get(entry.targetId);
				if (target) {
					target.label = entry.label;
					target.version = version;
				}
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				const key = messageKey(entry.message);
				if (key) {
					const ids = this.nativeKeys.get(key) ?? [];
					ids.push(entry.id);
					this.nativeKeys.set(key, ids);
				}
				this.calls.set(`entry-${entry.id}`, {
					id: `entry-${entry.id}`,
					kind: "agent",
					source: "history",
					status: entry.message.stopReason === "aborted" ? "interrupted" : row.isError ? "error" : "success",
					startedAt: entry.timestamp,
					entryId: entry.id,
					anchorId: entry.parentId,
					model: row.model,
					api: entry.message.api,
					activity: row.toolCalls?.join(" · ") || row.preview,
					preview: row.preview,
					usage: row.usage,
					attempts: 0,
					streamEvents: 0,
					version,
				});
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				this.calls.set(`entry-${entry.id}`, {
					id: `entry-${entry.id}`,
					kind: entry.type,
					source: "history",
					status: "success",
					startedAt: entry.timestamp,
					entryId: entry.id,
					anchorId: entry.parentId,
					preview: row.preview,
					usage: row.usage,
					attempts: 0,
					streamEvents: 0,
					version,
				});
			} else if (entry.type === "message" && entry.message.role === "toolResult") {
				const existing = this.tools.get(entry.message.toolCallId);
				if (existing) {
					existing.entryId = entry.id;
					existing.version = version;
				} else
					this.tools.set(entry.message.toolCallId, {
						id: entry.message.toolCallId,
						entryId: entry.id,
						anchorId: entry.parentId,
						name: entry.message.toolName,
						startedAt: entry.timestamp,
						status: entry.message.isError ? "error" : "success",
						version,
					});
			}
		}
		const observations = [...this.calls.values()].filter((call) => call.id !== `entry-${call.entryId}`);
		const used = new Set(observations.flatMap((call) => (call.entryId ? [call.entryId] : [])));
		for (const call of observations)
			if (call.source === "live" || call.entryId) {
				const key = this.finalKeys.get(call.id);
				if (!call.entryId && key) call.entryId = this.nativeKeys.get(key)?.find((id) => !used.has(id));
				if (!call.entryId) continue;
				used.add(call.entryId);
				const native = this.calls.get(`entry-${call.entryId}`);
				if (native && native !== call) {
					call.usage ??= native.usage;
					call.model ??= native.model;
					call.api ??= native.api;
					call.activity = native.activity;
					call.version = version;
					this.calls.delete(native.id);
					this.removed.set(native.id, version);
				}
			}
	}
	packet(after = 0): UpdatePacket & { removedCalls: string[] } {
		this.sync();
		const reset = after < 1 || after > this.revision;
		const cursor = reset ? 0 : after;
		return {
			id: this.id,
			name: this.source.name,
			createdAt: this.source.header?.timestamp,
			cwd: this.source.cwd,
			leafId: this.source.leafId(),
			revision: this.revision,
			reset,
			active: this.active,
			capture: this.active && this.capture,
			persistence: this.journal.state,
			entryCount: this.rows.size,
			entries: [...this.rows.values()].filter((row) => row.version > cursor),
			calls: [...this.calls.values()].filter((call) => call.version > cursor),
			tools: [...this.tools.values()].filter((tool) => tool.version > cursor),
			removedCalls: [...this.removed].filter(([, version]) => version > cursor).map(([id]) => id),
		};
	}
	metadata() {
		return {
			id: this.id,
			name: this.source.name,
			cwd: this.source.cwd,
			active: this.active,
			capture: this.active && this.capture,
			revision: this.revision,
		};
	}
	entry(id: string) {
		return this.source.entry(id);
	}
	header() {
		return this.source.header;
	}
	entries() {
		return this.source.entries();
	}
	info() {
		return { header: this.source.header, systemPrompt: this.source.systemPrompt?.(), tools: this.source.tools?.() };
	}
	async search(scope: "entries" | "calls", query: string, after = 0, signal?: AbortSignal): Promise<SearchPage> {
		this.sync();
		const rows = [...(scope === "entries" ? this.rows.values() : this.calls.values())];
		const ids: string[] = [];
		let cursor = Math.min(after, rows.length),
			unavailable = 0;
		const started = performance.now();
		while (cursor < rows.length && cursor < after + 128) {
			signal?.throwIfAborted();
			const row = rows[cursor++]!;
			let matched = JSON.stringify(row).toLowerCase().includes(query);
			if (!matched) {
				if (scope === "entries" || ("source" in row && row.source === "history")) {
					const entry = this.source.entry("entryId" in row ? (row.entryId ?? row.id) : row.id);
					if (entry) matched = JSON.stringify(entry).toLowerCase().includes(query);
					else unavailable++;
				} else {
					const result = await this.journal.search(row.id, query, signal);
					matched = result.matched;
					unavailable += result.incomplete ? 1 : 0;
				}
			}
			if (matched) ids.push(row.id);
			await yieldTurn();
			if (performance.now() - started >= 50) break;
		}
		return { ids, next: cursor < rows.length ? cursor : null, total: rows.length, scanned: cursor, unavailable };
	}
	async detail(id: string): Promise<CallDetail | undefined> {
		this.sync();
		const call = this.calls.get(id);
		if (!call) return undefined;
		const detail: CallDetail = { id, meta: { ...call }, requests: [], responses: [], streamCount: call.streamEvents };
		if (call.source === "history") {
			detail.final = call.entryId ? this.source.entry(call.entryId) : undefined;
			return detail;
		}
		const { records } = await this.journal.read(id);
		for (const value of records) {
			if (value.type === "generic_context") detail.context = value.context;
			else if (value.type === "compaction_context") detail.compaction = value.context;
			else if (value.type === "provider_request")
				detail.requests.push({
					attempt: typeof value.attempt === "number" ? value.attempt : detail.requests.length + 1,
					timestamp: value.timestamp,
					payload: value.payload,
				});
			else if (value.type === "provider_response")
				detail.responses.push({ status: value.status, headers: value.headers, timestamp: value.timestamp });
			else if (value.type === "call_completed") detail.final = value.message;
			else if (value.type === "call_failed" || value.type === "call_interrupted") {
				detail.error = typeof value.error === "string" ? value.error : "Call failed";
				detail.final = value.message;
			} else if (value.type === "compaction_completed" || value.type === "branch_summary_completed")
				detail.final = { summary: value.summary };
		}
		return detail;
	}
	async detach(): Promise<void> {
		this.sync();
		this.active = false;
		this.touch();
		await this.journal.flush();
	}
}
