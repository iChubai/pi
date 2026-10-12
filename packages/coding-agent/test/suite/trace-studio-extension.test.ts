import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finite, redact, usage } from "../../examples/extensions/trace-viewer/format.ts";
import traceStudio from "../../examples/extensions/trace-viewer/index.ts";
import { Journal } from "../../examples/extensions/trace-viewer/journal.ts";
import { ViewerServer } from "../../examples/extensions/trace-viewer/server.ts";
import { TraceStore } from "../../examples/extensions/trace-viewer/store.ts";
import type { CallRow, EntryRow, SessionSource } from "../../examples/extensions/trace-viewer/types.ts";
import type * as ViewModel from "../../examples/extensions/trace-viewer/web/model.d.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

// Exercise the actual browser ES module, which is not part of the TypeScript source graph.
const {
	branchIds,
	branchPath,
	entryMatches,
	flattenTree,
	rowOffsets,
	sample,
	scoped,
	sessionLines,
	sessionTree,
	statistics,
	variableWindow,
	virtualWindow,
} = createRequire(import.meta.url)("../../examples/extensions/trace-viewer/web/model.js") as typeof ViewModel;
const roots: string[] = [];
const journals: Journal[] = [];
const servers: ViewerServer[] = [];
const harnesses: Harness[] = [];
const KEY = Symbol.for("pi-trace-studio.server");
const globals = globalThis as { [KEY]?: Promise<ViewerServer> };
function extension(pi: ExtensionAPI): void {
	traceStudio(pi);
	const getFlag = pi.getFlag;
	pi.getFlag = (name) => (name === "pi-trace-port" ? "0" : getFlag(name));
}

