import { bindResizer } from "./actions.js";
import { chart } from "./charts.js";
import { Conversation } from "./conversation.js";
import { Inspector } from "./inspector.js";
import {
	branchIds,
	bytes,
	clock,
	escapeHtml as e,
	entryMatches,
	flattenTree,
	number,
	scoped,
	shortModel,
	statistics,
	time,
	virtualWindow,
} from "./model.js";

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
let pendingItem = params.get("item") || params.get("call") || params.get("entry");
let inspectorTrigger;
const state = {
	id: params.get("session"),
	revision: 0,
	entries: new Map(),
	calls: new Map(),
	tools: new Map(),
	meta: null,
	sessions: [],
	scope: "branch",
	view: "overview",
	follow: true,
	selected: null,
	branchId: params.get("branch") || params.get("entry"),
	callNumbers: new Map(),
	entryCalls: new Map(),
	search: { entries: { query: "", ids: new Set() }, calls: { query: "", ids: new Set() } },
	entryRows: [],
	callRows: [],
	generation: 0,
	pending: false,
	refreshing: false,
	eventSource: null,
	timer: null,
	overviewKey: "",
	packetBytes: 0,
};
let toastTimer;
function toast(message) {
	$("#toast").textContent = message;
	$("#toast").hidden = false;
	$("#toast").classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		$("#toast").classList.remove("show");
		$("#toast").hidden = true;
	}, 4000);
}
async function fetchJson(path, signal) {
	const response = await fetch(path, { signal: signal || AbortSignal.timeout(15000), cache: "no-store" });
	if (!response.ok) throw new Error(`Local trace request failed (HTTP ${response.status}).`);
	return response.json();
}
const inspector = new Inspector($("#inspector"), fetchJson, toast);
const conversation = new Conversation($("#conversation"), inspector, fetchJson, toast, inspectEntry, (id) =>
	state.entryCalls.get(id),
);
function renderConversation() {
	if (state.view !== "session" || !state.meta) return;
	const id = state.follow ? state.meta.leafId : state.branchId || state.meta.leafId;
	conversation.setBranch([...state.entries.values()], id, path("entries"));
}
function data() {
	return {
		entries: [...state.entries.values()],
		calls: [...state.calls.values()],
		tools: [...state.tools.values()],
		leafId: state.meta?.leafId,
	};
}
function sortedCalls(value) {
	return value.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}
