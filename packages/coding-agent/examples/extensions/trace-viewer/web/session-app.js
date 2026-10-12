import { bindResizer } from "./actions.js";
import { Conversation } from "./conversation.js";
import {
	branchIds,
	escapeHtml as e,
	entryMatches,
	rowOffsets,
	sessionLines,
	sessionTree,
	statistics,
	variableWindow,
} from "./model.js";
import { SessionRenderer } from "./session-renderer.js";

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const state = {
	id: params.get("session"),
	selected: params.get("entry") || params.get("item") || params.get("branch"),
	follow: false,
	implicit: !(params.get("entry") || params.get("item") || params.get("branch")),
	revision: 0,
	generation: 0,
	entries: new Map(),
	calls: new Map(),
	tools: new Map(),
	meta: null,
	rows: [],
	offsets: [0],
	filter: "default",
	refreshing: false,
	pending: false,
	timer: null,
	source: null,
	search: { query: "", ids: new Set() },
	info: null,
};
let toastTimer, treeFrame;
function toast(value) {
	$("#toast").textContent = value;
	$("#toast").classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3000);
}
async function fetchJson(path, signal) {
	const response = await fetch(path, { signal: signal || AbortSignal.timeout(15000), cache: "no-store" });
	if (!response.ok) throw new Error(`Local trace request failed (HTTP ${response.status}).`);
	return response.json();
}
function resource(name) {
	return `/api/sessions/${encodeURIComponent(state.id)}/${name}`;
}
function navigate(view, item) {
	const url = new URL("/", location.origin);
	url.searchParams.set("view", view);
	if (state.id) url.searchParams.set("session", state.id);
	if (item) url.searchParams.set("item", item);
	location.assign(url);
}
const renderer = new SessionRenderer(document.createElement("div"), fetchJson, toast);
const reader = new Conversation($("#conversation"), renderer, fetchJson, toast, inspect, () => null, {
	documentViewport: true,
	initialFromStart: !(params.get("entry") || params.get("item") || params.get("branch")),
	shell: (row) => {
		const shell = renderer.shell(row);
		const call = [...state.calls.values()].find((call) => call.entryId === row.id);
		if (call) {
			const button = document.createElement("button");
			button.className = "text-button";
			button.textContent = "Context";
			button.addEventListener("click", () => navigate("calls", call.id));
			shell.node.querySelector(".entry-actions").prepend(button);
		}
		return shell;
	},
});
async function inspect(id) {
	const dialog = $("#entry-inspector"),
		body = dialog.querySelector(".entry-detail"),
		generation = state.generation;
	body.textContent = "Loading this entry…";
	if (!dialog.open) dialog.showModal();
	try {
		const entry = await reader.load(id, reader.generation);
		if (generation !== state.generation || !dialog.open) return;
		body.replaceChildren();
		renderer.json(body, "Original entry JSON", entry, true);
	} catch (error) {
		if (generation === state.generation && dialog.open && error.name !== "AbortError") body.textContent = error.message;
	}
}
$("[data-close-entry]").addEventListener("click", () => $("#entry-inspector").close());
$("#entry-inspector").addEventListener("close", () => $("#entry-inspector .entry-detail").replaceChildren());
function setLive(kind, label) {
	$("#live-status").className = `live-status ${kind}`;
	$("#live-status").innerHTML = `<span class="status-dot"></span>${e(label)}`;
}
function connect() {
	state.source?.close();
	if (document.hidden) return;
	state.source = new EventSource("/api/events");
	state.source.addEventListener("ready", schedule);
	state.source.addEventListener("changed", schedule);
	state.source.onerror = () => setLive("offline", "reconnecting");
}
function schedule() {
	state.pending = true;
	if (state.timer || state.refreshing || document.hidden) return;
	state.timer = setTimeout(() => {
		state.timer = null;
		refresh();
	}, 350);
}
function reset(id, preserveSelection = false) {
	state.generation++;
	state.id = id;
	state.revision = 0;
	state.meta = null;
	state.entries.clear();
	state.calls.clear();
	state.tools.clear();
	state.rows = [];
	state.offsets = [0];
	state.info = null;
	state.search.abort?.abort();
	clearTimeout(state.search.timer);
	state.search = { query: "", ids: new Set() };
	reader.clear();
	$("#entry-inspector").close();
	$("#image-viewer").close();
	$("#tree-container").replaceChildren();
	delete $("#tree-container").dataset.window;
	$("#header-container").replaceChildren();
	if (!preserveSelection) {
		state.selected = null;
		state.follow = false;
		state.implicit = true;
		reader.options.initialFromStart = true;
	}
}
async function refresh() {
	if (state.refreshing || document.hidden) {
		state.pending = true;
		return;
	}
	state.refreshing = true;
	state.pending = false;
	let generation = state.generation;
	try {
		const sessions = await fetchJson("/api/sessions");
		if (generation !== state.generation) return;
		if (!sessions.some((session) => session.id === state.id)) {
			reset(sessions.find((session) => session.active)?.id || sessions[0]?.id, !state.meta);
			generation = state.generation;
		}
		const signature = sessions.map((session) => `${session.id}:${session.name}:${session.active}`).join("|");
		if ($("#session-picker").dataset.signature !== signature) {
			$("#session-picker").dataset.signature = signature;
			$("#session-picker").innerHTML = sessions
				.map(
					(session) =>
						`<option value="${e(session.id)}">${e(session.name || session.id.slice(0, 8))}${session.active ? " · live" : ""}</option>`,
				)
				.join("");
		}
		$("#session-picker").value = state.id || "";
		$("#empty-state").hidden = Boolean(state.id);
		$("#session-view").hidden = !state.id;
		if (!state.id) return;
		const packet = await fetchJson(`${resource("updates")}?after=${state.revision}`);
		if (generation !== state.generation) return;
		if (packet.reset) {
			state.entries.clear();
			state.calls.clear();
			state.tools.clear();
		}
		for (const row of packet.entries) state.entries.set(row.id, row);
		for (const row of packet.calls) state.calls.set(row.id, row);
		for (const id of packet.removedCalls || []) state.calls.delete(id);
		for (const row of packet.tools) state.tools.set(row.id, row);
		state.meta = packet;
		state.revision = packet.revision;
		if (state.selected && !state.entries.has(state.selected)) {
			if (state.calls.has(state.selected)) {
				navigate("calls", state.selected);
				return;
			}
			state.selected = null;
			state.follow = true;
		}
		if (!state.selected && !state.follow) state.selected = packet.leafId;
		renderHeader();
		buildTree();
		renderTree();
		reader.setBranch(
			[...state.entries.values()],
			state.follow ? packet.leafId : state.selected || packet.leafId,
			resource("entries"),
		);
		$("#follow").setAttribute("aria-pressed", String(state.follow));
		if ($("#tree-search").value.trim() && !state.search.query) startSearch();
		setLive(packet.active ? "live" : "", packet.active ? (packet.capture ? "live" : "paused") : "historical");
		syncUrl();
	} catch (error) {
		if (generation === state.generation) {
			setLive("offline", "offline");
			toast(error.message);
		}
	} finally {
		state.refreshing = false;
		if (state.pending) schedule();
	}
}
function buildTree() {
	const entries = [...state.entries.values()],
		tools = new Map();
	for (const entry of entries)
		for (const [index, id] of (entry.toolCallIds || []).entries()) tools.set(id, entry.toolCalls[index]);
	const visible = entries.filter(
		(entry) => entryMatches(entry, state.filter) && (!state.search.query || state.search.ids.has(entry.id)),
	);
	state.rows = sessionTree(entries, visible).map((row) => {
		const lines = sessionLines(row.entry, tools);
		return { ...row, lines, height: Math.max(24, lines.length * 24 - 2) + 6 };
	});
	state.offsets = rowOffsets(state.rows.map((row) => row.height));
}
function renderTree() {
	const tree = $("#tree-container"),
		rows = state.rows,
		active = state.follow ? state.meta?.leafId : state.selected;
	const window = variableWindow(state.offsets, tree.scrollTop, tree.clientHeight || 600);
	const visible = rows.slice(window.start, window.end),
		branch = branchIds([...state.entries.values()], state.meta?.leafId);
	const key = `${window.start}:${window.end}:${rows.length}:${active}:${state.meta?.leafId}:${visible.map((row) => `${row.entry.id}:${row.entry.version}:${row.prefix}`).join("|")}`;
	if (tree.dataset.window !== key) {
		tree.dataset.window = key;
		tree.innerHTML = rows.length
			? `<div style="height:${window.before}px" aria-hidden="true"></div>${visible.map(({ entry, depth, prefix, lines, height }) => `<div class="tree-row${active === entry.id ? " active" : ""}${branch.has(entry.id) ? " on-branch" : ""}" style="height:${height}px" data-entry-id="${e(entry.id)}" role="treeitem" tabindex="-1" aria-level="${depth + 1}" aria-selected="${active === entry.id}"><span class="tree-prefix">${e(prefix)}</span><span class="tree-icon">${branch.has(entry.id) ? "•" : " "}</span><span class="tree-lines">${lines.map((line) => `<span class="tree-line ${e(line.className)}"><span class="tree-line-label">${e(line.label)}</span>${e(line.text)}</span>`).join("")}</span></div>`).join("")}<div style="height:${window.after}px" aria-hidden="true"></div>`
			: `<div class="unavailable">${state.search.running ? "Searching full content…" : "No matching entries"}</div>`;
	}
	$("#tree-status").textContent =
		`${rows.length} of ${state.entries.size} entries · leaf ${(active || "root").slice(0, 8)}${state.search.query ? ` · ${state.search.running ? "searching" : "full-content snapshot"} ${state.search.scanned || 0}/${state.search.total ?? "…"}${state.search.unavailable ? ` · ${state.search.unavailable} unavailable` : ""}${state.search.error ? ` · ${state.search.error}` : !state.search.running && state.search.revision !== state.revision ? " · search again for updates" : ""}` : ""}`;
}
function selectEntry(id) {
	if (!state.entries.has(id)) return;
	state.selected = id;
	state.follow = false;
	state.implicit = false;
	reader.end = reader.rows.length;
	reader.pinned = true;
	$("#follow").setAttribute("aria-pressed", "false");
	reader.setBranch([...state.entries.values()], id, resource("entries"));
	renderTree();
	syncUrl();
	toggleSidebar(false);
	if ($("#sidebar").inert) $("#content").focus({ preventScroll: true });
}
function syncUrl() {
	const url = new URL(location.href);
	if (state.id) url.searchParams.set("session", state.id);
	state.selected && !state.follow && !state.implicit
		? url.searchParams.set("entry", state.selected)
		: url.searchParams.delete("entry");
	for (const key of ["item", "branch", "view", "mode", "call"]) url.searchParams.delete(key);
	history.replaceState(null, "", url);
}
function renderHeader() {
	const container = $("#header-container"),
		entries = [...state.entries.values()],
		packet = state.meta;
	if (!container.firstElementChild) {
		container.innerHTML =
			'<header class="session-header"><div class="session-title-row"><h1 class="session-title"></h1><span class="session-badge"></span><div class="header-actions"><a class="small-btn" data-download>↓ JSONL</a></div></div><div class="info-grid"></div><div class="session-disclosures"></div></header>';
		const disclosures = container.querySelector(".session-disclosures");
		for (const [title, key] of [
			["System prompt", "systemPrompt"],
			["Tools", "tools"],
		])
			renderer.lazy(disclosures, title, async (body) => {
				const generation = state.generation;
				body.textContent = "Loading current session metadata…";
				try {
					state.info ??= fetchJson(resource("info"));
					const info = await state.info;
					if (generation !== state.generation || !body.isConnected) return;
					body.replaceChildren();
					renderer.note(body, "Current session metadata, not a reconstruction of a historical request.");
					if (key === "systemPrompt") renderer.rich(body, info.systemPrompt || "Not recorded");
					else renderer.plain(body, JSON.stringify(info.tools || [], null, 2));
				} catch (error) {
					if (generation === state.generation && body.isConnected) body.textContent = error.message;
				}
			});
	}
	container.querySelector(".session-title").textContent = packet.name || "Session Export";
	const badge = container.querySelector(".session-badge");
	badge.className = `session-badge${packet.active ? " active" : ""}`;
	badge.textContent = packet.active ? (packet.capture ? "LIVE" : "PAUSED") : "HISTORICAL";
	container.querySelector("[data-download]").href = resource("download");
	const stats = statistics({ entries, calls: [...state.calls.values()], tools: [...state.tools.values()] });
	const counts = (role) => entries.filter((entry) => entry.role === role).length,
		costKnown = entries.filter((entry) => entry.usage?.cost != null).length;
	const models = [...new Set(entries.flatMap((entry) => (entry.model ? [entry.model] : [])))];
	const facts = [
		["Session", state.id],
		["Created", packet.createdAt ? new Date(packet.createdAt).toLocaleString() : "unknown"],
		["Working directory", packet.cwd],
		["Messages", `${counts("user")} user · ${counts("assistant")} assistant · ${counts("toolResult")} tools`],
		["Tokens", stats.recorded ? (stats.input + stats.output).toLocaleString() : "unknown"],
		[
			"Cost",
			costKnown ? `$${stats.cost.toFixed(4)} estimated${costKnown < stats.recorded ? " (partial)" : ""}` : "unknown",
		],
		["Models", models.join(", ") || "unknown"],
		["Trace calls", state.calls.size],
		["Trace storage", packet.persistence],
	];
	const html = facts
		.map(
			([label, value]) =>
				`<div><span class="info-label">${label}:</span><span class="info-value">${e(value)}</span></div>`,
		)
		.join("");
	const grid = container.querySelector(".info-grid");
	if (grid.innerHTML !== html) grid.innerHTML = html;
}
function startSearch() {
	state.search.abort?.abort();
	clearTimeout(state.search.timer);
	const search = {
		query: $("#tree-search").value.trim().toLowerCase(),
		ids: new Set(),
		abort: new AbortController(),
		revision: state.revision,
		scanned: 0,
		unavailable: 0,
	};
	search.running = Boolean(search.query && state.id);
	state.search = search;
	buildTree();
	$("#tree-container").scrollTop = 0;
	renderTree();
	if (!search.running) return;
	const endpoint = resource("search"),
		generation = state.generation;
	search.timer = setTimeout(async () => {
		let cursor = 0;
		try {
			do {
				const page = await fetchJson(
					`${endpoint}?scope=entries&q=${encodeURIComponent(search.query)}&after=${cursor}`,
					AbortSignal.any([search.abort.signal, AbortSignal.timeout(15000)]),
				);
				if (generation !== state.generation || state.search !== search) return;
				for (const id of page.ids) search.ids.add(id);
				search.total = page.total;
				search.scanned = page.scanned;
				search.unavailable += page.unavailable;
				cursor = page.next;
				search.running = cursor !== null;
				buildTree();
				renderTree();
			} while (cursor !== null);
		} catch (error) {
			if (state.search === search && error.name !== "AbortError") {
				search.running = false;
				search.error = "Search incomplete";
				renderTree();
				toast(error.message);
			}
		}
	}, 300);
}
function toggleSidebar(open) {
	const mobile = matchMedia("(max-width: 850px)").matches;
	document.body.classList.toggle("sidebar-open", mobile && open);
	$("#sidebar-toggle").setAttribute("aria-expanded", String(mobile && open));
	$("#content").inert = $(".topbar").inert = mobile && open;
	$("#sidebar").inert = mobile && !open;
	$("#sidebar").setAttribute("role", mobile && open ? "dialog" : "complementary");
	if (mobile && open) $("#sidebar").setAttribute("aria-modal", "true");
	else $("#sidebar").removeAttribute("aria-modal");
	if (mobile && open) $("#tree-search").focus();
}
for (const button of document.querySelectorAll("[data-view]"))
	button.addEventListener("click", () => navigate(button.dataset.view));