function source(manager: SessionManager, cwd: string): SessionSource {
	return {
		id: manager.getSessionId(),
		cwd,
		header: manager.getHeader(),
		leafId: () => manager.getLeafId(),
		entries: () => manager.getEntries(),
		entry: (id) => manager.getEntry(id),
	};
}
async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-trace-test-"));
	roots.push(cwd);
	const manager = SessionManager.inMemory(cwd);
	const store = new TraceStore(source(manager, cwd));
	journals.push(store.journal);
	await store.initialize();
	return { cwd, manager, store };
}
async function http(origin: string, path: string, headers: Record<string, string> = {}, method = "GET") {
	return new Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }>(
		(resolve, reject) => {
			const req = request(new URL(path, origin), { headers, method, signal: AbortSignal.timeout(5000) }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						text: Buffer.concat(chunks).toString("utf8"),
						headers: res.headers,
					}),
				);
				res.on("error", reject);
			});
			req.on("error", reject);
			req.end();
		},
	);
}
function row(id: string, parentId: string | null): EntryRow {
	return {
		id,
		parentId,
		timestamp: "2026-10-11T10:00:00Z",
		type: "message",
		role: "assistant",
		preview: id,
		version: 1,
	};
}
function call(id: string, entryId: string, durationMs?: number): CallRow {
	return {
		id,
		entryId,
		source: "live",
		kind: "agent",
		status: "success",
		startedAt: "2026-10-11T10:00:00Z",
		preview: id,
		attempts: 1,
		streamEvents: 0,
		version: 1,
		durationMs,
	};
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	delete globals[KEY];
	for (const server of servers.splice(0)) await server.close();
	for (const journal of journals.splice(0)) await journal.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("Trace Studio compact indexes", () => {
	it("keeps multi-megabyte message bodies out of metadata and emits no unchanged rows", async () => {
		const { manager, store } = await setup();
		manager.appendMessage({ role: "user", content: "x".repeat(8 * 1024 * 1024), timestamp: Date.now() });
		store.invalidate();
		const packet = store.packet();
		expect(JSON.stringify(packet).length).toBeLessThan(4000);
		expect(packet.entries[0]?.preview.length).toBeLessThanOrEqual(160);
		const unchanged = store.packet(packet.revision);
		expect(unchanged.entries).toEqual([]);
		expect(unchanged.calls).toEqual([]);
		expect(store.entry(packet.entries[0]!.id)?.type).toBe("message");
	});
	it("sends only appended nodes, label changes and affected call summaries", async () => {
		const { manager, store } = await setup();
		const id = manager.appendMessage({ role: "user", content: "one", timestamp: Date.now() });
		store.invalidate();
		const first = store.packet();
		manager.appendLabelChange(id, "checkpoint");
		store.invalidate();
		const changed = store.packet(first.revision);
		expect(changed.entries).toHaveLength(2);
		expect(changed.entries.find((entry) => entry.id === id)?.label).toBe("checkpoint");
	});
	it("matches captured calls to native entries rather than counting their usage twice", async () => {
		const { manager, store } = await setup();
		const message = fauxAssistantMessage("answer");
		store.append({ type: "call_started", callId: "live", kind: "agent" });
		store.append({ type: "call_completed", callId: "live", message });
		const id = manager.appendMessage(message);
		store.invalidate();
		const packet = store.packet();
		expect(packet.calls).toHaveLength(1);
		expect(packet.calls[0]?.entryId).toBe(id);
		expect(packet.removedCalls).toContain(`entry-${id}`);
	});
	it("deduplicates captured observations even when native history was indexed first", async () => {
		const { manager, store } = await setup();
		const message = fauxAssistantMessage("already indexed");
		const id = manager.appendMessage(message);
		store.invalidate();
		store.packet();
		store.append({ type: "call_started", callId: "late-observation", kind: "agent" });
		store.append({ type: "call_completed", callId: "late-observation", message });
		const packet = store.packet();
		expect(packet.calls).toHaveLength(1);
		expect(packet.calls[0]?.entryId).toBe(id);
	});
	it("matches identical message fingerprints one-to-one without reserving native index rows", async () => {
		const { manager, store } = await setup();
		const message = fauxAssistantMessage("same", { timestamp: 1000 });
		manager.appendMessage(message);
		manager.appendMessage(message);
		store.invalidate();
		store.packet();
		for (const id of ["first", "second"]) {
			store.append({ type: "call_started", callId: id, kind: "agent" });
			store.append({ type: "call_completed", callId: id, message });
		}
		const calls = store.packet().calls;
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((call) => call.entryId)).size).toBe(2);
	});
	it("never invents timing or payload values for historical assistant messages", async () => {
		const { manager, store } = await setup();
		manager.appendMessage(fauxAssistantMessage("historical"));
		store.invalidate();
		const result = store.packet().calls[0];
		expect(result?.source).toBe("history");
		expect(result?.durationMs).toBeUndefined();
		expect(result?.payloadBytes).toBeUndefined();
	});
	it("pages stream events separately and loads a selected payload lazily", async () => {
		const { store } = await setup();
		store.append({ type: "call_started", callId: "a", kind: "agent" });
		store.append({ type: "provider_request", callId: "a", payload: { input: "large".repeat(100000) } });
		for (let i = 0; i < 170; i++)
			store.append({ type: "output_event", callId: "a", event: { type: "text_delta", delta: "x" } });
		expect(JSON.stringify(store.packet()).length).toBeLessThan(3000);
		expect((await store.detail("a"))?.requests).toHaveLength(1);
		const page = await store.journal.read("a", true);
		expect(page.records).toHaveLength(80);
		expect(page.next).toBe(80);
		expect(page.total).toBe(170);
		expect((await store.journal.read("a", true, 160)).records).toHaveLength(10);
	});
	it("marks paused captures as interrupted, not provider errors", async () => {
		const { store } = await setup();
		store.append({ type: "call_started", callId: "a", kind: "agent" });
		store.append({ type: "call_interrupted", callId: "a" });
		expect(store.packet().calls[0]?.status).toBe("interrupted");
	});
});

