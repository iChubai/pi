import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Collector } from "./collector.ts";
import { ViewerServer } from "./server.ts";
import type { TraceStore } from "./store.ts";
import type { SessionSource } from "./types.ts";

const KEY = Symbol.for("pi-trace-studio.server");
interface ViewerGlobal {
	[KEY]?: Promise<ViewerServer>;
}

function source(ctx: ExtensionContext, frozen = false, tools?: SessionSource["tools"]): SessionSource {
	const manager = ctx.sessionManager;
	const entries = frozen ? manager.getEntries() : undefined;
	const byId = entries ? new Map(entries.map((entry) => [entry.id, entry])) : undefined;
	const leaf = manager.getLeafId();
	const prompt = frozen ? ctx.getSystemPrompt() : undefined;
	const frozenTools = frozen ? tools?.() : undefined;
	return {
		id: manager.getSessionId(),
		cwd: manager.getCwd(),
		name: manager.getSessionName(),
		file: manager.getSessionFile(),
		header: manager.getHeader(),
		systemPrompt: () => prompt ?? ctx.getSystemPrompt(),
		tools: () => frozenTools ?? tools?.() ?? [],
		leafId: frozen ? () => leaf : () => manager.getLeafId(),
		entries: () => entries ?? manager.getEntries(),
		entry: (id) => (byId ? byId.get(id) : manager.getEntry(id)),
	};
}

export default function traceStudio(pi: ExtensionAPI): void {
	pi.registerFlag("pi-trace-port", {
		description: "Trace Studio starting loopback port",
		type: "string",
		default: "7890",
	});
	pi.registerFlag("no-pi-trace", {
		description: "Disable Trace Studio for this session",
		type: "boolean",
		default: false,
	});
	let server: ViewerServer | undefined;
	let store: TraceStore | undefined;
	let collector: Collector | undefined;
	let starting: Promise<void> | undefined;

	function activeTools() {
		const active = new Set(pi.getActiveTools());
		return pi.getAllTools().filter((tool) => active.has(tool.name));
	}
	async function start(ctx: ExtensionContext): Promise<void> {
		if (starting) return starting;
		starting = (async () => {
			const globals = globalThis as ViewerGlobal;
			const value = pi.getFlag("pi-trace-port");
			const parsed = typeof value === "string" ? Number(value) : 7890;
			const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 7890;
			globals[KEY] ??= (async () => {
				const viewer = new ViewerServer();
				await viewer.listen(port);
				return viewer;
			})().catch((error: unknown) => {
				delete globals[KEY];
				throw error;
			});
			server = await globals[KEY];
			store = await server.attach(source(ctx, false, activeTools));
			collector = new Collector(store, activeTools);
			ctx.ui.notify(`Trace Studio: ${server.url}/?session=${encodeURIComponent(store.id)}`, "info");
		})()
			.catch(() => {
				ctx.ui.notify("Trace Studio could not start. No trace data was uploaded.", "error");
			})
			.finally(() => {
				starting = undefined;
			});
		return starting;
	}
	async function stop(ctx: ExtensionContext): Promise<void> {
		collector?.interrupt();
		if (store) {
			store.bind(source(ctx, true, activeTools));
			await store.detach();
		}
		collector = undefined;
		store = undefined;
		const globals = globalThis as ViewerGlobal;
		if (globals[KEY]) {
			const viewer = await globals[KEY];
			delete globals[KEY];
			await viewer.close();
		}
		server = undefined;
	}
	pi.registerCommand("trace-view", {
		description: "Open Trace Studio · /trace-view [on|off|stop]",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action && !["on", "off", "stop", "status"].includes(action)) {
				ctx.ui.notify("Usage: /trace-view [on|off|stop]", "warning");
				return;
			}
			if (action === "stop") {
				await stop(ctx);
				ctx.ui.notify("Trace Studio stopped. /trace-view on restarts it.", "info");
				return;
			}
			if (action === "off" && store) {
				collector?.interrupt();
				store.capture = false;
				store.touch();
				ctx.ui.notify("Trace capture paused; existing data remains viewable.", "info");
				return;
			}
			if (action === "on") {
				if (!store) await start(ctx);
				else {
					store.capture = true;
					store.touch();
				}
			}
			if (!server || !store) {
				ctx.ui.notify("Trace Studio is stopped. Run /trace-view on.", "info");
				return;
			}
			ctx.ui.notify(
				`Trace Studio (${store.capture ? "capturing" : "paused"}): ${server.url}/?session=${encodeURIComponent(store.id)}`,
				"info",
			);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!pi.getFlag("no-pi-trace")) await start(ctx);
	});
	pi.on("turn_start", (event) => {
		if (store?.capture) collector?.startTurn(event.turnIndex);
	});
	pi.on("context", (event, ctx) => {
		if (store?.capture) collector?.context(event.messages, ctx);
	});
	pi.on("context_with_system", (event, ctx) => {
		if (store?.capture) collector?.context(event.messages, ctx, true);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (store?.capture) collector?.request(event.payload, ctx);
	});
	pi.on("after_provider_response", (event) => {
		if (store?.capture) collector?.response(event.status, event.headers);
	});
	pi.on("message_update", (event) => {
		if (store?.capture) collector?.update(event);
	});
	pi.on("message_end", (event) => {
		if (store?.capture) collector?.end(event);
		store?.invalidate();
	});
	pi.on("session_before_compact", (event, ctx) => {
		if (store?.capture) collector?.compact(event, ctx);
	});
	pi.on("session_compact", (event) => {
		collector?.completeSummary("compaction", event.compactionEntry.summary, event.compactionEntry.id);
		store?.invalidate();
	});
	pi.on("session_compact_failed", (event) => {
		if (event.aborted) collector?.interrupt();
		else collector?.fail(event.errorMessage ?? "Compaction failed");
		store?.invalidate();
	});
	pi.on("session_before_tree", () => {
		if (store?.capture) collector?.prepareBranch();
	});
	pi.on("session_tree", (event) => {
		if (event.summaryEntry)
			collector?.completeSummary("branch_summary", event.summaryEntry.summary, event.summaryEntry.id);
		else collector?.interrupt();
		store?.invalidate();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (store?.capture) collector?.toolStart(event, ctx);
	});
	pi.on("tool_execution_end", (event) => {
		if (store?.capture) collector?.toolEnd(event);
	});
	pi.on("model_select", () => store?.invalidate());
	pi.on("thinking_level_select", () => store?.invalidate());
	pi.on("session_info_changed", (_event, ctx) => {
		if (store) store.bind(source(ctx, false, activeTools));
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "quit") {
			await stop(ctx);
			return;
		}
		collector?.interrupt();
		if (store) {
			store.bind(source(ctx, true, activeTools));
			await store.detach();
		}
		collector = undefined;
		store = undefined;
		server = undefined;
	});
}
