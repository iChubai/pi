import { copyText, itemLink } from "./actions.js";
import { branchPath, clock, escapeHtml as e, number } from "./model.js";

/** Shared paged reader; the original Session frontend supplies its own entry shells. */
export class Conversation {
	constructor(panel, renderer, fetchJson, toast, onInspect, callForEntry, options = {}) {
		Object.assign(this, { panel, renderer, fetchJson, toast, onInspect, callForEntry, options });
		this.list = panel.querySelector(".conversation-list");
		this.rows = [];
		this.key = "";
		this.generation = 0;
		this.active = 0;
		this.queue = [];
		(options.documentViewport ? window : this.list).addEventListener(
			"scroll",
			() => {
				const area = options.documentViewport ? document.scrollingElement : this.list;
				this.pinned = area.scrollHeight - area.clientHeight - area.scrollTop < 40;
			},
			{ passive: true },
		);
		panel.querySelector("[data-older]").addEventListener("click", () => {
			this.end = this.start;
			this.pinned = false;
			this.render();
		});
		panel.querySelector("[data-newer]").addEventListener("click", () => {
			this.end = Math.min(this.rows.length, this.end + 20);
			this.pinned = false;
			this.render();
		});
		panel.querySelector("[data-latest]").addEventListener("click", () => {
			this.end = this.rows.length;
			this.pinned = true;
			this.render();
		});
	}
	setBranch(entries, id, base) {
		const first = !this.key;
		const changed = this.id !== id || this.base !== base;
		const atEnd = this.end === this.rows.length;
		this.id = id;
		this.base = base;
		this.rows = branchPath(entries, id);
		if (changed || atEnd) this.end = this.rows.length;
		else this.end = Math.min(this.end, this.rows.length);
		if (changed) this.pinned = true;
		if (first && this.options.initialFromStart) {
			this.end = Math.min(20, this.rows.length);
			this.pinned = false;
			this.initialPosition = true;
		}
		if (this.signature() !== this.key) this.render();
	}
	signature() {
		return `${this.base}:${this.id}:${this.end}:${this.rows
			.slice(Math.max(0, this.end - 20), this.end)
			.map((row) => `${row.id}:${row.version}`)
			.join("|")}`;
	}
	clear() {
		this.generation++;
		this.abort?.abort();
		this.observer?.disconnect();
		for (const job of this.queue) job.reject(new DOMException("Selection changed", "AbortError"));
		this.queue = [];
		this.rows = [];
		this.id = null;
		this.key = "";
		this.list.replaceChildren();
	}
	position() {
		if (this.options.documentViewport) {
			if (this.initialPosition) {
				window.scrollTo({ top: 0 });
				this.initialPosition = false;
			} else if (this.pinned) this.list.lastElementChild?.scrollIntoView({ block: "end" });
			else this.panel.scrollIntoView({ block: "start" });
		} else this.list.scrollTop = this.pinned ? this.list.scrollHeight : 0;
	}
	shell(row) {
		if (this.options.shell) return this.options.shell(row);
		const node = document.createElement("article");
		node.className = `conversation-entry${row.id === this.id ? " target-entry" : ""}${row.isError ? " row-error" : ""}`;
		const call = this.callForEntry(row.id);
		node.innerHTML = `<header><div><b>${e(row.tool || row.customType || row.role || row.type)}</b>${row.label ? `<span class="entry-label">${e(row.label)}</span>` : ""}<small>${e(clock(row.timestamp))}${row.usage ? ` · ${e(number(row.usage.total))} tok` : ""}</small></div><div class="entry-actions">${call ? `<button class="text-button" data-call="${e(call)}">Call context</button>` : ""}<button class="text-button" data-inspect>Inspect</button><button class="text-button" data-link>Copy link</button><button class="text-button" data-json>Copy JSON</button></div></header>`;
		const gate = document.createElement("details");
		gate.className = "conversation-content";
		gate.innerHTML = `<summary>${e(row.preview || row.type)}</summary><div class="conversation-body"></div>`;
		gate.open =
			row.id === this.id ||
			(row.type === "message" && ["user", "assistant"].includes(row.role)) ||
			(row.type === "custom_message" && row.display);
		node.append(gate);
		return { node, gate, body: gate.querySelector(".conversation-body") };
	}
	render() {
		this.key = this.signature();
		this.abort?.abort();
		this.abort = new AbortController();
		this.observer?.disconnect();
		const generation = ++this.generation;
		for (const job of this.queue) job.reject(new DOMException("Selection changed", "AbortError"));
		this.queue = [];
		this.cache = new Map();
		this.start = Math.max(0, this.end - 20);
		const rows = this.rows.slice(this.start, this.end);
		this.panel.querySelector(".conversation-status").textContent = rows.length
			? `${this.start + 1}–${this.end} / ${number(this.rows.length)} entries · selected ancestry, not model context`
			: "Select a tree node to read its branch.";
		this.panel.querySelector("[data-older]").disabled = this.start === 0;
		this.panel.querySelector("[data-newer]").disabled = this.end >= this.rows.length;
		this.panel.querySelector("[data-latest]").disabled = this.end >= this.rows.length;
		this.list.replaceChildren();
		this.observer = new IntersectionObserver(
			(changes) => {
				for (const change of changes)
					if (change.isIntersecting) {
						const gate = change.target;
						if (gate.tagName !== "DETAILS" || gate.open) gate.loadBody();
					}
			},
			{ root: this.options.documentViewport ? null : this.list, rootMargin: "200px" },
		);
		for (const row of rows) {
			const { node, gate, body } = this.shell(row);
			body.textContent = "Content loads when visible.";
			let loaded = false;
			gate.loadBody = async () => {
				if (loaded || generation !== this.generation) return;
				loaded = true;
				body.textContent = "Loading this entry…";
				try {
					const entry = await this.load(row.id, generation);
					if (generation !== this.generation) return;
					const pinned = this.pinned;
					body.replaceChildren();
					this.renderer.entry(body, entry);
					if (pinned) this.position();
				} catch (error) {
					if (generation === this.generation && error.name !== "AbortError") {
						body.textContent = error.message;
						loaded = false;
					}
				}
			};
			gate.addEventListener("toggle", () => {
				const rect = gate.getBoundingClientRect();
				const viewport = this.options.documentViewport
					? { top: 0, bottom: innerHeight }
					: this.list.getBoundingClientRect();
				if (gate.open && rect.bottom >= viewport.top && rect.top <= viewport.bottom + 200) gate.loadBody();
			});
			node.querySelector("[data-inspect]")?.addEventListener("click", () => this.onInspect(row.id));
			node
				.querySelector("[data-link]")
				?.addEventListener("click", () => copyText(itemLink(row.id, "entry"), this.toast));
			node.querySelector("[data-json]")?.addEventListener("click", async () => {
				try {
					const entry = await this.load(row.id, generation);
					if (generation === this.generation) await copyText(JSON.stringify(entry, null, 2), this.toast);
				} catch (error) {
					if (error.name !== "AbortError") this.toast(error.message);
				}
			});
			this.list.append(node);
			this.observer.observe(gate);
		}
		this.position();
	}
	load(id, generation) {
		if (this.cache.has(id)) return this.cache.get(id);
		const promise = new Promise((resolve, reject) => {
			this.queue.push({ id, generation, resolve, reject, base: this.base, signal: this.abort.signal });
			this.drain();
		});
		this.cache.set(id, promise);
		promise.catch(() => {
			if (this.cache.get(id) === promise) this.cache.delete(id);
		});
		return promise;
	}
	drain() {
		while (this.active < 3 && this.queue.length) {
			const job = this.queue.shift();
			if (job.generation !== this.generation) {
				job.reject(new DOMException("Selection changed", "AbortError"));
				continue;
			}
			this.active++;
			this.fetchJson(
				`${job.base}/${encodeURIComponent(job.id)}`,
				AbortSignal.any([job.signal, AbortSignal.timeout(15000)]),
			)
				.then(job.resolve, job.reject)
				.finally(() => {
					this.active--;
					this.drain();
				});
		}
	}
}
