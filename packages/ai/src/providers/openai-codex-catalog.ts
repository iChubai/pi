import type { Provider, RefreshModelsContext } from "../models.ts";
import type { ModelsStoreEntry } from "../models-store.ts";
import type { Model, ModelThinkingLevel } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];

export const CODEX_CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";
export const CODEX_CATALOG_CLIENT_VERSION = "0.162.1";
export const CODEX_CATALOG_REFRESH_MS = 5 * 60 * 1000;

type CodexModel = Model<"openai-codex-responses">;

export interface CodexCatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxContextWindow: number;
	input: ("text" | "image")[];
	reasoningLevels: string[];
	defaultReasoningLevel?: string;
	supportsToolSearch?: boolean;
	visibility?: "list" | "hide";
}

// Sanitized official account catalog checked 2026-10-12. GitHub's bundled
// snapshot still says 272k for Sol 6.1; account discovery takes precedence.
const FALLBACK_ROWS: readonly (readonly [
	string,
	string,
	number,
	number,
	boolean,
	ModelThinkingLevel,
	"list" | "hide",
])[] = [
	["gpt-6.1-sol", "GPT-6.1-Sol", 500000, 872000, true, "low", "list"],
	["gpt-6-astra", "GPT-6-Astra", 272000, 872000, true, "medium", "list"],
	["gpt-6-sol", "GPT-6-Sol", 272000, 872000, true, "medium", "list"],
	["gpt-6-luna", "GPT-6-Luna", 272000, 872000, false, "medium", "list"],
	["gpt-reserve", "GPT-Reserve", 272000, 872000, false, "medium", "hide"],
	["gpt-5.6-sol", "GPT-5.6-Sol", 272000, 872000, true, "low", "list"],
	["gpt-5.6-terra", "GPT-5.6-Terra", 272000, 872000, true, "medium", "list"],
	["gpt-5.6-luna", "GPT-5.6-Luna", 272000, 872000, false, "medium", "list"],
	["gpt-5.5", "GPT-5.5", 272000, 272000, false, "medium", "hide"],
	["codex-auto-review", "Codex Auto Review", 272000, 872000, false, "medium", "hide"],
];

export const CODEX_CATALOG_FALLBACK: readonly CodexCatalogModel[] = FALLBACK_ROWS.map(
	([id, name, contextWindow, maxContextWindow, ultra, defaultReasoningLevel, visibility]) => ({
		id,
		name,
		contextWindow,
		maxContextWindow,
		input: ["text", "image"],
		reasoningLevels: [
			"low",
			"medium",
			"high",
			"xhigh",
			...(id === "gpt-5.5" ? [] : ["max"]),
			...(ultra ? ["ultra"] : []),
		],
		defaultReasoningLevel,
		supportsToolSearch: true,
		visibility,
	}),
);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseCodexCatalog(value: unknown): CodexCatalogModel[] {
	if (!record(value) || !Array.isArray(value.models) || value.models.length === 0) {
		throw new Error("Invalid official Codex model catalog");
	}
	const ids = new Set<string>();
	return value.models.map((entry) => {
		if (
			!record(entry) ||
			typeof entry.slug !== "string" ||
			!entry.slug ||
			ids.has(entry.slug) ||
			!positiveInteger(entry.context_window) ||
			(entry.max_context_window !== undefined &&
				entry.max_context_window !== null &&
				!positiveInteger(entry.max_context_window)) ||
			!Array.isArray(entry.input_modalities) ||
			entry.input_modalities.length === 0 ||
			!entry.input_modalities.every((input) => input === "text" || input === "image") ||
			!Array.isArray(entry.supported_reasoning_levels) ||
			!entry.supported_reasoning_levels.every(
				(level) => record(level) && typeof level.effort === "string" && level.effort.length > 0,
			)
		)
			throw new Error("Invalid official Codex model metadata");
		const maximum = positiveInteger(entry.max_context_window) ? entry.max_context_window : entry.context_window;
		if (maximum < entry.context_window) throw new Error("Codex context window exceeds its official maximum");
		ids.add(entry.slug);
		return {
			id: entry.slug,
			name: typeof entry.display_name === "string" && entry.display_name ? entry.display_name : entry.slug,
			contextWindow: entry.context_window,
			maxContextWindow: maximum,
			input: entry.input_modalities as ("text" | "image")[],
			reasoningLevels: entry.supported_reasoning_levels.map((level) => (level as { effort: string }).effort),
			...(typeof entry.default_reasoning_level === "string"
				? { defaultReasoningLevel: entry.default_reasoning_level }
				: {}),
			...(typeof entry.supports_search_tool === "boolean" ? { supportsToolSearch: entry.supports_search_tool } : {}),
			...(entry.visibility === "list" || entry.visibility === "hide" ? { visibility: entry.visibility } : {}),
		};
	});
}