describe("Original viewer feature parity", () => {
	it("preserves original tree connectors, flat chains, and nearest visible ancestors", () => {
		const entries = [
			row("root", null),
			row("left", "root"),
			row("left-child", "left"),
			row("left-leaf", "left-child"),
			row("right", "root"),
			row("right-child", "right"),
		];
		expect(sessionTree(entries, entries).map(({ entry, depth, prefix }) => [entry.id, depth, prefix])).toEqual([
			["root", 0, ""],
			["left", 1, "├─ "],
			["left-child", 2, "│     "],
			["left-leaf", 2, "│     "],
			["right", 1, "└─ "],
			["right-child", 2, "      "],
		]);
		const filtered = entries.filter((entry) => ["root", "left-leaf", "right-child"].includes(entry.id));
		expect(sessionTree(entries, filtered).map(({ entry, prefix }) => [entry.id, prefix])).toEqual([
			["root", ""],
			["left-leaf", "├─ "],
			["right-child", "└─ "],
		]);
		const roots = [row("a", null), row("a-child", "a"), row("b", null)];
		expect(sessionTree(roots, roots).map(({ entry, depth }) => [entry.id, depth])).toEqual([
			["a", 0],
			["a-child", 1],
			["b", 0],
		]);
	});
	it("bounds the original multi-line tree with variable heights and large scroll offsets", () => {
		const heights = Array.from({ length: 100000 }, (_, index) => (index % 3 ? 30 : 78));
		const offsets = rowOffsets(heights);
		const window = variableWindow(offsets, 2000000, 600);
		expect(window.end - window.start).toBeLessThanOrEqual(32);
		expect(window.before + offsets[window.end]! - offsets[window.start]! + window.after).toBe(offsets.at(-1));
		expect(variableWindow(rowOffsets([30, 78, 30]), 2000000, 600)).toEqual({ start: 0, end: 3, before: 0, after: 0 });
	});
	it("keeps bounded colored thinking/text/tool previews and tool-result linkage", async () => {
		const { manager, store } = await setup();
		const message = fauxAssistantMessage("text");
		message.content = [
			{ type: "thinking", thinking: "x".repeat(100000) },
			{ type: "text", text: "answer" },
			fauxToolCall("read", { path: "/fixture/file.ts" }, { id: "read-1" }),
		];
		manager.appendMessage(message);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		});
		store.invalidate();
		const packet = store.packet();
		expect(packet.createdAt).toBe(manager.getHeader()?.timestamp);
		expect(JSON.stringify(packet).length).toBeLessThan(5000);
		expect(packet.entries[0]?.lines?.map((line) => line.className)).toEqual([
			"line-thinking",
			"line-assistant",
			"line-tool-call",
		]);
		expect(packet.entries[0]?.lines?.every((line) => line.text.length <= 160)).toBe(true);
		expect(packet.entries[0]?.toolCallIds).toEqual(["read-1"]);
		expect(packet.entries[1]?.toolCallId).toBe("read-1");
		expect(sessionLines(packet.entries[1]!, new Map([["read-1", "read: /fixture/file.ts"]]))[0]?.text).toContain(
			"read: /fixture/file.ts",
		);
	});
	it("reads the selected ancestry in order without pulling in another branch, including cycles", () => {
		const entries = [row("root", null), row("left", "root"), row("right", "root"), row("leaf", "right")];
		expect(branchPath(entries, "leaf").map((entry) => entry.id)).toEqual(["root", "right", "leaf"]);
		expect(branchPath([row("a", "b"), row("b", "a")], "a")).toHaveLength(2);
		expect(branchPath(entries, "missing")).toEqual([]);
	});
	it("retains labeled/no-tools filters and custom state in the default conversation filter", () => {
		const tool = { ...row("tool", null), role: "toolResult" };
		const custom = { ...row("custom", null), type: "custom", role: undefined };
		expect(entryMatches(tool, "no-tools")).toBe(false);
		expect(entryMatches(custom, "no-tools")).toBe(true);
		expect(entryMatches(custom, "default")).toBe(true);
		expect(entryMatches({ ...row("label", null), type: "label" }, "default")).toBe(false);
		expect(entryMatches({ ...row("labeled", null), label: "checkpoint" }, "labeled")).toBe(true);
		expect(entryMatches(row("plain", null), "labeled")).toBe(false);
	});
	it("searches native content beyond previews, custom state, and labels with bounded result pages", async () => {
		const { manager, store } = await setup();
		const message = manager.appendMessage({
			role: "user",
			content: `${"x".repeat(100000)} DeepSentinel`,
			timestamp: Date.now(),
		});
		const custom = manager.appendCustomEntry("fixture", { nested: { text: "DeepSentinel" } });
		manager.appendLabelChange(message, "deep-checkpoint");
		for (let i = 0; i < 280; i++)
			manager.appendMessage({ role: "user", content: `filler ${i}`, timestamp: Date.now() });
		store.invalidate();
		const matches: string[] = [];
		let cursor: number | null = 0;
		let pages = 0;
		do {
			const page = await store.search("entries", "deepsentinel", cursor);
			matches.push(...page.ids);
			cursor = page.next;
			pages++;
			expect(page.ids.length).toBeLessThanOrEqual(128);
		} while (cursor !== null);
		expect(pages).toBeGreaterThan(1);
		expect(matches).toEqual([message, custom]);
		expect((await store.search("entries", "deep-checkpoint")).ids).toContain(message);
	});
	it("searches captured context, provider payloads and stream bytes before/after persistence, across UTF-8 boundaries", async () => {
		const { store } = await setup();
		store.append({ type: "call_started", callId: "call", kind: "agent" });
		store.append({
			type: "generic_context",
			callId: "call",
			context: { messages: [{ content: `${"x".repeat(2000)} ContextNeedle` }] },
		});
		const value = store.append({ type: "provider_request", callId: "call", payload: { text: "" } });
		const offset = Buffer.byteLength(JSON.stringify(value).split('"text":""')[0]!) + Buffer.byteLength('"text":"');
		store.append({
			type: "provider_request",
			callId: "call",
			payload: { text: `${"x".repeat(65535 - offset)}跨边界Needle` },
		});
		store.append({ type: "output_event", callId: "call", event: { type: "text_delta", delta: "StreamNeedle" } });
		for (const query of ["contextneedle", "跨边界needle", "streamneedle"])
			expect((await store.search("calls", query)).ids).toEqual(["call"]);
		await store.journal.flush();
		for (const query of ["contextneedle", "跨边界needle", "streamneedle"])
			expect((await store.search("calls", query)).ids).toEqual(["call"]);
		const controller = new AbortController();
		controller.abort();
		await expect(store.search("calls", "absent", 0, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});
	it("reports unavailable journal bytes rather than claiming a complete negative search", async () => {
		const { store } = await setup();
		store.append({ type: "call_started", callId: "unavailable", kind: "agent" });
		store.append({ type: "provider_request", callId: "unavailable", payload: { text: "private detail" } });
		await store.journal.close();
		const result = await store.search("calls", "absent");
		expect(result.ids).toEqual([]);
		expect(result.unavailable).toBe(1);
	});
	it("retains API, turn and tool diagnostics without inventing historical turn indexes", async () => {
		const { store, manager } = await setup();
		const message = fauxAssistantMessage(fauxToolCall("read", { path: "/fixture/file.ts" }, { id: "read-1" }));
		store.append({
			type: "call_started",
			callId: "live",
			kind: "agent",
			model: { provider: "faux", id: "mock", api: "faux" },
			turnIndex: 0,
		});
		store.append({ type: "call_completed", callId: "live", message });
		manager.appendMessage(message);
		manager.appendMessage(fauxAssistantMessage("history"));
		store.invalidate();
		const packet = store.packet();
		expect(packet.calls.find((call) => call.id === "live")?.turnIndex).toBe(0);
		expect(packet.calls.find((call) => call.id === "live")?.api).toBe(message.api);
		expect(packet.calls.find((call) => call.id === "live")?.activity).toContain("/fixture/file.ts");
		expect(packet.calls.find((call) => call.source === "history")?.turnIndex).toBeUndefined();
		expect(packet.entries[0]?.toolCalls).toEqual(["read: /fixture/file.ts"]);
	});
});