function path(resource, id) {
	return `/api/sessions/${encodeURIComponent(state.id)}/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
}
function openCall(id) {
	const row = state.calls.get(id);
	if (!row) return;
	state.selected = id;
	document.body.classList.add("inspecting");
	if (!inspector.selection) inspectorTrigger = document.activeElement;
	inspector.open({ id, row: { ...row, number: state.callNumbers.get(id) }, type: "call", path: path("calls", id) });
	inspectorLayout(true);
	syncUrl();
	renderLists();
}
function openEntry(id) {
	if (!state.entries.has(id)) return;
	state.branchId = id;
	state.selected = id;
	state.follow = false;
	$("#follow").setAttribute("aria-pressed", "false");
	if (state.view !== "session") setView("session");
	const index = state.entryRows.findIndex(({ entry }) => entry.id === id);
	const list = $("#entry-list");
	if (index >= 0 && (index * 64 < list.scrollTop || index * 64 >= list.scrollTop + list.clientHeight))
		list.scrollTop = Math.max(0, index * 64 - (list.clientHeight || 500) / 2);
	renderConversation();
	syncUrl();
	renderLists();
	if (matchMedia("(max-width: 760px)").matches) {
		$("#session").classList.remove("show-tree");
		$("#toggle-tree").setAttribute("aria-expanded", "false");
		requestAnimationFrame(() => {
			if (state.branchId === id && state.view === "session") $("#conversation").scrollIntoView({ block: "start" });
		});
	}
}
function inspectEntry(id) {
	const row = state.entries.get(id);
	if (!row) return;
	state.selected = id;
	document.body.classList.add("inspecting");
	if (!inspector.selection) inspectorTrigger = document.activeElement;
	inspector.open({ id, row, type: "entry", path: path("entries", id) });
	inspectorLayout(true);
	syncUrl();
	renderLists();
}
function inspectorLayout(focus = false) {
	const modal = !$("#inspector").hidden && matchMedia("(max-width: 760px)").matches;
	$("#workspace").inert = modal;
	$(".topbar").inert = modal;
	$("#inspector").setAttribute("role", modal ? "dialog" : "complementary");
	$("#inspector").setAttribute("aria-modal", String(modal));
	if (modal && focus) $("#close-inspector").focus({ preventScroll: true });
}
function closeInspector() {
	inspector.close();
	state.selected = state.view === "session" && !state.follow ? state.branchId : null;
	document.body.classList.remove("inspecting");
	inspectorLayout();
	syncUrl();
	renderOverview(true);
	renderLists();
	const target =
		inspectorTrigger?.isConnected && inspectorTrigger !== document.body
			? inspectorTrigger
			: $(state.view === "session" ? ".conversation-list" : state.view === "calls" ? "#call-list" : "#workspace");
	target.focus({ preventScroll: true });
}

function connect() {
	state.eventSource?.close();
	if (document.hidden) return;
	const source = new EventSource("/api/events");
	state.eventSource = source;
	source.addEventListener("ready", () => {
		connection("live", "live");
		schedule();
	});
	source.addEventListener("changed", () => schedule());
	source.onerror = () => connection("error", "reconnecting");
}
function connection(kind, text) {
	$("#connection").className = `live-status ${kind === "error" ? "offline" : kind}`;
	$("#connection").innerHTML = `<span class="status-dot"></span>${e(text)}`;
	$("#connection").title = text;
}
function schedule() {
	state.pending = true;
	if (document.hidden || state.timer || state.refreshing) return;
	state.timer = setTimeout(() => {
		state.timer = null;
		refresh();
	}, 350);
}
async function refresh() {
	if (state.refreshing || document.hidden) {
		state.pending = true;
		return;
	}
	state.refreshing = true;
	state.pending = false;
	const generation = state.generation;
	try {
		const sessions = await fetchJson("/api/sessions");
		if (generation !== state.generation) return;
		state.sessions = sessions;
		if (!state.id || !sessions.some((session) => session.id === state.id)) {
			state.id = sessions.find((session) => session.active)?.id || sessions[0]?.id;
			state.revision = 0;
			state.meta = null;
			state.entries.clear();
			state.calls.clear();
			state.tools.clear();
			state.overviewKey = "";
			state.branchId = null;
			conversation.clear();
			resetSearch();
			$("#session-info-body").replaceChildren();
			delete $("#session-info-body").dataset.session;
			inspector.close();
			state.selected = null;
			document.body.classList.remove("inspecting");
			inspectorLayout();
		}
		renderSessionPicker();
		if (!state.id) {
			$("#notice").hidden = false;
			$("#notice").textContent = "No session attached. Start pi with this extension and run /trace-view.";
			return;
		}
		const response = await fetch(`${path("updates")}?after=${state.revision}`, {
			signal: AbortSignal.timeout(15000),
			cache: "no-store",
		});
		if (!response.ok) throw new Error(`Local update failed (HTTP ${response.status}).`);
		const raw = await response.text();
		if (generation !== state.generation) return;
		const packet = JSON.parse(raw);
		state.packetBytes = new TextEncoder().encode(raw).length;
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
		state.callNumbers = new Map(sortedCalls([...state.calls.values()]).map((call, index) => [call.id, index + 1]));
		state.entryCalls = new Map(
			[...state.calls.values()].filter((call) => call.entryId).map((call) => [call.entryId, call.id]),
		);
		if (state.branchId && !state.entries.has(state.branchId)) state.branchId = null;
		if (state.branchId) {
			state.follow = false;
			$("#follow").setAttribute("aria-pressed", "false");
		}
		$("#capture-status").textContent = packet.active
			? packet.capture
				? "Capturing"
				: "Capture paused"
			: "Detached session";
		$("#data-status").textContent =
			`${number(state.entries.size)} entries · ${number(state.calls.size)} calls · ${bytes(state.packetBytes)} last update · ${packet.persistence}`;
		$("#download").href = path("download");
		$("#notice").hidden = packet.persistence === "Persisted locally";
		if (!$("#notice").hidden) $("#notice").textContent = packet.persistence;
		renderOverview();
		buildLists();
		renderLists();
		renderConversation();
		renderSessionSummary();
		if ($("#session-info").open) loadSessionInfo();
		for (const scope of ["entries", "calls"]) {
			const input = $(scope === "entries" ? "#entry-search" : "#call-search");
			if (input.value.trim() && !state.search[scope].query) startSearch(scope);
		}
		if (pendingItem) {
			const id = pendingItem;
			pendingItem = null;
			if (state.calls.has(id)) openCall(id);
			else if (state.entries.has(id)) openEntry(id);
		}
		syncUrl();
		if (inspector.selection?.type === "call") {
			const row = state.calls.get(inspector.selection.id);
			if (row) {
				inspector.update({ ...row, number: state.callNumbers.get(row.id) });
			}
		}
		connection(packet.active ? "live" : "", packet.active ? (packet.capture ? "live" : "paused") : "historical");
	} catch (error) {
		connection("error", "offline");
		toast(error.message);
	} finally {
		state.refreshing = false;
		if (state.pending) schedule();
	}
}
function renderSessionPicker() {
	const picker = $("#sessions");
	const signature = state.sessions.map((session) => `${session.id}:${session.name}:${session.active}`).join("|");
	if (picker.dataset.signature !== signature) {
		picker.dataset.signature = signature;
		picker.innerHTML = state.sessions
			.map(
				(session) =>
					`<option value="${e(session.id)}">${e(session.name || session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || session.id.slice(0, 8))}${session.active ? " · live" : ""}</option>`,
			)
			.join("");
	}
	picker.value = state.id || "";
	$("#session-path").textContent = state.sessions.find((session) => session.id === state.id)?.cwd || "";
	$("#session-path").title = $("#session-path").textContent;
}
function setView(view) {
	if (view === "session") {
		const url = new URL("/session.html", location.origin);
		if (state.id) url.searchParams.set("session", state.id);
		const entry =
			state.branchId ||
			state.calls.get(state.selected)?.entryId ||
			(state.entries.has(state.selected) ? state.selected : params.get("entry")) ||
			(!state.meta ? params.get("item") : null);
		if (entry) url.searchParams.set("entry", entry);
		location.assign(url);
		return;
	}
	state.view = ["overview", "session", "calls"].includes(view) ? view : "overview";
	for (const name of ["overview", "session", "calls"]) $(`#${name}`).hidden = name !== state.view;
	for (const button of document.querySelectorAll("[data-view]")) {
		button.classList.toggle("active", button.dataset.view === state.view);
		button.dataset.view === state.view
			? button.setAttribute("aria-current", "page")
			: button.removeAttribute("aria-current");
	}
	const titles = {
		overview: ["Statistics", "Recorded usage, context, calls and tools — without loading every payload."],
		session: [
			"Session tree",
			"Persisted history is not model context. Compacted and edited entries remain inspectable.",
		],
		calls: ["LLM Calls", "A compact call index. Full inputs, payloads and streams load only when you ask."],
	};
	$("#page-title").textContent = titles[state.view][0];
	$("#page-description").textContent = titles[state.view][1];
	$("#breadcrumb-view").textContent = titles[state.view][0];
	if (state.view === "overview") renderOverview(true);
	else {
		buildLists();
		renderLists();
		renderConversation();
	}
	syncUrl();
}
function renderOverview(force = false) {
	if (state.view !== "overview" || !state.meta) return;
	const selected = scoped(data(), state.scope),
		calls = sortedCalls(selected.calls);
	const key = `${state.scope}:${selected.entries.length}:${selected.tools.map((tool) => `${tool.id}:${tool.status}:${tool.durationMs}`).join("|")}:${calls.map((call) => `${call.id}:${call.status}:${call.payloadBytes}:${call.durationMs}:${call.attempts}`).join("|")}`;
	if (!force && key === state.overviewKey) return;
	state.overviewKey = key;
	const stats = statistics(selected);
	$("#metrics").innerHTML = [
		[
			"Recorded input",
			stats.recorded ? number(stats.input) : "—",
			stats.recorded
				? `${number(stats.output)} output tokens · all recorded model work`
				: "No usage recorded in this scope",
			"TOKENS",
		],
		[
			"Cache reuse",
			stats.cacheRatio === null ? "—" : `${stats.cacheRatio.toFixed(1)}%`,
			stats.recorded ? `${number(stats.cache)} cached-read tokens / total input` : "No usage recorded in this scope",
			"WEIGHTED",
		],
		[
			"Median call time",
			time(stats.medianMs),
			`${stats.timedCalls} / ${stats.calls} calls with captured timings`,
			"CLIENT",
		],
		[
			"Errors / extra requests",
			`${stats.errors} / ${stats.retries}`,
			`${stats.calls} calls in ${state.scope === "all" ? "entire history" : "the current branch"}`,
			"HEALTH",
		],
	]
		.map(
			([label, value, detail, badge]) =>
				`<div class="metric"><div class="metric-label">${e(label)}<span>${badge}</span></div><strong>${e(value)}</strong><small>${e(detail)}</small></div>`,
		)
		.join("");
	const agents = calls.filter((call) => call.kind === "agent");
	const points = (get) =>
		agents.map((call, index) => ({
			index,
			id: call.id,
			at: call.startedAt,
			value: get(call),
			label: `${shortModel(call.model)} · ${call.source === "history" ? "historical" : "captured"}`,
		}));
	const markers = selected.entries.filter((entry) => entry.type === "compaction");
	chart($("#context-chart"), {
		title: "Input context over calls",
		subtitle: "Recorded input, including cache read/write. This is not cumulative session usage.",
		points: points((call) => (call.usage ? call.usage.input + call.usage.cacheRead + call.usage.cacheWrite : null)),
		format: number,
		markers,
		onSelect: openCall,
	});
	chart($("#latency-chart"), {
		title: "Call latency",
		subtitle: "Context capture → completed response. Unknown historical timings are gaps.",
		points: points((call) => call.durationMs ?? null),
		format: time,
		color: "blue",
		onSelect: openCall,
	});
	chart($("#payload-chart"), {
		title: "Request payload size",
		subtitle: "Captured JSON bytes, not HTTP wire size. Last attempt per call.",
		points: points((call) => call.payloadBytes ?? null),
		format: bytes,
		color: "amber",
		onSelect: openCall,
	});
	chart($("#cache-chart"), {
		title: "Cache reuse per call",
		subtitle: "Cache-read tokens / (input + cache read + cache write).",
		points: points((call) => {
			const u = call.usage,
				total = u ? u.input + u.cacheRead + u.cacheWrite : 0;
			return total > 0 ? (u.cacheRead / total) * 100 : null;
		}),
		format: (value) => (value == null ? "—" : `${value.toFixed(0)}%`),
		color: "blue",
		onSelect: openCall,
	});
	chart($("#retry-chart"), {
		title: "Additional provider requests",
		subtitle: "Exposed payloads after the first within a call. Hidden retry layers remain unknown.",
		points: points((call) => (call.attempts ? Math.max(0, call.attempts - 1) : null)),
		format: number,
		color: "red",
		onSelect: openCall,
	});
	$("#tool-count").textContent = `${selected.tools.length} executions`;
	$("#tool-table").innerHTML = stats.tools.length
		? `<table><thead><tr><th>TOOL</th><th>CALLS</th><th>MEAN TIME</th><th>ERRORS</th></tr></thead><tbody>${stats.tools.map((tool) => `<tr><td class="tool-name">${e(tool.name)}</td><td>${tool.count}</td><td title="${tool.timed} / ${tool.count} executions timed">${e(tool.timed ? time(tool.duration / tool.timed) : "Not captured")}</td><td>${tool.errors || "—"}</td></tr>`).join("")}</tbody></table>`
		: '<div class="empty-list">No tool executions in this scope.</div>';
	$("#recent-calls").innerHTML =
		calls
			.slice(-5)
			.reverse()
			.map(
				(call) =>
					`<button class="recent-row" data-call="${e(call.id)}"><span><b>${e(call.preview || call.kind)}</b><small>${e(shortModel(call.model))} · ${e(call.status)} · ${e(clock(call.startedAt))}</small></span><span>${e(time(call.durationMs))}</span></button>`,
			)
			.join("") || '<div class="empty-list">No model calls recorded yet.</div>';
}
function buildLists() {
	if (state.view === "overview") return;
	const value = data(),
		ids = branchIds(value.entries, value.leafId);
	const entryQuery = $("#entry-search").value.trim().toLowerCase(),
		entryFilter = $("#entry-filter").value;
	state.entryRows = flattenTree(value.entries)
		.filter(({ entry }) => entryMatches(entry, entryFilter) && (!entryQuery || state.search.entries.ids.has(entry.id)))
		.map((row) => ({ ...row, active: ids.has(row.entry.id) }));
	const callQuery = $("#call-search").value.trim().toLowerCase(),
		filter = $("#call-filter").value;
	state.callRows = sortedCalls(scoped(value, state.scope).calls)
		.reverse()
		.filter((call) => {
			if (filter === "agent" && call.kind !== "agent") return false;
			if (filter === "summary" && !["compaction", "branch_summary"].includes(call.kind)) return false;
			if (filter === "error" && call.status !== "error") return false;
			if (filter === "captured" && call.source !== "live") return false;
			return !callQuery || state.search.calls.ids.has(call.id);
		});
	if (state.follow && state.view === "session") {
		const index = state.entryRows.findIndex(({ entry }) => entry.id === value.leafId);
		if (index >= 0) $("#entry-list").scrollTop = Math.max(0, index * 64 - $("#entry-list").clientHeight + 64);
	}
}
function renderLists() {
	if (state.view === "session")
		renderVirtual(
			$("#entry-list"),
			state.entryRows,
			({ entry, depth, active }) =>
				`<button class="virtual-row ${(state.follow ? state.meta?.leafId : state.branchId) === entry.id ? "selected" : ""} ${entry.isError ? "row-error" : ""}" data-entry="${e(entry.id)}" aria-label="${e(`${entry.role || entry.type}: ${entry.preview}`)}"><span class="row-text" style="padding-left:${Math.min(6, depth) * 14}px"><span class="row-title">${e(depth ? "↳ " : "")}${e(entry.preview || entry.type)}</span><span class="row-sub"><span class="row-kind">${e(entry.role === "toolResult" ? entry.tool || "tool result" : entry.role || entry.type)}</span>${entry.id === state.meta?.leafId ? "<span>ACTIVE LEAF</span>" : active ? "<span>active branch</span>" : "<span>other branch</span>"}${entry.label ? `<span>${e(entry.label)}</span>` : ""}</span>${entry.toolCalls?.length ? `<span class="row-activity" title="${e(entry.toolCalls.join(" · "))}">${e(entry.toolCalls.join(" · "))}</span>` : ""}</span><span class="row-value">${e(entry.usage ? `${number(entry.usage.total)} tok` : entry.tokensBefore ? `${number(entry.tokensBefore)} before` : "—")}</span><span class="row-time">${e(clock(entry.timestamp))}</span></button>`,
		);
	if (state.view === "calls")
		renderVirtual(
			$("#call-list"),
			state.callRows,
			(call) =>
				`<button class="virtual-row ${state.selected === call.id ? "selected" : ""} ${call.status === "error" ? "row-error" : ""}" data-call="${e(call.id)}"><span class="row-text"><span class="row-title">#${state.callNumbers.get(call.id)} · ${e(call.preview || call.kind)}</span><span class="row-sub"><span class="row-kind">${e(call.status)}</span><span>${e(shortModel(call.model))}</span><span>${e(call.source === "history" ? "history · timing unknown" : call.kind)}</span><span>${e(call.api || "API unknown")}</span><span>turn ${call.turnIndex == null ? "?" : call.turnIndex + 1}</span><span>${call.attempts} requests</span></span>${call.activity ? `<span class="row-activity">${e(call.activity)}</span>` : ""}</span><span class="row-value">${e(call.usage ? `${number(call.usage.input + call.usage.cacheRead + call.usage.cacheWrite)} / ${number(call.usage.output)}` : "—")}</span><span class="row-time">${e(time(call.durationMs))}</span></button>`,
		);
	$("#entry-status").textContent =
		`${state.entryRows.length} / ${state.entries.size} entries · ${searchStatus("entries") || "browse without changing pi's branch"}`;
	$("#call-status").textContent =
		`${state.callRows.length} calls · ${searchStatus("calls") || "payloads and streams load on demand"}`;
}
function renderVirtual(container, rows, renderer) {
	if (!rows.length) {
		delete container.dataset.window;
		container.innerHTML = `<div class="empty-list">${state.search[container.id === "entry-list" ? "entries" : "calls"].running ? "Searching full content…" : "No matches in this view."}</div>`;
		return;
	}
	const window = virtualWindow(rows.length, container.scrollTop, container.clientHeight || 500);
	const visible = rows.slice(window.start, window.end);
	const key = `${window.start}:${window.end}:${state.selected}:${state.branchId}:${state.follow}:${rows.length}:${state.meta?.leafId}:${visible.map((row) => (row.entry ? `${row.entry.id}:${row.entry.version}` : `${row.id}:${row.status}:${row.durationMs}:${row.preview}:${row.model}:${row.usage?.total}:${row.api}:${row.turnIndex}:${row.activity}:${row.attempts}`)).join("|")}`;
	if (container.dataset.window === key) return;
	container.dataset.window = key;
	container.innerHTML = `<div style="height:${window.before}px" aria-hidden="true"></div>${visible.map(renderer).join("")}<div style="height:${window.after}px" aria-hidden="true"></div>`;
}
function syncUrl() {
	const url = new URL(location.href);
	if (state.id) url.searchParams.set("session", state.id);
	url.searchParams.set("view", state.view);
	state.selected ? url.searchParams.set("item", state.selected) : url.searchParams.delete("item");
	state.branchId && state.view === "session"
		? url.searchParams.set("branch", state.branchId)
		: url.searchParams.delete("branch");
	for (const key of ["entry", "call", "mode"]) url.searchParams.delete(key);
	history.replaceState(null, "", url);
}

