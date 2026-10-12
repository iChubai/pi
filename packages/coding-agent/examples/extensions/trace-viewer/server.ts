import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TraceStore } from "./store.ts";
import type { SessionSource } from "./types.ts";

const require = createRequire(import.meta.url);
const WEB = fileURLToPath(new URL("./web/", import.meta.url));
const SECURITY = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy":
		"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export class ViewerServer {
	url = "";
	private server: Server;
	private stores = new Map<string, TraceStore>();
	private clients = new Set<ServerResponse>();
	private notifications = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	private assets = new Map<string, Buffer>();

	constructor() {
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch(() => {
				if (!res.headersSent) this.json(res, 500, { error: "Trace detail unavailable. Check the local journal." });
				else res.end();
			});
		});
	}
	async listen(startPort = 7890): Promise<void> {
		for (let port = startPort; port <= 65535; port++) {
			try {
				await new Promise<void>((resolve, reject) => {
					const fail = (error: Error) => {
						this.server.off("listening", ready);
						reject(error);
					};
					const ready = () => {
						this.server.off("error", fail);
						resolve();
					};
					this.server.once("error", fail);
					this.server.once("listening", ready);
					this.server.listen(port, "127.0.0.1");
				});
				const address = this.server.address();
				if (!address || typeof address === "string") throw new Error("Invalid local listener");
				this.url = `http://127.0.0.1:${address.port}`;
				return;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
			}
		}
		throw new Error("No local viewer port available");
	}
	async attach(source: SessionSource): Promise<TraceStore> {
		const existing = this.stores.get(source.id);
		if (existing) {
			existing.bind(source);
			return existing;
		}
		const store = new TraceStore(source);
		await store.initialize();
		store.onChange(() => this.notify(source.id));
		this.stores.set(source.id, store);
		// Keep a bounded set of detached sessions; their files remain intact.
		if (this.stores.size > 8) {
			const stale = [...this.stores.values()].find((candidate) => !candidate.active);
			if (stale) {
				await stale.journal.close();
				this.stores.delete(stale.id);
			}
		}
		this.notify(source.id);
		return store;
	}
	private notify(id: string): void {
		this.notifications.add(id);
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const chunk = `event: changed\ndata: ${JSON.stringify({ ids: [...this.notifications] })}\n\n`;
			this.notifications.clear();
			for (const client of this.clients)
				if (!client.write(chunk)) {
					client.end();
					this.clients.delete(client);
				}
		}, 300);
		this.timer.unref();
	}
	private json(res: ServerResponse, status: number, value: unknown): void {
		res.writeHead(status, {
			...SECURITY,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(JSON.stringify(value));
	}
	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = new URL(this.url).host;
		// Loopback binding alone does not stop DNS rebinding or cross-site requests.
		if (
			req.headers.host !== host ||
			(req.headers.origin && req.headers.origin !== this.url) ||
			req.headers["sec-fetch-site"] === "cross-site"
		)
			return this.json(res, 403, { error: "Local same-origin access required" });
		if (req.method !== "GET") return this.json(res, 405, { error: "Read-only viewer" });
		const url = new URL(req.url ?? "/", this.url);
		if (url.pathname === "/api/events") {
			res.writeHead(200, {
				...SECURITY,
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write("event: ready\ndata: {}\n\n");
			this.clients.add(res);
			res.on("close", () => this.clients.delete(res));
			return;
		}
		if (url.pathname === "/api/sessions")
			return this.json(
				res,
				200,
				[...this.stores.values()].map((store) => store.metadata()),
			);
		const match = url.pathname.match(
			/^\/api\/sessions\/([^/]+)\/(updates|entries|calls|streams|search|info|download)(?:\/([^/]+))?$/,
		);
		if (match) {
			let id: string;
			try {
				id = decodeURIComponent(match[1]!);
			} catch {
				return this.json(res, 400, { error: "Invalid session ID" });
			}
			const store = this.stores.get(id);
			if (!store) return this.json(res, 404, { error: "Session not found" });
			const item = match[3] ? decodeURIComponent(match[3]) : undefined;
			const after = Number(url.searchParams.get("after") ?? 0);
			if (!Number.isSafeInteger(after) || after < 0) return this.json(res, 400, { error: "Invalid cursor" });
			if (match[2] === "updates") return this.json(res, 200, store.packet(after));
			if (match[2] === "info") return this.json(res, 200, store.info());
			if (match[2] === "search") {
				const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
				const scope = url.searchParams.get("scope");
				if (!query || query.length > 256 || (scope !== "entries" && scope !== "calls"))
					return this.json(res, 400, { error: "Use a 1–256 character query and entries/calls scope" });
				const controller = new AbortController();
				const cancel = () => controller.abort();
				res.once("close", cancel);
				try {
					const result = await store.search(scope, query, after, controller.signal);
					if (!res.destroyed) this.json(res, 200, result);
				} finally {
					res.off("close", cancel);
				}
				return;
			}
			if (match[2] === "entries" && item) {
				const entry = store.entry(item);
				return this.json(res, entry ? 200 : 404, entry ?? { error: "Entry not found" });
			}
			if (match[2] === "calls" && item) {
				const detail = await store.detail(item);
				return this.json(res, detail ? 200 : 404, detail ?? { error: "Call not found" });
			}
			if (match[2] === "streams" && item) return this.json(res, 200, await store.journal.read(item, true, after));
			if (match[2] === "download") {
				res.writeHead(200, {
					...SECURITY,
					"Content-Type": "application/x-ndjson; charset=utf-8",
					"Content-Disposition": 'attachment; filename="pi-session.jsonl"',
				});
				res.write(`${JSON.stringify(store.header())}\n`);
				for (const entry of store.entries()) {
					if (res.destroyed) break;
					if (!res.write(`${JSON.stringify(entry)}\n`))
						await new Promise<void>((resolve) => {
							const done = () => {
								res.off("drain", done);
								res.off("close", done);
								resolve();
							};
							res.once("drain", done);
							res.once("close", done);
						});
				}
				res.end();
				return;
			}
			return this.json(res, 404, { error: "Unknown resource" });
		}
		const studio =
			["overview", "calls"].includes(url.searchParams.get("view") ?? "") ||
			url.searchParams.get("mode") === "calls" ||
			url.searchParams.has("call");
		const staticFiles: Record<string, [string, string]> = {
			"/": [join(WEB, studio ? "index.html" : "session.html"), "text/html"],
			"/session.html": [join(WEB, "session.html"), "text/html"],
			"/session-app.js": [join(WEB, "session-app.js"), "text/javascript"],
			"/session-renderer.js": [join(WEB, "session-renderer.js"), "text/javascript"],
			"/session.css": [join(WEB, "session.css"), "text/css"],
			"/index.html": [join(WEB, "index.html"), "text/html"],
			"/app.js": [join(WEB, "app.js"), "text/javascript"],
			"/model.js": [join(WEB, "model.js"), "text/javascript"],
			"/charts.js": [join(WEB, "charts.js"), "text/javascript"],
			"/inspector.js": [join(WEB, "inspector.js"), "text/javascript"],
			"/conversation.js": [join(WEB, "conversation.js"), "text/javascript"],
			"/actions.js": [join(WEB, "actions.js"), "text/javascript"],
			"/styles.css": [join(WEB, "styles.css"), "text/css"],
			"/vendor/marked.js": [join(dirname(require.resolve("marked")), "marked.umd.js"), "text/javascript"],
			"/vendor/highlight.js": [require.resolve("@highlightjs/cdn-assets/highlight.min.js"), "text/javascript"],
		};
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		const asset = staticFiles[url.pathname];
		if (!asset) return this.json(res, 404, { error: "Not found" });
		let data = this.assets.get(asset[0]);
		if (!data) {
			data = await readFile(asset[0]);
			this.assets.set(asset[0], data);
		}
		res.writeHead(200, { ...SECURITY, "Content-Type": `${asset[1]}; charset=utf-8`, "Cache-Control": "no-cache" });
		res.end(data);
	}
	async close(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		for (const client of this.clients) client.end();
		this.clients.clear();
		await Promise.all([...this.stores.values()].map((store) => store.journal.close()));
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}