describe("Trace lifecycle and timing", () => {
	it("retains the capture preference when an inactive session is rebound", async () => {
		const { store, manager, cwd } = await setup();
		await store.detach();
		expect(store.packet().capture).toBe(false);
		store.bind(source(manager, cwd));
		expect(store.packet().capture).toBe(true);
		store.capture = false;
		await store.detach();
		store.bind(source(manager, cwd));
		expect(store.packet().capture).toBe(false);
	});
	it("uses monotonic timings rather than inventing zero when the wall clock moves backward", async () => {
		const { store } = await setup();
		store.append({ type: "call_started", callId: "timed", kind: "agent", timestamp: "2026-10-11T11:00:00Z" });
		store.append({
			type: "output_event",
			callId: "timed",
			event: { type: "text_delta", delta: "a" },
			elapsedMs: 7.4,
			timestamp: "2026-10-11T10:59:59Z",
		});
		store.append({ type: "call_completed", callId: "timed", durationMs: 123, timestamp: "2026-10-11T10:59:59Z" });
		const call = store.packet().calls[0];
		expect(call?.firstOutputMs).toBe(7.4);
		expect(call?.durationMs).toBe(123);
	});
});

describe("Trace journal", () => {
	it("flushes asynchronously, preserves private permissions and reopens indexed details", async () => {
		const { cwd, store } = await setup();
		store.append({ type: "call_started", callId: "a", kind: "agent" });
		store.append({ type: "provider_request", callId: "a", payload: { text: "你好".repeat(30000) } });
		await store.journal.flush();
		expect((await stat(join(cwd, ".pi-traces"))).mode & 0o777).toBe(0o700);
		expect((await stat(store.journal.path)).mode & 0o777).toBe(0o600);
		await store.journal.close();
		const reopened = new Journal(cwd, store.id);
		journals.push(reopened);
		const kinds: string[] = [];
		await reopened.initialize((item) => kinds.push(item.type));
		expect(kinds).toContain("provider_request");
		expect((await reopened.read("a")).records).toHaveLength(2);
	});
	it("preserves an incomplete trailing line and separates new writes", async () => {
		const { cwd, store } = await setup();
		await store.journal.close();
		await writeFile(store.journal.path, '{"unfinished":');
		const reopened = new Journal(cwd, store.id);
		journals.push(reopened);
		await reopened.initialize(() => {});
		reopened.append({ type: "call_started", callId: "new", kind: "agent" });
		await reopened.flush();
		expect((await readFile(reopened.path, "utf8")).startsWith('{"unfinished":\n')).toBe(true);
		expect((await reopened.read("new")).records).toHaveLength(1);
	});
	it("refuses symlink files instead of overwriting their targets", async () => {
		const { cwd, store } = await setup();
		await store.journal.close();
		const target = join(cwd, "private.txt");
		await writeFile(target, "unchanged");
		await rm(store.journal.path);
		await symlink(target, store.journal.path);
		const journal = new Journal(cwd, store.id);
		journals.push(journal);
		await journal.initialize(() => {});
		expect(journal.state).toContain("Memory only");
		journal.append({ type: "call_started", callId: "safe" });
		await journal.flush();
		expect(await readFile(target, "utf8")).toBe("unchanged");
	});
	it("does not let an unserializable trace value break the agent", async () => {
		const { store } = await setup();
		const payload: { self?: unknown } = {};
		payload.self = payload;
		expect(() => store.append({ type: "provider_request", callId: "a", payload })).not.toThrow();
		expect(store.journal.state).toContain("serialized");
	});
});