function resetSearch() {
	for (const scope of ["entries", "calls"]) {
		state.search[scope].abort?.abort();
		clearTimeout(state.search[scope].timer);
		state.search[scope] = { query: "", ids: new Set() };
	}
}
function searchStatus(scope) {
	const search = state.search[scope];
	if (!search.query) return "";
	if (search.error) return search.error;
	return `${search.running ? "Searching full content" : "Full-content snapshot"} · ${search.scanned || 0} / ${search.total ?? "…"} scanned${search.unavailable ? ` · ${search.unavailable} unavailable` : ""}${!search.running && search.revision !== state.revision ? " · updates available; search again" : ""}`;
}
function startSearch(scope) {
	const previous = state.search[scope];
	previous.abort?.abort();
	clearTimeout(previous.timer);
	const input = $(scope === "entries" ? "#entry-search" : "#call-search");
	const query = input.value.trim().toLowerCase();
	const search = {
		query,
		ids: new Set(),
		running: Boolean(query && state.id),
		abort: new AbortController(),
		revision: state.revision,
		scanned: 0,
		unavailable: 0,
	};
	state.search[scope] = search;
	$(scope === "entries" ? "#entry-list" : "#call-list").scrollTop = 0;
	buildLists();
	renderLists();
	if (!search.running) return;
	const endpoint = path("search"),
		generation = state.generation;
	search.timer = setTimeout(async () => {
		let cursor = 0;
		try {
			do {
				const page = await fetchJson(
					`${endpoint}?scope=${scope}&q=${encodeURIComponent(query)}&after=${cursor}`,
					AbortSignal.any([search.abort.signal, AbortSignal.timeout(15000)]),
				);
				if (generation !== state.generation || state.search[scope] !== search) return;
				for (const id of page.ids) search.ids.add(id);
				search.total = page.total;
				search.scanned = page.scanned;
				search.unavailable += page.unavailable;
				cursor = page.next;
				search.running = cursor !== null;
				buildLists();
				renderLists();
			} while (cursor !== null);
		} catch (error) {
			if (state.search[scope] !== search || error.name === "AbortError") return;
			search.running = false;
			search.error = `Search incomplete: ${error.message}`;
			renderLists();
		}
	}, 300);
}
function renderSessionSummary() {
	if (!state.meta) return;
	const value = data(),
		stats = statistics(value);
	const knownCost = value.entries.filter((entry) => entry.usage?.cost != null).length;
	$("#session-summary").textContent =
		`${value.entries.length} entries · ${stats.recorded ? `${number(stats.input + stats.output)} recorded tokens` : "usage unknown"} · ${knownCost ? `$${stats.cost.toFixed(4)} estimated cost${knownCost < stats.recorded ? " (partial)" : ""}` : "cost unknown"}`;
}
async function loadSessionInfo() {
	if (!state.id) return;
	const body = $("#session-info-body");
	if (body.dataset.session === state.id) return;
	const generation = state.generation,
		id = state.id;
	body.dataset.session = id;
	body.textContent = "Loading session metadata…";
	try {
		const info = await fetchJson(path("info"));
		if (generation !== state.generation || id !== state.id) return;
		const entries = [...state.entries.values()],
			counts = (role) => entries.filter((entry) => entry.role === role).length;
		const models = [...new Set(entries.flatMap((entry) => (entry.model ? [entry.model] : [])))];
		body.innerHTML = `<div class="session-facts"><p><b>Session</b> ${e(id)}</p><p><b>Created</b> ${e(info.header?.timestamp || "Unknown")}</p><p><b>Directory</b> ${e(state.meta.cwd)}</p><p><b>Messages</b> ${counts("user")} user · ${counts("assistant")} assistant · ${counts("toolResult")} tool results</p><p><b>Models</b> ${e(models.join(", ") || "Unknown")}</p><p><b>Trace calls</b> ${state.calls.size} · ${e(state.meta.persistence)}</p></div>`;
		if (info.systemPrompt)
			inspector.lazy(body, "Current system prompt (not a historical request)", (parent) =>
				inspector.rich(parent, info.systemPrompt),
			);
		if (info.tools?.length) inspector.json(body, `Active tool definitions (${info.tools.length})`, info.tools);
		inspector.json(body, "Session header JSON", info.header);
	} catch (error) {
		if (generation === state.generation && id === state.id) body.textContent = error.message;
	}
}
$("#session-info").addEventListener("toggle", () => {
	if ($("#session-info").open) loadSessionInfo();
});
for (const button of document.querySelectorAll("[data-search-again]"))
	button.addEventListener("click", () => startSearch(button.dataset.searchAgain));