/** Official fields override heuristics; unrelated limits, prices, and legacy IDs remain intact. */
export function applyCodexCatalog(
	baseline: readonly CodexModel[],
	metadata: readonly CodexCatalogModel[],
): CodexModel[] {
	const merged = new Map(baseline.map((model) => [model.id, { ...model }]));
	for (const official of metadata) {
		const previous = merged.get(official.id);
		const thinkingLevelMap = Object.fromEntries(
			MODEL_THINKING_LEVELS.map((level) => [
				level,
				official.reasoningLevels.includes(level === "off" ? "none" : level)
					? level === "off"
						? "none"
						: level
					: null,
			]),
		);
		const defaultThinkingLevel = MODEL_THINKING_LEVELS.find(
			(level) =>
				(level === "off" ? "none" : level) === official.defaultReasoningLevel && thinkingLevelMap[level] !== null,
		);
		merged.set(official.id, {
			// Newly discovered subscription models have unknown prices and use Pi's
			// conservative 16k output default; these are not official output limits.
			id: official.id,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 16384,
			...previous,
			name: official.name,
			contextWindow: official.contextWindow,
			maxContextWindow: official.maxContextWindow,
			input: [...official.input],
			reasoning: official.reasoningLevels.some((level) => level !== "none"),
			thinkingLevelMap,
			defaultThinkingLevel,
			compat: {
				...previous?.compat,
				...(official.supportsToolSearch !== undefined ? { supportsToolSearch: official.supportsToolSearch } : {}),
			},
		});
	}
	return [...merged.values()];
}

function accountId(token: string): string {
	try {
		const body = token.split(".")[1];
		if (!body) throw new Error();
		const claims: unknown = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
		const auth = record(claims) ? claims["https://api.openai.com/auth"] : undefined;
		const id = record(auth) ? auth.chatgpt_account_id : undefined;
		if (typeof id !== "string" || !id || /[\r\n]/.test(id)) throw new Error();
		return id;
	} catch {
		throw new Error("Codex OAuth account routing is unavailable");
	}
}

export interface CodexStoredCatalog extends ModelsStoreEntry {
	catalogSource: typeof CODEX_CATALOG_URL;
	catalogAccount: string;
	catalogVisibleIds: string[];
}

async function accountFingerprint(id: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Account-scoped discovery; never persists credentials or native catalog instructions. */
export function withOfficialCodexCatalog(
	provider: Provider<"openai-codex-responses">,
): Provider<"openai-codex-responses"> {
	const baseline = applyCodexCatalog(provider.getModels(), CODEX_CATALOG_FALLBACK);
	let models = baseline;
	let visibleIds: readonly string[] | undefined;
	return {
		...provider,
		getModels: () => models,
		getAllModels: () => models,
		filterModels: (available, credential) => {
			const filtered = provider.filterModels?.(available, credential) ?? available;
			return visibleIds
				? filtered.filter(
						(model) => visibleIds?.includes(model.id) || !models.some((known) => known.id === model.id),
					)
				: filtered;
		},
		refreshModels: async (context: RefreshModelsContext) => {
			if (context.signal.aborted) return;
			const credential = context.credential;
			if (credential?.type !== "oauth") {
				await context.publish({
					update: () => {
						models = baseline;
						visibleIds = undefined;
					},
				});
				return;
			}
			const id = accountId(credential.access);
			const fingerprint = await accountFingerprint(id);
			const stored = context.stored as Partial<CodexStoredCatalog> | undefined;
			const matching =
				stored?.catalogSource === CODEX_CATALOG_URL &&
				stored.catalogAccount === fingerprint &&
				Array.isArray(stored.catalogVisibleIds) &&
				Array.isArray(stored.models) &&
				stored.models.length > 0;
			const restored = matching
				? stored.models!.filter(
						(model): model is CodexModel =>
							model.provider === provider.id &&
							model.api === "openai-codex-responses" &&
							isModelType(model, "chat"),
					)
				: baseline;
			if (
				!(await context.publish({
					update: () => {
						models = [...restored];
						visibleIds = matching ? stored.catalogVisibleIds : undefined;
					},
				}))
			)
				return;
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				matching &&
				stored.checkedAt !== undefined &&
				Date.now() - stored.checkedAt < CODEX_CATALOG_REFRESH_MS
			)
				return;
			const url = new URL(CODEX_CATALOG_URL);
			url.searchParams.set("client_version", CODEX_CATALOG_CLIENT_VERSION);
			let response: Response;
			try {
				response = await fetch(url, {
					headers: {
						Authorization: `Bearer ${credential.access}`,
						"ChatGPT-Account-Id": id,
						originator: "codex_cli_rs",
						"User-Agent": `codex_cli_rs/${CODEX_CATALOG_CLIENT_VERSION}`,
						Accept: "application/json",
						...(matching && stored.etag ? { "If-None-Match": stored.etag } : {}),
					},
					redirect: "error",
					signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
				});
			} catch {
				if (context.signal.aborted) return;
				throw new Error("Official Codex catalog is unavailable; retaining offline model metadata");
			}
			if (context.signal.aborted) return;
			if (response.status === 304 && matching) {
				await context.publish({ persist: { ...stored, models: restored, checkedAt: Date.now() } });
				return;
			}
			if (!response.ok) throw new Error(`Official Codex catalog request failed: HTTP ${response.status}`);
			let metadata: CodexCatalogModel[];
			try {
				metadata = parseCodexCatalog(await response.json());
			} catch {
				if (context.signal.aborted) return;
				throw new Error("Invalid official Codex model catalog; retaining offline model metadata");
			}
			if (context.signal.aborted) return;
			const refreshed = applyCodexCatalog(baseline, metadata);
			const entry: CodexStoredCatalog = {
				models: refreshed,
				checkedAt: Date.now(),
				etag: response.headers.get("etag") ?? undefined,
				catalogSource: CODEX_CATALOG_URL,
				catalogAccount: fingerprint,
				catalogVisibleIds: metadata.filter((model) => model.visibility !== "hide").map((model) => model.id),
			};
			await context.publish({
				persist: entry,
				update: () => {
					models = refreshed;
					visibleIds = entry.catalogVisibleIds;
				},
			});
		},
	};
}