for (const button of document.querySelectorAll("[data-filter]"))
	button.addEventListener("click", () => {
		state.filter = button.dataset.filter;
		for (const item of document.querySelectorAll("[data-filter]")) {
			item.classList.toggle("active", item === button);
			item.setAttribute("aria-pressed", String(item === button));
		}
		buildTree();
		$("#tree-container").scrollTop = 0;
		renderTree();
	});
$("#tree-container").addEventListener("click", (event) => {
	const row = event.target.closest("[data-entry-id]");
	if (row) selectEntry(row.dataset.entryId);
});
$("#tree-container").addEventListener(
	"scroll",
	() => {
		if (!treeFrame)
			treeFrame = requestAnimationFrame(() => {
				treeFrame = null;
				renderTree();
			});
	},
	{ passive: true },
);
$("#tree-container").addEventListener("keydown", (event) => {
	if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) return;
	event.preventDefault();
	const active = state.follow ? state.meta?.leafId : state.selected;
	const current = state.rows.findIndex((row) => row.entry.id === active);
	const index =
		event.key === "Home"
			? 0
			: event.key === "End"
				? state.rows.length - 1
				: ["Enter", " "].includes(event.key)
					? Math.max(0, current)
					: Math.max(0, Math.min(state.rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
	const row = state.rows[index];
	if (!row) return;
	$("#tree-container").scrollTop = Math.max(0, state.offsets[index] - $("#tree-container").clientHeight / 2);
	selectEntry(row.entry.id);
	$("#sidebar").inert
		? $("#content").focus({ preventScroll: true })
		: $("#tree-container").focus({ preventScroll: true });
});
$("#session-picker").addEventListener("change", () => {
	reset($("#session-picker").value);
	schedule();
});
$("#tree-search").addEventListener("input", startSearch);
$("#search-again").addEventListener("click", startSearch);
$("#follow").addEventListener("click", () => {
	state.follow = !state.follow;
	state.implicit = state.follow;
	state.selected = state.follow ? null : state.meta?.leafId;
	reader.end = reader.rows.length;
	reader.pinned = true;
	$("#follow").setAttribute("aria-pressed", String(state.follow));
	reader.setBranch([...state.entries.values()], state.selected || state.meta?.leafId, resource("entries"));
	renderTree();
	syncUrl();
});
$("#refresh-btn").addEventListener("click", () => {
	if (state.search.query) startSearch();
	schedule();
});
$("#sidebar-toggle").addEventListener("click", () => toggleSidebar(true));
$("#sidebar-overlay").addEventListener("click", () => {
	toggleSidebar(false);
	$("#sidebar-toggle").focus();
});
$("#sidebar-close").addEventListener("click", () => {
	toggleSidebar(false);
	$("#sidebar-toggle").focus();
});
document.addEventListener("keydown", (event) => {
	if ($("#image-viewer").open || $("#entry-inspector").open) return;
	if (event.key === "Escape") {
		toggleSidebar(false);
		$("#sidebar-toggle").focus({ preventScroll: true });
	}
	if (event.key === "Tab" && document.body.classList.contains("sidebar-open")) {
		const elements = [...$("#sidebar").querySelectorAll("button, input, [tabindex='0']")].filter(
			(node) => !node.disabled && node.getClientRects().length,
		);
		const first = elements[0],
			last = elements.at(-1);
		if (document.activeElement === (event.shiftKey ? first : last)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
		}
	}
});
bindResizer($("#sidebar-resizer"), "--sidebar-width", 400, 240, 840);
$("#theme").addEventListener("click", () => {
	const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem("pi-trace-theme", theme);
	} catch {}
});
try {
	const theme = localStorage.getItem("pi-trace-theme");
	if (["dark", "light"].includes(theme)) document.documentElement.dataset.theme = theme;
} catch {}
window.addEventListener("resize", () => {
	toggleSidebar(document.body.classList.contains("sidebar-open"));
	renderTree();
});
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		state.source?.close();
		clearTimeout(state.timer);
		state.timer = null;
	} else {
		connect();
		schedule();
	}
});
if (["overview", "calls"].includes(params.get("view"))) navigate(params.get("view"), params.get("item"));
else {
	toggleSidebar(false);
	globalThis.marked?.setOptions({ gfm: true, breaks: false });
	connect();
	refresh();
}