bindResizer($("#tree-resizer"), "--tree-width", 320, 260, 600);
bindResizer($("#inspector-resizer"), "--inspector-width", 570, 340, 900, true);

for (const button of document.querySelectorAll("[data-view]"))
	button.addEventListener("click", () => setView(button.dataset.view));
$("#scope").addEventListener("change", () => {
	state.scope = $("#scope").value;
	state.overviewKey = "";
	renderOverview();
	buildLists();
	renderLists();
});
$("#sessions").addEventListener("change", () => {
	state.generation++;
	state.id = $("#sessions").value;
	pendingItem = null;
	state.revision = 0;
	state.meta = null;
	state.entries.clear();
	state.calls.clear();
	state.tools.clear();
	state.overviewKey = "";
	state.branchId = null;
	state.follow = true;
	$("#follow").setAttribute("aria-pressed", "true");
	conversation.clear();
	resetSearch();
	$("#session-info-body").replaceChildren();
	delete $("#session-info-body").dataset.session;
	closeInspector();
	schedule();
});
$("#refresh").addEventListener("click", () => {
	state.pending = true;
	for (const scope of ["entries", "calls"]) if (state.search[scope].query) startSearch(scope);
	delete $("#session-info-body").dataset.session;
	schedule();
});
$("#all-calls").addEventListener("click", () => setView("calls"));
$("#close-inspector").addEventListener("click", closeInspector);
$("#toggle-tree").addEventListener("click", () => {
	const open = $("#session").classList.toggle("show-tree");
	$("#toggle-tree").setAttribute("aria-expanded", String(open));
	if (open) {
		buildLists();
		renderLists();
		$("#entry-list").focus();
	}
});
$("#follow").addEventListener("click", () => {
	state.follow = !state.follow;
	state.branchId = state.follow ? null : state.meta?.leafId;
	if (state.follow && !inspector.selection) state.selected = null;
	$("#follow").setAttribute("aria-pressed", String(state.follow));
	buildLists();
	renderLists();
	renderConversation();
	syncUrl();
});
for (const id of ["entry-search", "call-search"])
	$(`#${id}`).addEventListener("input", () => {
		startSearch(id === "entry-search" ? "entries" : "calls");
	});