describe("Analytics and viewport model", () => {
	it("uses branch membership and handles multiple roots without confusing all history with active context", () => {
		const entries = [row("root", null), row("a", "root"), row("b", "root"), row("other", null)];
		expect([...branchIds(entries, "b")]).toEqual(["b", "root"]);
		const view = scoped({ entries, calls: [call("a", "a"), call("b", "b")], tools: [], leafId: "b" }, "branch");
		expect(view.calls.map((item) => item.id)).toEqual(["b"]);
		expect(view.entries).toHaveLength(2);
		expect(flattenTree(entries).map((item) => item.entry.id)).toEqual(["root", "a", "b", "other"]);
	});
	it("includes failed calls and completed nested tools using their branch anchors", () => {
		const failed = { ...call("failed", "a"), entryId: undefined, anchorId: "a", status: "error" as const };
		const view = scoped(
			{
				entries: [row("a", null)],
				calls: [failed],
				tools: [
					{
						id: "nested",
						callId: "failed",
						name: "read",
						startedAt: "now",
						status: "success",
						durationMs: 10,
						version: 1,
					},
				],
				leafId: "a",
			},
			"branch",
		);
		expect(view.calls).toHaveLength(1);
		expect(view.tools).toHaveLength(1);
		expect(statistics(view).errors).toBe(1);
	});
	it("computes weighted cache reuse, median timings and real tool timing coverage", () => {
		const a = row("a", null),
			b = row("b", "a");
		a.usage = { input: 10, output: 20, cacheRead: 90, cacheWrite: 0, total: 120, cost: null };
		b.usage = { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, total: 920, cost: 0 };
		const stats = statistics({
			entries: [a, b],
			calls: [call("a", "a", 100), call("b", "b", 300), call("c", "b")],
			tools: [{ id: "tool", name: "read", startedAt: "now", durationMs: 12, status: "success", version: 1 }],
			leafId: "b",
		});
		expect(stats.cacheRatio).toBe(9);
		expect(stats.medianMs).toBe(200);
		expect(stats.timedCalls).toBe(2);
		expect(stats.tools[0]?.duration).toBe(12);
	});
	it("keeps unknown usage and timings unknown", () => {
		const stats = statistics({ entries: [row("a", null)], calls: [call("a", "a")], tools: [], leafId: "a" });
		expect(stats.cacheRatio).toBeNull();
		expect(stats.medianMs).toBeNull();
		expect(stats.recorded).toBe(0);
		expect(usage({ input: "100", output: 2, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
		expect(finite(1e308)).toBeUndefined();
		expect(finite(-1)).toBeUndefined();
	});
	it("bounds mounted rows even with 100,000 entries", () => {
		const result = virtualWindow(100000, 64000, 600);
		expect(result.end - result.start).toBeLessThanOrEqual(21);
		expect(result.before + (result.end - result.start) * 64 + result.after).toBe(6400000);
	});
	it("clamps a previous long-list scroll offset when changing to a shorter scope", () => {
		const window = virtualWindow(3, 64000, 600);
		expect(window.start).toBe(0);
		expect(window.end).toBe(3);
		expect(window.after).toBe(0);
	});
	it("preserves spikes and unknown gaps while downsampling", () => {
		const points = Array.from({ length: 5000 }, (_, index) => ({
			index,
			value: index === 2411 ? 10000 : index === 3200 ? null : 5,
		}));
		const sampled = sample(points);
		expect(sampled.length).toBeLessThan(550);
		expect(sampled.some((point) => point.value === 10000)).toBe(true);
		expect(sampled.some((point) => point.value === null)).toBe(true);
	});
	it("redacts credential fields without changing plain prompts or duplicated safe objects", () => {
		const shared = { text: "prompt" };
		expect(redact({ Authorization: "secret", list: [shared, shared], nested: { access_token: "secret" } })).toEqual({
			Authorization: "[REDACTED]",
			list: [shared, shared],
			nested: { access_token: "[REDACTED]" },
		});
	});
});

describe("Read-only loopback server", () => {
	it("serves compact updates and selected details but refuses foreign hosts/origins and writes", async () => {
		const { cwd, manager } = await setup();
		manager.appendMessage({ role: "user", content: "body".repeat(500000), timestamp: Date.now() });
		const server = new ViewerServer();
		servers.push(server);
		await server.listen(0);
		await server.attach(source(manager, cwd));
		const prefix = `/api/sessions/${manager.getSessionId()}`;
		const packet = await http(server.url, `${prefix}/updates`);
		expect(packet.status).toBe(200);
		expect(packet.text.length).toBeLessThan(4000);
		const parsed = JSON.parse(packet.text) as { entries: EntryRow[]; revision: number };
		expect((await http(server.url, `${prefix}/entries/${parsed.entries[0]!.id}`)).text.length).toBeGreaterThan(
			1000000,
		);
		expect((await http(server.url, `${prefix}/updates?after=-1`)).status).toBe(400);
		const search = await http(server.url, `${prefix}/search?scope=entries&q=body`);
		expect(search.status).toBe(200);
		expect((JSON.parse(search.text) as { ids: string[] }).ids).toContain(parsed.entries[0]!.id);
		expect(search.text.length).toBeLessThan(1000);
		for (const query of [
			"scope=unknown&q=body",
			"scope=entries&q=",
			`scope=calls&q=${"x".repeat(257)}`,
			"scope=entries&q=body&after=-1",
		])
			expect((await http(server.url, `${prefix}/search?${query}`)).status).toBe(400);
		expect((await http(server.url, `${prefix}/info`)).status).toBe(200);
		expect((await http(server.url, "/api/sessions", { Host: "evil.example" })).status).toBe(403);
		expect((await http(server.url, "/api/sessions", { Origin: "https://evil.example" })).status).toBe(403);
		expect((await http(server.url, "/api/sessions", {}, "POST")).status).toBe(405);
		expect((await http(server.url, "/../package.json")).status).toBe(404);
		for (const [path, script] of [
			["/", "/session-app.js"],
			["/?view=overview", "/app.js"],
			["/", "/session-app.js"],
			["/?mode=calls", "/app.js"],
			["/?call=fixture", "/app.js"],
			["/?view=session&entry=fixture", "/session-app.js"],
		]) {
			const page = (await http(server.url, path!)).text;
			expect(page).toContain(`src="${script}"`);
			expect(page).toContain('href="/session.css"');
			expect(page).toContain('class="topbar"');
			expect(page).toContain('class="mode-switch"');
			expect(page).toContain('class="session-picker"');
			expect(page).toContain('class="icon-btn refresh-button"');
			expect(page).toContain("LLM Calls");
			expect(page).toContain("Statistics");
			expect(page).not.toContain('class="rail"');
		}
		for (const path of [
			"/",
			"/session.html",
			"/session-app.js",
			"/session-renderer.js",
			"/session.css",
			"/app.js",
			"/model.js",
			"/charts.js",
			"/inspector.js",
			"/conversation.js",
			"/actions.js",
			"/styles.css",
			"/vendor/marked.js",
			"/vendor/highlight.js",
		])
			expect((await http(server.url, path)).status).toBe(200);
	});
});

describe("Extension with the faux-provider harness", () => {
	it("records compaction preparation, summary and usage without fabricating a provider payload", async () => {
		const { manager } = await setup();
		const harness = await createHarness({
			sessionManager: manager,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		harness.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		harness.setResponses([
			fauxAssistantMessage("Mock compaction summary"),
			fauxAssistantMessage("Mock turn-prefix summary"),
		]);
		await harness.session.compact();
		const viewer = await globals[KEY];
		const prefix = `/api/sessions/${harness.sessionManager.getSessionId()}`;
		const packet = JSON.parse((await http(viewer!.url, `${prefix}/updates`)).text) as { calls: CallRow[] };
		const summaries = packet.calls.filter((item) => item.kind === "compaction");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.usage).toBeDefined();
		const detail = JSON.parse((await http(viewer!.url, `${prefix}/calls/${summaries[0]!.id}`)).text) as {
			compaction?: unknown;
			requests: unknown[];
			final: { summary: string };
		};
		expect(detail.compaction).toBeDefined();
		expect(detail.requests).toEqual([]);
		expect(detail.final.summary).toContain("Mock");
	});
	it("records model calls, nested-ready tool timings and pause/resume without polluting native history", async () => {
		const notify = vi.fn();
		const { manager, cwd } = await setup();
		let loaded = await createTestExtensionsResult([extension], cwd);
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getExtensions = () => loaded;
		// Reload needs fresh extension APIs; the default fixture reuses its invalidated runtime.
		resourceLoader.reload = async () => {
			loaded = await createTestExtensionsResult([extension], cwd);
		};
		const harness = await createHarness({
			sessionManager: manager,
			resourceLoader,
			tools: [
				{
					name: "fixture",
					label: "Fixture",
					description: "Fixture tool",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "fixture result" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify }) });
		const viewer = await globals[KEY];
		expect(viewer).toBeDefined();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fixture", {}, { id: "tool-1" })),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Use fixture.");
		const prefix = `/api/sessions/${harness.sessionManager.getSessionId()}`;
		const response = await http(viewer!.url, `${prefix}/updates`);
		const packet = JSON.parse(response.text) as {
			calls: CallRow[];
			tools: Array<{ name: string; durationMs?: number }>;
		};
		expect(packet.calls.filter((item) => item.kind === "agent")).toHaveLength(2);
		expect(packet.calls.every((item) => item.status === "success")).toBe(true);
		expect(packet.calls.map((item) => item.turnIndex)).toEqual([0, 1]);
		expect(packet.calls.every((item) => Boolean(item.api))).toBe(true);
		expect(packet.tools[0]?.name).toBe("fixture");
		expect(packet.tools[0]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" || entry.type === "custom_message"),
		).toBe(false);
		await harness.session.prompt("/trace-view off");
		harness.setResponses([fauxAssistantMessage("paused")]);
		await harness.session.prompt("Paused prompt.");
		const paused = JSON.parse((await http(viewer!.url, `${prefix}/updates`)).text) as { calls: CallRow[] };
		expect(paused.calls.filter((item) => item.source === "live")).toHaveLength(2);
		expect(paused.calls.filter((item) => item.source === "history")).toHaveLength(1);
		await harness.session.prompt("/trace-view on");
		await harness.session.reload();
		harness.setResponses([fauxAssistantMessage("after reload")]);
		await harness.session.prompt("After reload.");
		const reloaded = JSON.parse((await http(viewer!.url, `${prefix}/updates`)).text) as {
			capture: boolean;
			calls: CallRow[];
		};
		expect(reloaded.capture).toBe(true);
		expect(reloaded.calls.filter((item) => item.source === "live")).toHaveLength(3);
		expect(notify).toHaveBeenCalled();
	});
});
