import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EntryRow, UsageNumbers } from "./types.ts";

export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
		? value
		: undefined;
}
export function text(content: unknown, limit = 160): string {
	if (typeof content === "string") return content.slice(0, limit).replace(/\s+/g, " ").trim();
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const block of content) {
		if (!record(block)) continue;
		const part =
			typeof block.text === "string"
				? block.text
				: typeof block.thinking === "string"
					? block.thinking
					: block.type === "toolCall"
						? `${block.name}()`
						: block.type === "image"
							? "[image]"
							: "";
		result += `${part.slice(0, limit - result.length)} `;
		if (result.length >= limit) break;
	}
	return result.slice(0, limit).replace(/\s+/g, " ").trim();
}
export function usage(value: unknown): UsageNumbers | undefined {
	if (!record(value)) return undefined;
	const input = finite(value.input),
		output = finite(value.output),
		cacheRead = finite(value.cacheRead),
		cacheWrite = finite(value.cacheWrite);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
		return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
		cost: record(value.cost) ? (finite(value.cost.total) ?? null) : null,
	};
}
export function messageKey(message: unknown): string | undefined {
	if (!record(message) || message.role !== "assistant") return undefined;
	try {
		return createHash("sha256")
			.update(
				JSON.stringify([message.provider, message.model, message.timestamp, message.responseId, message.content]),
			)
			.digest("hex");
	} catch {
		return undefined;
	}
}
export function entryRow(entry: SessionEntry, version: number): EntryRow {
	const row: EntryRow = {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		type: entry.type,
		preview: "",
		version,
	};
	if (entry.type === "message") {
		row.role = entry.message.role;
		row.preview =
			text(
				"content" in entry.message
					? entry.message.content
					: "output" in entry.message
						? entry.message.output
						: entry.message.summary,
			) || `(${entry.message.role})`;
		if (entry.message.role === "assistant") {
			row.model = `${entry.message.provider}/${entry.message.model}`;
			row.toolCalls = entry.message.content
				.filter((block) => block.type === "toolCall")
				.slice(0, 8)
				.map((block) => {
					const args = record(block.arguments) ? block.arguments : {};
					const hint = args.path ?? args.file_path ?? args.command ?? args.pattern;
					return `${block.name}: ${typeof hint === "string" ? text(hint, 100) : Object.keys(args).slice(0, 3).join(", ")}`;
				});
			const calls = entry.message.content.filter((block) => block.type === "toolCall").slice(0, 8);
			if (calls.length) row.toolCallIds = calls.map((block) => block.id);
			const thinking = entry.message.content.filter((block) => block.type === "thinking");
			if (thinking.length || calls.length) {
				row.lines = [];
				if (thinking.length)
					row.lines.push({
						className: "line-thinking",
						label: "thinking: ",
						text: text(thinking) || "(encrypted signature)",
					});
				row.lines.push({
					className: entry.message.stopReason === "error" ? "line-error" : "line-assistant",
					label: "assistant: ",
					text: text(entry.message.content.filter((block) => block.type === "text")) || "(no text)",
				});
				for (const description of row.toolCalls)
					row.lines.push({ className: "line-tool-call", label: "call: ", text: `[${description}]` });
			}
			row.usage = usage(entry.message.usage);
			row.isError = entry.message.stopReason === "error" || entry.message.stopReason === "aborted";
		} else if (entry.message.role === "toolResult") {
			row.tool = entry.message.toolName;
			row.toolCallId = entry.message.toolCallId;
			row.isError = entry.message.isError;
			row.usage = usage(entry.message.usage);
		}
	} else if (entry.type === "compaction") {
		row.preview = text(entry.summary);
		row.tokensBefore = entry.tokensBefore;
		row.usage = usage(entry.usage);
	} else if (entry.type === "branch_summary") {
		row.preview = text(entry.summary);
		row.usage = usage(entry.usage);
	} else if (entry.type === "custom_message") {
		row.preview = text(entry.content);
		row.customType = entry.customType;
		row.display = entry.display;
	} else if (entry.type === "model_change") row.preview = `${entry.provider}/${entry.modelId}`;
	else if (entry.type === "thinking_level_change") row.preview = entry.thinkingLevel;
	else if (entry.type === "session_info") row.preview = entry.name ?? "";
	else if (entry.type === "label") row.preview = entry.label ?? "";
	else if (entry.type === "custom") {
		row.preview = entry.customType;
		row.customType = entry.customType;
	} else if (entry.type === "context_edit")
		row.preview = `${entry.replacement === null ? "Omitted" : "Replaced"} ${entry.targetId} in future context`;
	else if (entry.type === "usage") {
		row.preview = entry.kind;
		row.usage = usage(entry.usage);
	}
	return row;
}
const SECRET =
	/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)$/i;
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const result = Array.isArray(value)
		? value.map((item) => redact(item, seen))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, SECRET.test(key) ? "[REDACTED]" : redact(item, seen)]),
			);
	seen.delete(value);
	return result;
}
