import { showImage } from "./actions.js";
import { Inspector } from "./inspector.js";
import { escapeHtml as e } from "./model.js";

/** Original Pi Trace entry markup and disclosure styles, with lazy bodies and bounded previews. */
export class SessionRenderer extends Inspector {
	shell(row) {
		const node = document.createElement("article");
		node.id = `entry-${row.id}`;
		node.dataset.record = row.id;
		node.className = `entry ${row.role === "user" ? "user-message" : row.role === "assistant" ? "assistant-message" : ["model_change", "thinking_level_change", "session_info", "label"].includes(row.type) ? "setting-change" : ""}`;
		node.innerHTML = `<button class="copy-link" data-link title="Copy entry link" aria-label="Copy entry link">#</button><div class="entry-actions"><button class="text-button" data-inspect>JSON</button><button class="text-button" data-json>Copy JSON</button></div><div class="message-timestamp">${e(new Date(row.timestamp).toLocaleString())}</div>`;
		let gate = node;
		const body = document.createElement("div");
		if (row.role === "toolResult" || ["compaction", "branch_summary", "custom_message", "custom"].includes(row.type)) {
			gate = document.createElement("details");
			gate.className =
				row.role === "toolResult"
					? `tool-block ${row.isError ? "error" : "success"}`
					: row.type === "compaction"
						? "compaction"
						: row.type === "branch_summary"
							? "branch-summary"
							: `custom-message${row.type === "custom" ? " custom-state" : row.display ? "" : " hidden-custom"}`;
			gate.innerHTML = `<summary>${row.role === "toolResult" ? `<span class="tool-name">${e(row.tool || "tool")}</span> result${row.isError ? " · error" : ""}` : row.type === "compaction" ? `[compaction] Compacted from ${row.tokensBefore ?? "unknown"} tokens` : row.type === "branch_summary" ? "Branch Summary" : `${e(row.customType || "custom")} ${row.type === "custom" ? "custom state" : row.display ? "custom message" : "hidden custom message"}`}</summary>`;
			gate.open = row.type === "branch_summary" || (row.type === "custom_message" && row.display);
			body.className = row.role === "toolResult" ? "tool-content" : "summary-content";
			gate.append(body);
			node.append(gate);
		} else node.append(body);
		return { node, gate, body };
	}
	entry(parent, entry) {
		if (entry.type === "message") this.message(parent, entry.message);
		else if (entry.type === "custom_message") {
			this.message(parent, { content: entry.content });
			if (entry.details !== undefined) this.json(parent, "Details JSON", entry.details);
		} else if (entry.type === "custom") this.plain(parent, JSON.stringify(entry.data ?? null, null, 2));
		else if (entry.summary) {
			this.rich(parent, entry.summary);
			if (entry.type === "compaction")
				this.json(parent, "Compaction metadata", {
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					details: entry.details,
					usage: entry.usage,
				});
		} else if (entry.type === "model_change")
			parent.textContent = `Switched to model: ${entry.provider}/${entry.modelId}`;
		else if (entry.type === "thinking_level_change") parent.textContent = `Thinking level: ${entry.thinkingLevel}`;
		else if (entry.type === "session_info") parent.textContent = `Session name: ${entry.name || "(cleared)"}`;
		else if (entry.type === "label") parent.textContent = `Label: ${entry.label || "(cleared)"}`;
		else super.entry(parent, entry);
	}
	message(parent, message) {
		if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
			super.message(parent, message);
			return;
		}
		for (const block of message.content) {
			if (block?.type === "thinking") {
				this.lazy(
					parent,
					block.thinking ? "thinking" : "thinking (encrypted signature)",
					(body) => {
						if (block.thinking) this.plain(body, block.thinking);
						if (block.thinkingSignature) {
							const signature = document.createElement("div");
							signature.className = "thinking-signature";
							signature.textContent = `Signature: ${block.thinkingSignature}`;
							body.append(signature);
						}
					},
					"thinking-block",
					"thinking-content",
				);
			} else if (block?.type === "toolCall") {
				const details = this.lazy(
					parent,
					`${block.name || "tool"} call`,
					(body) => this.plain(body, JSON.stringify(block.arguments ?? {}, null, 2)),
					"tool-block",
					"tool-content",
				);
				details.open = true;
			} else super.message(parent, { content: [block] });
		}
		if (message.errorMessage) {
			const details = this.lazy(
				parent,
				"error",
				(body) => {
					body.textContent = message.errorMessage;
				},
				"tool-block error",
				"tool-content",
			);
			details.open = true;
		}
		if (message.details !== undefined) this.json(parent, "Details JSON", message.details);
		if (message.usage) this.json(parent, "Recorded usage", message.usage);
	}
	lazy(
		parent,
		title,
		mount,
		className = title === "Markdown source" ? "raw-markdown" : "header-disclosure",
		bodyClass = "context-section-body",
	) {
		const details = document.createElement("details"),
			summary = document.createElement("summary"),
			body = document.createElement("div");
		details.className = className;
		summary.textContent = title;
		body.className = bodyClass;
		details.append(summary, body);
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
	rich(parent, source) {
		super.rich(parent, source, true);
	}
	plain(parent, value) {
		super.plain(parent, value);
		parent.querySelector("pre:last-of-type")?.classList.add("json-block");
	}
	image(parent, block) {
		if (!/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType || "") || !block.data) {
			super.image(parent, block);
			return;
		}
		const button = document.createElement("button"),
			image = document.createElement("img");
		button.className = "image-button";
		button.setAttribute("aria-label", "Enlarge image attachment");
		image.className = "message-image";
		image.src = `data:${block.mimeType};base64,${block.data}`;
		image.alt = "Session image attachment";
		button.append(image);
		button.addEventListener("click", () => showImage(image.src));
		parent.append(button);
	}
}
