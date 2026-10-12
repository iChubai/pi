import { copyText, itemLink, showImage } from "./actions.js";
import { clock, escapeHtml as e, shortModel, time } from "./model.js";

export class Inspector {
	constructor(panel, fetchJson, toast) {
		this.panel = panel;
		this.fetchJson = fetchJson;
		this.toast = toast;
		this.tab = "output";
		this.selection = null;
		this.detail = null;
		this.abort = null;
		panel.addEventListener("click", (event) => {
			const tab = event.target.closest("[data-tab]");
			if (tab) {
				this.tab = tab.dataset.tab;
				this.renderBody();
			}
			if (event.target.closest("[data-refresh-detail]")) this.open(this.selection, true);
			if (event.target.closest("[data-copy-link]") && this.selection)
				copyText(itemLink(this.selection.id, this.selection.type), this.toast);
			if (event.target.closest("[data-copy-detail]") && this.detail)
				copyText(JSON.stringify(this.detail, null, 2), this.toast);
		});
	}
	async open(selection, refresh = false) {
		if (!selection) return;
		if (!refresh && this.selection?.id === selection.id && this.selection?.type === selection.type && this.detail) {
			this.panel.hidden = false;
			this.selection.row = selection.row;
			this.renderHeader(selection.row);
			return;
		}
		this.abort?.abort();
		this.abort = new AbortController();
		if (this.selection?.id !== selection.id) this.followStream = selection.row.status === "running";
		this.selection = selection;
		const controller = this.abort;
		const requested = { status: selection.row.status, attempts: selection.row.attempts };
		this.detail = null;
		this.panel.hidden = false;
		this.panel.querySelector(".inspector-body").innerHTML = '<div class="loading-detail">Loading only this item…</div>';
		this.renderHeader(selection.row);
		try {
			const detail = await this.fetchJson(
				selection.path,
				AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
			);
			if (this.selection !== selection || this.abort !== controller) return;
			if (
				detail.meta &&
				((selection.row.status !== requested.status && detail.meta.status === requested.status) ||
					selection.row.attempts > detail.meta.attempts)
			) {
				this.open(selection, true);
				return;
			}
			this.detail = detail;
			this.renderBody();
		} catch (error) {
			if (this.selection === selection && this.abort === controller && error.name !== "AbortError")
				this.panel.querySelector(".inspector-body").textContent = error.message;
		}
	}
	update(row) {
		if (!this.selection) return;
		const previous = this.selection.row;
		this.selection.row = row;
		this.renderHeader(row);
		// Reload large detail only for a new exposed request or completion, never per token.
		if (this.detail && (previous.status !== row.status || previous.attempts !== row.attempts))
			this.open(this.selection, true);
		else this.streamRefresh?.();
	}
	close() {
		this.abort?.abort();
		this.panel.hidden = true;
		this.detail = null;
		this.selection = null;
	}
	renderHeader(row) {
		this.panel.querySelector(".inspector-heading").innerHTML =
			`<span class="eyebrow">${this.selection.type === "call" ? `CALL ${row.number ? `#${row.number}` : ""} · ${e(row.kind)} · ${e(row.status)}` : "SESSION ENTRY"}</span><h2>${e(row.preview || row.kind || row.type)}</h2><div class="detail-meta"><span title="${e(row.model)}">${e(row.model ? shortModel(row.model) : row.kind || row.type)}</span>${row.api ? `<span>${e(row.api)}</span>` : ""}${this.selection.type === "call" ? `<span title="1-based pi turn index within an agent run; resets between prompts">turn ${row.turnIndex == null ? "unknown" : row.turnIndex + 1}</span><span>${row.attempts} exposed requests</span>` : ""}<span>${e(clock(row.startedAt || row.timestamp))}</span><span>${e(time(row.durationMs))}</span>${row.firstOutputMs == null ? "" : `<span>first output ${e(time(row.firstOutputMs))}</span>`}</div>${row.activity ? `<p class="call-activity">${e(row.activity)}</p>` : ""}`;
	}
	renderBody() {
		if (!this.detail) return;
		const body = this.panel.querySelector(".inspector-body");
		this.streamRefresh = null;
		body.replaceChildren();
		if (this.selection.type === "entry") {
			this.entry(body, this.detail);
			return;
		}
		const tabs = document.createElement("div");
		tabs.className = "detail-tabs";
		const labels = {
			output: "Output",
			input: "Pi Context",
			backend: "Provider payload",
			compare: "Compare",
			stream: "Stream",
			raw: "Raw",
		};
		tabs.innerHTML = Object.keys(labels)
			.map(
				(tab) =>
					`<button data-tab="${tab}" class="${this.tab === tab ? "active" : ""}" aria-pressed="${this.tab === tab}">${labels[tab]}</button>`,
			)
			.join("");
		body.append(tabs);
		const content = document.createElement("div");
		content.className = "detail-content";
		body.append(content);
		if (this.tab === "output") {
			if (this.detail.error) this.note(content, this.detail.error, true);
			if (this.detail.final?.type) this.entry(content, this.detail.final);
			else if (this.detail.final) this.message(content, this.detail.final);
			else this.note(content, "Output has not completed yet. Refresh this item after completion.");
		} else if (this.tab === "input") this.input(content);
		else if (this.tab === "backend") this.backend(content);
		else if (this.tab === "compare") {
			content.classList.add("context-compare");
			const pi = document.createElement("section"),
				provider = document.createElement("section");
			content.append(pi, provider);
			this.heading(pi, "Pi Context");
			this.input(pi);
			this.heading(provider, "Provider payload");
			this.backend(provider);
		} else if (this.tab === "stream") {
			this.loadStreams(content);
		} else this.json(content, "Call JSON (stream events paged separately)", this.detail, true);
	}
	input(parent) {
		if (this.detail.context) {
			this.note(
				parent,
				"Recorded extension context. Later hooks may transform it; compare with the captured provider payload.",
			);
			if (this.detail.context.systemPrompt)
				this.lazy(parent, "System prompt", (body) => this.rich(body, this.detail.context.systemPrompt));
			this.messages(parent, this.detail.context.messages || []);
			if (this.detail.context.tools?.length) this.json(parent, "Tool definitions", this.detail.context.tools);
		} else if (this.detail.compaction) {
			const { messagesToSummarize, turnPrefixMessages, ...metadata } = this.detail.compaction;
			this.json(parent, "Compaction policy and cut point", metadata, true);
			this.heading(parent, "Selected source messages");
			this.messages(parent, messagesToSummarize || []);
			if (turnPrefixMessages?.length) {
				this.heading(parent, "Split-turn prefix");
				this.messages(parent, turnPrefixMessages);
			}
		} else
			this.note(
				parent,
				"Input was not captured for this historical call. Native history cannot reconstruct its exact request.",
			);
	}
	backend(parent) {
		if (!this.detail.requests.length)
			this.note(
				parent,
				"No provider payload was exposed by pi for this call. Internal summaries and direct-HTTP tools may not emit these hooks.",
			);
		for (const request of this.detail.requests) {
			this.heading(parent, `Request ${request.attempt} · ${clock(request.timestamp)}`);
			const payload = request.payload;
			if (payload && typeof payload === "object") {
				if (payload.instructions || payload.system)
					this.lazy(parent, "Provider instructions", (body) =>
						this.message(body, payload.instructions || payload.system),
					);
				this.messages(
					parent,
					Array.isArray(payload.input) ? payload.input : Array.isArray(payload.messages) ? payload.messages : [],
				);
				const {
					input: _input,
					messages: _messages,
					instructions: _instructions,
					system: _system,
					...parameters
				} = payload;
				this.json(parent, "Parameters and provider tool definitions", parameters);
			}
			this.json(parent, "Complete request JSON", payload);
		}
		if (this.detail.responses.length) this.json(parent, "Response status / sanitized headers", this.detail.responses);
	}
	lazy(parent, title, mount) {
		const details = document.createElement("details");
		details.className = "lazy-block";
		const summary = document.createElement("summary");
		summary.textContent = title;
		details.append(summary);
		const body = document.createElement("div");
		body.className = "lazy-body";
		details.append(body);
		let loaded = false;
		details.addEventListener("toggle", () => {
			if (details.open && !loaded) {
				loaded = true;
				mount(body);
			}
		});
		parent.append(details);
		return details;
	}
	messages(parent, messages) {
		let shown = 0;
		const list = document.createElement("div");
		parent.append(list);
		const more = document.createElement("button");
		more.className = "load-more";
		const page = () => {
			const end = Math.min(messages.length, shown + 40);
			for (; shown < end; shown++) {
				const message = messages[shown];
				const preview =
					typeof message === "string"
						? message.slice(0, 90)
						: this.preview(message?.content || message?.output || message?.arguments || "");
				this.lazy(list, `${shown + 1} · ${message?.role || message?.type || "message"} · ${preview}`, (body) => {
					this.message(body, message);
					this.json(body, "Message JSON", message);
				});
			}
			more.textContent = `Show next ${Math.min(40, messages.length - shown)} messages (${messages.length - shown} remaining)`;
			more.hidden = shown >= messages.length;
		};
		more.addEventListener("click", page);
		parent.append(more);
		page();
	}
	preview(value) {
		if (typeof value === "string") return value.slice(0, 90).replace(/\s+/g, " ");
		if (Array.isArray(value))
			return value
				.map((block) => block?.text?.slice(0, 90) || block?.name || block?.type || "")
				.join(" ")
				.slice(0, 90);
		return "";
	}
	entry(parent, entry) {
		if (entry.type === "message") this.message(parent, entry.message);
		else if (entry.summary) {
			this.heading(parent, entry.type === "compaction" ? "Compaction summary" : "Branch summary");
			if (entry.type === "compaction")
				this.note(
					parent,
					`${entry.tokensBefore ?? "Unknown"} tokens before compaction · first kept entry: ${entry.firstKeptEntryId ?? "unknown"}`,
				);
			this.rich(parent, entry.summary);
		} else if (entry.type === "context_edit") {
			this.note(
				parent,
				`${entry.replacement === null ? "Omitted" : "Replaced"} ${entry.targetId} in future model context. Persisted history is unchanged.`,
			);
			if (entry.replacement !== null) this.json(parent, "Replacement", entry.replacement, true);
		} else if (entry.type === "custom_message") this.message(parent, entry);
		else if (entry.type === "custom") this.json(parent, `Custom state: ${entry.customType}`, entry.data, true);
		this.json(parent, "Original entry JSON", entry);
	}
	message(parent, message) {
		if (typeof message === "string") {
			this.rich(parent, message);
			return;
		}
		if (Array.isArray(message)) {
			this.message(parent, { content: message });
			return;
		}
		if (!message || typeof message !== "object") {
			this.note(parent, "No message content recorded.");
			return;
		}
		if (message.summary) this.rich(parent, message.summary);
		if (message.command) this.plain(parent, `$ ${message.command}`);
		const content = message.content ?? message.output ?? message.text;
		if (message.type === "function_call_output" && typeof content === "string") {
			try {
				const decoded = JSON.parse(content);
				if (decoded && typeof decoded === "object") {
					this.message(parent, decoded);
					return;
				}
			} catch {
				/* Non-JSON tool output remains text. */
			}
		}
		if (typeof content === "string") this.rich(parent, content);
		else if (Array.isArray(content))
			for (const block of content) {
				if (typeof block === "string") this.rich(parent, block);
				else if (!block || typeof block !== "object") this.json(parent, "Content block", block);
				else if (["image", "image_url", "input_image"].includes(block.type)) this.image(parent, block);
				else if (block.type === "tool_result") {
					this.lazy(parent, `Tool result ${block.tool_use_id || ""}`, (body) =>
						this.message(body, {
							content: block.content,
							errorMessage: block.is_error ? "Tool returned an error" : undefined,
						}),
					);
				} else if (block.type === "thinking") {
					this.lazy(parent, block.thinking ? "Thinking" : "Thinking (encrypted signature)", (body) => {
						if (block.thinking) this.rich(body, block.thinking);
						if (block.thinkingSignature) this.plain(body, `Signature: ${block.thinkingSignature}`);
					});
				} else if (block.text) {
					this.rich(parent, block.text);
				} else
					this.json(
						parent,
						block.name || block.type || "Content block",
						block,
						["toolCall", "tool_use", "function_call"].includes(block.type),
					);
			}
		else if (message.type === "function_call" || message.type === "tool_use")
			this.json(parent, message.name || "Tool call", message, true);
		if (message.errorMessage) this.note(parent, message.errorMessage, true);
		if (message.details !== undefined) this.json(parent, "Tool details", message.details);
		if (message.usage) this.json(parent, "Recorded usage", message.usage);
	}
	image(parent, block) {
		const mime = block.mimeType || block.source?.media_type;
		const data = block.data || block.source?.data;
		const source =
			typeof block.image_url === "string"
				? block.image_url
				: block.image_url?.url ||
					(/^image\/(png|jpeg|webp|gif)$/.test(mime || "") && data ? `data:${mime};base64,${data}` : "");
		if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(source)) {
			this.note(parent, "External or unsupported image reference preserved in JSON; not fetched by this local viewer.");
			return;
		}
		this.lazy(parent, "Image attachment · expand, then click to enlarge", (body) => {
			const button = document.createElement("button"),
				image = document.createElement("img");
			button.className = "image-button";
			button.setAttribute("aria-label", "Enlarge image attachment");
			image.className = "attachment";
			image.src = source;
			image.alt = "Session image attachment";
			button.append(image);
			button.addEventListener("click", () => showImage(source));
			body.append(button);
		});
	}
	rich(parent, source, escapeMarkup = false) {
		const value = String(source ?? "");
		if (value.length > 131072) {
			this.note(parent, "Large text: showing the first 128K characters. Download the original below.");
		}
		const node = document.createElement("div");
		node.className = "markdown";
		const template = document.createElement("template");
		template.innerHTML =
			globalThis.marked?.parse(escapeMarkup ? e(value.slice(0, 131072)) : value.slice(0, 131072)) ||
			`<pre>${e(value.slice(0, 131072))}</pre>`;
		const allowed = new Set([
			"P",
			"BR",
			"STRONG",
			"EM",
			"DEL",
			"CODE",
			"PRE",
			"H1",
			"H2",
			"H3",
			"H4",
			"H5",
			"H6",
			"UL",
			"OL",
			"LI",
			"BLOCKQUOTE",
			"HR",
			"TABLE",
			"THEAD",
			"TBODY",
			"TR",
			"TH",
			"TD",
			"A",
		]);
		for (const element of [...template.content.querySelectorAll("*")]) {
			if (!allowed.has(element.tagName)) {
				element.replaceWith(document.createTextNode(element.textContent || ""));
				continue;
			}
			const href = element.getAttribute("href"),
				language = element.getAttribute("class");
			for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
			if (element.tagName === "A" && href && /^(https?:\/\/|mailto:|#)/i.test(href.trim())) {
				element.setAttribute("href", href);
				element.setAttribute("target", "_blank");
				element.setAttribute("rel", "noopener noreferrer");
			}
			if (element.tagName === "CODE" && /^language-[\w+-]+$/.test(language || "")) element.className = language;
		}
		node.append(template.content);
		parent.append(node);
		for (const block of node.querySelectorAll("pre code"))
			if (block.textContent.length < 20000) {
				try {
					globalThis.hljs?.highlightElement(block);
				} catch {
					/* Plain code remains readable. */
				}
			}
		this.lazy(parent, "Markdown source", (body) => this.plain(body, value));
	}
	plain(parent, value) {
		const pre = document.createElement("pre");
		pre.textContent = value.slice(0, 65536);
		parent.append(pre);
		if (value.length > 65536)
			this.note(parent, "Preview limited to 64K characters; the download contains the full original.");
		const button = document.createElement("button");
		button.className = "text-button";
		button.textContent = "Download original";
		button.addEventListener("click", () => {
			const url = URL.createObjectURL(new Blob([value], { type: "text/plain" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = "pi-trace-detail.txt";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		});
		const copy = document.createElement("button");
		copy.className = "text-button copy-text";
		copy.textContent = "Copy full text / JSON";
		copy.addEventListener("click", () => copyText(value, this.toast));
		parent.append(button, copy);
	}
	json(parent, title, value, opened = false) {
		const details = this.lazy(parent, title, (body) => this.plain(body, JSON.stringify(value, null, 2) ?? "null"));
		if (opened) details.open = true;
	}
	heading(parent, value) {
		const heading = document.createElement("h3");
		heading.textContent = value;
		parent.append(heading);
	}
	note(parent, value, error = false) {
		const node = document.createElement("div");
		node.className = `detail-note${error ? " error-note" : ""}`;
		node.textContent = value;
		parent.append(node);
	}
	async loadStreams(parent) {
		const selection = this.selection;
		const controls = document.createElement("div"),
			list = document.createElement("div"),
			status = document.createElement("p");
		controls.className = "stream-controls";
		controls.innerHTML =
			'<button class="quiet-button" data-prev>Previous 80</button><button class="quiet-button" data-next>Next 80</button><button class="quiet-button" data-live>Follow latest</button>';
		status.className = "muted";
		parent.append(controls, status, list);
		const previous = controls.querySelector("[data-prev]"),
			next = controls.querySelector("[data-next]"),
			live = controls.querySelector("[data-live]");
		let cursor = 0,
			total = 0,
			loadedTotal = -1,
			loading = false;
		const load = async (after) => {
			if (loading || !parent.isConnected || this.selection !== selection) return;
			loading = true;
			previous.disabled = next.disabled = true;
			try {
				const result = await this.fetchJson(
					`${selection.path.replace("/calls/", "/streams/")}?after=${after}`,
					AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
				);
				if (this.selection !== selection || !parent.isConnected) return;
				cursor = after;
				total = result.total;
				loadedTotal = total;
				list.replaceChildren();
				for (const [index, item] of result.records.entries())
					this.json(
						list,
						`#${after + index + 1} · ${clock(item.timestamp)} · ${item.event?.type || item.type}`,
						item.event,
					);
				status.textContent = total
					? `${after + 1}–${after + result.records.length} / ${total} stream events${this.followStream ? " · following latest" : ""}`
					: "No streaming events captured for this call.";
				previous.disabled = cursor === 0;
				next.disabled = cursor + result.records.length >= total;
				live.setAttribute("aria-pressed", String(this.followStream));
			} catch (error) {
				if (error.name !== "AbortError" && parent.isConnected) {
					loadedTotal = selection.row.streamEvents;
					this.note(list, error.message, true);
				}
			} finally {
				loading = false;
				if (
					parent.isConnected &&
					this.selection === selection &&
					this.followStream &&
					selection.row.streamEvents > loadedTotal
				)
					this.streamRefresh?.();
			}
		};
		previous.addEventListener("click", () => {
			this.followStream = false;
			load(Math.max(0, cursor - 80));
		});
		next.addEventListener("click", () => {
			this.followStream = false;
			load(cursor + 80);
		});
		live.addEventListener("click", () => {
			this.followStream = !this.followStream;
			load(this.followStream ? Math.max(0, selection.row.streamEvents - 80) : cursor);
		});
		this.streamRefresh = () => {
			if (this.tab === "stream" && this.followStream && selection.row.streamEvents > loadedTotal)
				load(Math.max(0, selection.row.streamEvents - 80));
		};
		await load(this.followStream ? Math.max(0, selection.row.streamEvents - 80) : 0);
	}
}