for (const id of ["entry-filter", "call-filter"])
	$(`#${id}`).addEventListener("change", () => {
		buildLists();
		$(id === "entry-filter" ? "#entry-list" : "#call-list").scrollTop = 0;
		renderLists();
	});
for (const list of [$("#entry-list"), $("#call-list")]) {
	let frame;
	list.addEventListener(
		"scroll",
		() => {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = null;
					renderLists();
				});
		},
		{ passive: true },
	);
	list.addEventListener("keydown", (event) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const rows = state.view === "session" ? state.entryRows : state.callRows;
		const currentId = state.view === "session" ? (state.follow ? state.meta?.leafId : state.branchId) : state.selected;
		const current = rows.findIndex((row) => (row.entry?.id || row.id) === currentId);
		const index =
			event.key === "Home"
				? 0
				: event.key === "End"
					? rows.length - 1
					: Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
		const row = rows[index];
		if (!row) return;
		list.scrollTop = Math.max(0, index * 64 - list.clientHeight / 2);
		state.view === "session" ? openEntry(row.entry.id) : openCall(row.id);
		list.focus();
	});
}
document.addEventListener("click", (event) => {
	const call = event.target.closest("[data-call]"),
		entry = event.target.closest("[data-entry]");
	if (call) openCall(call.dataset.call);
	if (entry) openEntry(entry.dataset.entry);
});
document.addEventListener("keydown", (event) => {
	if ($("#image-viewer").open) return;
	if (event.key === "Tab" && $("#workspace").inert) {
		const elements = [...$("#inspector").querySelectorAll("button, a[href], summary, [tabindex='0']")].filter(
			(element) => !element.disabled && element.getClientRects().length,
		);
		const next = event.shiftKey ? elements.at(-1) : elements[0];
		if (document.activeElement === (event.shiftKey ? elements[0] : elements.at(-1))) {
			event.preventDefault();
			next?.focus();
		}
	}
	if (event.key === "Escape" && !$("#inspector").hidden) closeInspector();
});
$("#theme").addEventListener("click", () => {
	const dark = document.documentElement.dataset.theme !== "light";
	document.documentElement.dataset.theme = dark ? "light" : "dark";
	try {
		localStorage.setItem("pi-trace-theme", document.documentElement.dataset.theme);
	} catch {}
});
try {
	const theme = localStorage.getItem("pi-trace-theme");
	if (["light", "dark"].includes(theme)) document.documentElement.dataset.theme = theme;
} catch {}
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		state.eventSource?.close();
		clearTimeout(state.timer);
		state.timer = null;
		connection("", "Paused while hidden");
	} else {
		connect();
		schedule();
	}
});
let resizeTimer;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		inspectorLayout();
		renderOverview(true);
		renderLists();
	}, 150);
});
setView(
	params.get("view") ||
		(params.get("mode") === "calls" || params.has("call") ? "calls" : params.has("entry") ? "session" : "overview"),
);
connect();
refresh();
