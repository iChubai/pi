import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { redact } from "./format.ts";
import type { TraceStore } from "./store.ts";

export class Collector {
	private store: TraceStore;
	private current?: { id: string; kind: string; attempt: number; started: number };
	private lastId?: string;
	private nextKind = "agent";
	private turnIndex?: number;
	private toolStarts = new Map<string, number>();
	private tools: () => ToolInfo[];

	constructor(store: TraceStore, tools: () => ToolInfo[] = () => []) {
		this.store = store;
		this.tools = tools;
	}
	startTurn(turnIndex: number): void {
		this.turnIndex = turnIndex;
	}
	start(kind: string, ctx: ExtensionContext): string {
		if (this.current) this.interrupt();
		const id = randomUUID();
		this.current = { id, kind, attempt: 0, started: performance.now() };
		this.lastId = id;
		this.store.append({
			type: "call_started",
			callId: id,
			kind,
			leafId: ctx.sessionManager.getLeafId(),
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
			turnIndex: kind === "agent" ? this.turnIndex : undefined,
		});
		return id;
	}
	context(messages: unknown[], ctx: ExtensionContext, final = false): void {
		const id = final && this.current?.kind === "agent" ? this.current.id : this.start("agent", ctx);
		this.store.append({
			type: "generic_context",
			callId: id,
			context: {
				systemPrompt: ctx.getSystemPrompt(),
				messages,
				tools: this.tools(),
				phase: final ? "context_with_system" : "context",
			},
		});
	}
	request(payload: unknown, ctx: ExtensionContext): void {
		const id = this.current?.id ?? this.start(this.nextKind === "agent" ? "unknown" : this.nextKind, ctx);
		if (this.current) this.current.attempt++;
		this.store.append({
			type: "provider_request",
			callId: id,
			attempt: this.current?.attempt ?? 1,
			payload: redact(payload),
		});
	}
	response(status: number, headers: Record<string, string>): void {
		if (this.current)
			this.store.append({ type: "provider_response", callId: this.current.id, status, headers: redact(headers) });
	}
	update(event: MessageUpdateEvent): void {
		if (!this.current || this.current.kind !== "agent") return;
		// Omit the full growing partial BEFORE serialization; never clone it for each token.
		const compact = Object.fromEntries(
			Object.entries(event.assistantMessageEvent).filter(([key]) => key !== "partial"),
		);
		this.store.append({
			type: "output_event",
			callId: this.current.id,
			event: compact,
			elapsedMs: performance.now() - this.current.started,
		});
	}
	end(event: MessageEndEvent): void {
		if (!this.current || this.current.kind !== "agent" || event.message.role !== "assistant") return;
		const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
		this.store.append({
			type: failed ? "call_failed" : "call_completed",
			callId: this.current.id,
			message: event.message,
			error: failed ? (event.message.errorMessage ?? event.message.stopReason) : undefined,
			durationMs: performance.now() - this.current.started,
		});
		this.current = undefined;
		this.store.invalidate();
	}
	compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): void {
		this.nextKind = "compaction";
		const id = this.start("compaction", ctx);
		const prep = event.preparation;
		this.store.append({
			type: "compaction_context",
			callId: id,
			context: {
				reason: event.reason,
				willRetry: event.willRetry,
				customInstructions: event.customInstructions,
				firstKeptEntryId: prep.firstKeptEntryId,
				isSplitTurn: prep.isSplitTurn,
				tokensBefore: prep.tokensBefore,
				previousSummary: prep.previousSummary,
				messagesToSummarize: prep.messagesToSummarize,
				turnPrefixMessages: prep.turnPrefixMessages,
				settings: prep.settings,
				fileOps: {
					read: [...prep.fileOps.read],
					written: [...prep.fileOps.written],
					edited: [...prep.fileOps.edited],
				},
			},
		});
	}
	completeSummary(kind: string, summary: string, entryId: string): void {
		if (this.current?.kind === kind) {
			this.store.append({
				type: kind === "compaction" ? "compaction_completed" : "branch_summary_completed",
				callId: this.current.id,
				summary,
				sourceEntryId: entryId,
				durationMs: performance.now() - this.current.started,
			});
			this.current = undefined;
		}
		this.nextKind = "agent";
		this.store.invalidate();
	}
	prepareBranch(): void {
		this.nextKind = "branch_summary";
	}
	fail(error: string): void {
		if (this.current)
			this.store.append({
				type: "call_failed",
				callId: this.current.id,
				error,
				durationMs: performance.now() - this.current.started,
			});
		this.current = undefined;
		this.nextKind = "agent";
	}
	toolStart(event: ToolExecutionStartEvent, ctx: ExtensionContext): void {
		this.toolStarts.set(event.toolCallId, performance.now());
		this.store.append({
			type: "tool_started",
			callId: this.lastId ?? "tools",
			toolId: event.toolCallId,
			toolName: event.toolName,
			parentId: event.parentToolCallId,
			leafId: ctx.sessionManager.getLeafId(),
		});
	}
	toolEnd(event: ToolExecutionEndEvent): void {
		const start = this.toolStarts.get(event.toolCallId);
		this.toolStarts.delete(event.toolCallId);
		this.store.append({
			type: "tool_completed",
			callId: this.lastId ?? "tools",
			toolId: event.toolCallId,
			isError: event.isError,
			durationMs: event.durationMs ?? (start === undefined ? undefined : performance.now() - start),
		});
		this.store.invalidate();
	}
	interrupt(): void {
		if (this.current)
			this.store.append({
				type: "call_interrupted",
				callId: this.current.id,
				error: "Capture paused or session detached",
				durationMs: performance.now() - this.current.started,
			});
		this.current = undefined;
		this.nextKind = "agent";
		for (const toolId of this.toolStarts.keys())
			this.store.append({ type: "tool_interrupted", callId: this.lastId ?? "tools", toolId });
		this.toolStarts.clear();
	}
}
