export const escapeHtml = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	);
export const number = (value) =>
	value == null || !Number.isFinite(value)
		? "—"
		: new Intl.NumberFormat("en", {
				notation: value >= 10000 ? "compact" : "standard",
				maximumFractionDigits: 1,
			}).format(value);
export const bytes = (value) =>
	value == null ? "—" : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
export const time = (value) =>
	value == null
		? "—"
		: value >= 60000
			? `${(value / 60000).toFixed(1)} min`
			: value >= 1000
				? `${(value / 1000).toFixed(1)} s`
				: `${Math.round(value)} ms`;
export const clock = (value) =>
	value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
export const shortModel = (value) => value?.split("/").slice(1).join("/") || "Unknown model";

export function branchIds(entries, leafId) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const ids = new Set();
	for (let id = leafId; id && !ids.has(id); id = byId.get(id)?.parentId) ids.add(id);
	return ids;
}
export function branchPath(entries, leafId) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const result = [],
		seen = new Set();
	for (let id = leafId; id && !seen.has(id); ) {
		seen.add(id);
		const entry = byId.get(id);
		if (!entry) break;
		result.push(entry);
		id = entry.parentId;
	}
	return result.reverse();
}
export function entryMatches(entry, filter) {
	const setting = ["label", "model_change", "thinking_level_change", "session_info"].includes(entry.type);
	if (filter === "default") return !setting;
	if (filter === "user") return entry.role === "user";
	if (filter === "errors") return Boolean(entry.isError);
	if (filter === "labeled") return Boolean(entry.label);
	if (filter === "no-tools") return !setting && entry.role !== "toolResult";
	return true;
}
export function scoped(data, scope) {
	if (scope === "all") return data;
	const ids = branchIds(data.entries, data.leafId);
	const calls = data.calls.filter((call) => ids.has(call.entryId || call.anchorId));
	const callIds = new Set(calls.map((call) => call.id));
	return {
		...data,
		entries: data.entries.filter((entry) => ids.has(entry.id)),
		calls,
		tools: data.tools.filter((tool) =>
			tool.entryId ? ids.has(tool.entryId) : ids.has(tool.anchorId) || callIds.has(tool.callId),
		),
	};
}
export function statistics(data) {
	let input = 0,
		output = 0,
		cache = 0,
		cost = 0,
		recorded = 0;
	for (const entry of data.entries)
		if (entry.usage) {
			input += entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			output += entry.usage.output;
			cache += entry.usage.cacheRead;
			if (entry.usage.cost !== null) cost += entry.usage.cost;
			recorded++;
		}
	const durations = data.calls
		.flatMap((call) => (Number.isFinite(call.durationMs) ? [call.durationMs] : []))
		.sort((a, b) => a - b);
	const tools = new Map();
	for (const tool of data.tools) {
		const row = tools.get(tool.name) ?? { name: tool.name, count: 0, errors: 0, duration: 0, timed: 0 };
		row.count++;
		row.errors += tool.status === "error" ? 1 : 0;
		if (tool.durationMs != null) {
			row.duration += tool.durationMs;
			row.timed++;
		}
		tools.set(tool.name, row);
	}
	return {
		input,
		output,
		cache,
		cost,
		recorded,
		cacheRatio: input > 0 ? (cache / input) * 100 : null,
		medianMs: durations.length
			? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2
			: null,
		timedCalls: durations.length,
		calls: data.calls.length,
		errors: data.calls.filter((call) => call.status === "error").length,
		retries: data.calls.reduce((sum, call) => sum + Math.max(0, call.attempts - 1), 0),
		tools: [...tools.values()].sort((a, b) => b.duration - a.duration || b.count - a.count),
	};
}
export function flattenTree(entries) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const children = new Map();
	for (const entry of entries) {
		const parent = byId.has(entry.parentId) ? entry.parentId : null;
		const list = children.get(parent) ?? [];
		list.push(entry);
		children.set(parent, list);
	}
	const stack = [...(children.get(null) ?? [])].reverse().map((entry) => ({ entry, depth: 0 }));
	const result = [],
		seen = new Set();
	while (stack.length) {
		const next = stack.pop();
		if (seen.has(next.entry.id)) continue;
		seen.add(next.entry.id);
		result.push(next);
		const list = children.get(next.entry.id) ?? [];
		for (let i = list.length - 1; i >= 0; i--)
			stack.push({ entry: list[i], depth: next.depth + (list.length > 1 ? 1 : 0) });
	}
	return result;
}
/** Original Pi Trace tree connectors, with filtered ancestors skipped and single-child chains flat. */
export function sessionTree(entries, visibleEntries) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
	const parents = new Map(),
		children = new Map();
	for (const entry of visibleEntries) {
		let parent = entry.parentId;
		const trail = [],
			seen = new Set();
		while (parent && !visibleIds.has(parent) && !parents.has(parent) && !seen.has(parent)) {
			seen.add(parent);
			trail.push(parent);
			parent = byId.get(parent)?.parentId;
		}
		parent = visibleIds.has(parent) ? parent : parents.get(parent) || null;
		for (const id of trail) parents.set(id, parent);
		const list = children.get(parent) || [];
		list.push(entry);
		children.set(parent, list);
	}
	const roots = children.get(null) || [],
		multipleRoots = roots.length > 1;
	const stack = roots
		.map((entry, index) => ({
			entry,
			indent: multipleRoots ? 1 : 0,
			justBranched: multipleRoots,
			connector: false,
			last: index === roots.length - 1,
			gutters: [],
			virtual: multipleRoots,
		}))
		.reverse();
	const result = [],
		seen = new Set();
	while (stack.length) {
		const item = stack.pop();
		if (seen.has(item.entry.id)) continue;
		seen.add(item.entry.id);
		const depth = multipleRoots ? Math.max(0, item.indent - 1) : item.indent;
		let prefix = "";
		for (let level = 0; level < depth; level++) {
			const gutter = item.gutters.find((candidate) => candidate.position === level);
			prefix += gutter
				? gutter.show
					? "│  "
					: "   "
				: item.connector && level === depth - 1
					? item.last
						? "└─ "
						: "├─ "
					: "   ";
		}
		result.push({ entry: item.entry, depth, prefix });
		const next = children.get(item.entry.id) || [],
			branched = next.length > 1;
		const indent = branched || (item.justBranched && item.indent > 0) ? item.indent + 1 : item.indent;
		const gutters =
			item.connector && !item.virtual
				? [...item.gutters, { position: Math.max(0, depth - 1), show: !item.last }]
				: item.gutters;
		for (let index = next.length - 1; index >= 0; index--)
			stack.push({
				entry: next[index],
				indent,
				justBranched: branched,
				connector: branched,
				last: index === next.length - 1,
				gutters,
				virtual: false,
			});
	}
	return result;
}
export function sessionLines(entry, toolCalls = new Map()) {
	if (entry.lines?.length) return entry.lines;
	if (entry.role === "user") return [{ className: "line-user", label: "user: ", text: entry.preview }];
	if (entry.role === "assistant")
		return [{ className: entry.isError ? "line-error" : "line-assistant", label: "assistant: ", text: entry.preview }];
	if (entry.role === "toolResult")
		return [
			{
				className: entry.isError ? "line-tool-error" : "line-tool-result",
				label: "result: ",
				text: `[${toolCalls.get(entry.toolCallId) || entry.tool || "tool"}] · ${entry.preview}`,
			},
		];
	if (entry.type === "compaction")
		return [
			{
				className: "line-compaction",
				label: "compact: ",
				text: `${entry.tokensBefore == null ? "unknown" : `${Math.round(entry.tokensBefore / 1000)}k`} tokens`,
			},
		];
	if (entry.type === "branch_summary") return [{ className: "line-branch", label: "branch: ", text: entry.preview }];
	if (entry.type === "custom" || entry.type === "custom_message")
		return [
			{
				className: "line-custom",
				label: entry.type === "custom" ? "state: " : entry.display ? "custom: " : "hidden custom: ",
				text: `${entry.customType} · ${entry.preview}`,
			},
		];
	return [{ className: "line-setting", label: `${entry.type}: `, text: entry.preview }];
}
export function rowOffsets(heights) {
	const offsets = [0];
	for (const height of heights) offsets.push(offsets.at(-1) + height);
	return offsets;
}
export function variableWindow(offsets, scrollTop, height, overscan = 5) {
	const length = offsets.length - 1,
		total = offsets.at(-1);
	const top = Math.max(0, Math.min(scrollTop, Math.max(0, total - height)));
	const indexAt = (value) => {
		let low = 0,
			high = length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (offsets[mid] <= value) low = mid + 1;
			else high = mid;
		}
		return Math.max(0, low - 1);
	};
	const start = Math.max(0, indexAt(top) - overscan),
		end = Math.min(length, indexAt(top + height) + 1 + overscan);
	return { start, end, before: offsets[start], after: total - offsets[end] };
}
export function virtualWindow(length, scrollTop, height, rowHeight = 64, overscan = 5) {
	const top = Math.max(0, Math.min(scrollTop, Math.max(0, length * rowHeight - height)));
	const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
	const end = Math.min(length, Math.ceil((top + height) / rowHeight) + overscan);
	return { start, end, before: start * rowHeight, after: Math.max(0, (length - end) * rowHeight) };
}
/** Min/max buckets retain spikes rather than silently smoothing failures away. */
export function sample(points, limit = 360) {
	if (points.length <= limit) return points;
	const bucket = Math.ceil(points.length / Math.floor(limit / 2));
	const result = [];
	for (let i = 0; i < points.length; i += bucket) {
		const part = points.slice(i, i + bucket),
			valid = part.filter((point) => Number.isFinite(point.value));
		if (!valid.length) {
			result.push(part[0]);
			continue;
		}
		const sorted = valid.toSorted((a, b) => a.value - b.value);
		const gap = part.find((point) => !Number.isFinite(point.value));
		const extremes = [...new Set([sorted[0], sorted[sorted.length - 1], ...(gap ? [gap] : [])])].sort(
			(a, b) => a.index - b.index,
		);
		result.push(...extremes);
	}
	return result;
}
