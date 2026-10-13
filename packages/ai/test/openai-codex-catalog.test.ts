import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffortThinkingLevelMap } from "../scripts/models-dev-reasoning-options.ts";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "../src/models.ts";
import type { ModelsStoreEntry } from "../src/models-store.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import {
	applyCodexCatalog,
	CODEX_CATALOG_FALLBACK,
	CODEX_CATALOG_URL,
	type CodexStoredCatalog,
	parseCodexCatalog,
} from "../src/providers/openai-codex-catalog.ts";
import type { Model } from "../src/types.ts";

type CodexModel = Model<"openai-codex-responses">;

function catalog(slug = "gpt-6.1-sol", contextWindow = 500000, visibility = "list") {
	return {
		models: [
			{
				slug,
				display_name: slug,
				context_window: contextWindow,
				max_context_window: 872000,
				input_modalities: ["text", "image"],
				supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({
					effort,
				})),
				default_reasoning_level: "low",
				supports_search_tool: true,
				visibility,
				base_instructions: "PRIVATE NATIVE INSTRUCTIONS",
				other_unknown_metadata: true,
			},
		],
	};
}

function token(id = "synthetic-account") {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
}

function refreshContext(stored?: ModelsStoreEntry, overrides: Partial<RefreshModelsContext> = {}) {
	const publications: ModelsPublication[] = [];
	const context: RefreshModelsContext = {
		credential: { type: "oauth", access: token(), refresh: "synthetic-refresh", expires: Date.now() + 3600000 },
		stored,
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publications.push(publication);
			publication.update?.();
			return true;
		},
		...overrides,
	};
	return { context, publications };
}

async function loadCatalog(provider: Provider<"openai-codex-responses"> = openaiCodexProvider()) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(catalog()), { headers: { etag: '"official-1"' } })),
	);
	const { context, publications } = refreshContext();
	await provider.refreshModels?.(context);
	return publications.find((publication) => publication.persist)?.persist as CodexStoredCatalog;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("official Codex model metadata", () => {
	it("retains explicitly advertised ultra effort from other source catalogs", () => {
		expect(getEffortThinkingLevelMap([{ type: "effort", values: ["ultra"] }])?.ultra).toBe("ultra");
		expect(getEffortThinkingLevelMap([{ type: "effort", values: ["high"] }])?.ultra).toBeUndefined();
	});
	it("keeps the default separate from the configurable maximum for every fallback entry", () => {
		const models = openaiCodexProvider().getModels();
		for (const official of CODEX_CATALOG_FALLBACK) {
			const model = models.find((model) => model.id === official.id);
			expect(model).toMatchObject({
				contextWindow: official.contextWindow,
				maxContextWindow: official.maxContextWindow,
				defaultThinkingLevel: official.defaultReasoningLevel,
			});
			expect(getSupportedThinkingLevels(model!)).toEqual(official.reasoningLevels);
			expect(model?.inputLimits?.images?.resize).toEqual({
				maxWidth: 2000,
				maxHeight: 2000,
				maxBytes: 4718592,
				jpegQuality: 80,
			});
		}
		expect(models.find((model) => model.id === "gpt-6.1-sol")?.contextWindow).toBe(500000);
		expect(models.find((model) => model.id === "gpt-6-luna")?.contextWindow).toBe(272000);
		expect(models.find((model) => model.id === "gpt-5.5")?.maxContextWindow).toBe(272000);
	});

	it("parses only model metadata, without retaining upstream prompts", () => {
		const parsed = parseCodexCatalog(catalog());
		expect(parsed[0]).toMatchObject({
			contextWindow: 500000,
			maxContextWindow: 872000,
			defaultReasoningLevel: "low",
		});
		expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
		expect(JSON.stringify(parsed)).not.toContain("other_unknown_metadata");
	});

	it.each([
		{},
		{ models: [] },
		{ models: [{ ...catalog().models[0], context_window: -1 }] },
		{ models: [{ ...catalog().models[0], max_context_window: 1000 }] },
		{ models: [catalog().models[0], catalog().models[0]] },
		{ models: [{ ...catalog().models[0], input_modalities: ["audio"] }] },
		{ models: [{ ...catalog().models[0], supported_reasoning_levels: [{}] }] },
	])("rejects malformed official catalogs", (value) => {
		expect(() => parseCodexCatalog(value)).toThrow();
	});

	it("uses the default as the maximum when upstream does not advertise an expansion", () => {
		expect(
			parseCodexCatalog({ models: [{ ...catalog().models[0], max_context_window: null }] })[0].maxContextWindow,
		).toBe(500000);
	});

	it("preserves unrelated limits and prices and discovers new model IDs", () => {
		const before = openaiCodexProvider()
			.getModels()
			.find((model) => model.id === "gpt-6.1-sol")!;
		const baseline: CodexModel = {
			...before,
			maxTokens: 128000,
			cost: {
				input: 9,
				output: 12,
				cacheRead: 1,
				cacheWrite: 2,
				tiers: [{ inputTokensAbove: 272000, input: 18, output: 24, cacheRead: 2, cacheWrite: 4 }],
			},
		};
		const snapshot = structuredClone(baseline);
		const metadata = parseCodexCatalog({ models: [...catalog().models, ...catalog("future-codex", 600000).models] });
		const updated = applyCodexCatalog([baseline], metadata);
		expect(updated[0].cost).toEqual(snapshot.cost);
		expect(updated[0].maxTokens).toBe(128000);
		expect(updated[1]).toMatchObject({
			id: "future-codex",
			contextWindow: 600000,
			maxContextWindow: 872000,
			maxTokens: 16384,
			inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
		});
		expect(baseline).toEqual(snapshot);
	});

	it("preserves configured image limits and fills only missing resize defaults", () => {
		const before = openaiCodexProvider()
			.getModels()
			.find((model) => model.id === "gpt-6.1-sol")!;
		const baseline: CodexModel = {
			...before,
			inputLimits: {
				maxRequestBytes: 1000000,
				images: { maxPerRequest: 3, resize: { maxWidth: 1200, jpegQuality: 60 } },
			},
		};
		const snapshot = structuredClone(baseline);
		const [updated] = applyCodexCatalog([baseline], parseCodexCatalog(catalog()));
		expect(updated.inputLimits).toEqual({
			maxRequestBytes: 1000000,
			images: {
				maxPerRequest: 3,
				resize: { maxWidth: 1200, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 60 },
			},
		});
		expect(baseline).toEqual(snapshot);
	});

	it("does not add image preprocessing to a new text-only model", () => {
		const metadata = parseCodexCatalog({
			models: [{ ...catalog("text-codex").models[0], input_modalities: ["text"] }],
		});
		expect(applyCodexCatalog([], metadata)[0].inputLimits).toBeUndefined();
	});

	it("enables ultra only on models explicitly advertising it", () => {
		const models = openaiCodexProvider().getModels();
		const sol = models.find((model) => model.id === "gpt-6.1-sol")!;
		const luna = models.find((model) => model.id === "gpt-6-luna")!;
		expect(clampThinkingLevel(sol, "ultra")).toBe("ultra");
		expect(clampThinkingLevel(luna, "ultra")).toBe("max");
		expect(getSupportedThinkingLevels(luna)).not.toContain("ultra");
	});
});

describe("account-scoped Codex discovery", () => {
	it("queries only the official authenticated endpoint and persists sanitized metadata", async () => {
		const stored = await loadCatalog();
		const [url, options] = vi.mocked(fetch).mock.calls[0];
		expect(String(url)).toBe(`${CODEX_CATALOG_URL}?client_version=0.162.1`);
		expect(new Headers(options?.headers).get("ChatGPT-Account-Id")).toBe("synthetic-account");
		expect(options?.redirect).toBe("error");
		expect(stored.catalogAccount).toMatch(/^[0-9a-f]{64}$/);
		for (const privateValue of [token(), "synthetic-account", "synthetic-refresh", "PRIVATE NATIVE INSTRUCTIONS"])
			expect(JSON.stringify(stored)).not.toContain(privateValue);
	});

	it("restores account cache offline and does not call the network", async () => {
		const stored = await loadCatalog();
		stored.models = stored.models.map((model) =>
			model.id === "gpt-6.1-sol" ? { ...model, contextWindow: 550000 } : model,
		);
		const provider = openaiCodexProvider();
		vi.mocked(fetch).mockClear();
		await provider.refreshModels?.(refreshContext(stored, { allowNetwork: false }).context);
		expect(provider.getModels().find((model) => model.id === "gpt-6.1-sol")?.contextWindow).toBe(550000);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("restores image preparation for cached discovery without changing account metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(catalog("future-codex", 600000)))),
		);
		const { context, publications } = refreshContext();
		await openaiCodexProvider().refreshModels?.(context);
		const stored = publications.find((publication) => publication.persist)?.persist as CodexStoredCatalog;
		stored.models = stored.models.map((model) => ({ ...model, inputLimits: undefined }));
		const snapshot = structuredClone(stored);
		const provider = openaiCodexProvider();
		vi.mocked(fetch).mockClear();
		await provider.refreshModels?.(refreshContext(stored, { allowNetwork: false }).context);
		expect(provider.getModels().find((model) => model.id === "future-codex")).toMatchObject({
			contextWindow: 600000,
			inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
		});
		expect(stored).toEqual(snapshot);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("ignores stale pi.dev cache and another account's catalog", async () => {
		const stored = await loadCatalog();
		for (const entry of [
			{ ...stored, catalogAccount: "another-account" },
			{ models: stored.models, checkedAt: Date.now() },
		]) {
			const provider = openaiCodexProvider();
			await provider.refreshModels?.(refreshContext(entry, { allowNetwork: false }).context);
			expect(provider.getModels().find((model) => model.id === "gpt-6.1-sol")?.contextWindow).toBe(500000);
		}
	});

	it("respects freshness and forced refresh with ETag validation", async () => {
		const stored = await loadCatalog();
		const provider = openaiCodexProvider();
		vi.mocked(fetch).mockClear();
		await provider.refreshModels?.(refreshContext(stored).context);
		expect(fetch).not.toHaveBeenCalled();
		vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 304 }));
		const { context, publications } = refreshContext(stored, { force: true });
		await provider.refreshModels?.(context);
		expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("If-None-Match")).toBe('"official-1"');
		expect(publications.find((publication) => publication.persist)?.persist).toMatchObject({
			catalogAccount: stored.catalogAccount,
			models: stored.models,
		});
	});

	it("retains the last account catalog when upstream fails, without exposing response bodies", async () => {
		const stored = await loadCatalog();
		const provider = openaiCodexProvider();
		vi.mocked(fetch).mockImplementation(async () => new Response("PRIVATE ERROR BODY", { status: 503 }));
		await expect(provider.refreshModels?.(refreshContext(stored, { force: true }).context)).rejects.toThrow(
			"HTTP 503",
		);
		expect(provider.getModels()).toEqual(stored.models);
	});

	it("does not publish malformed responses or network error details", async () => {
		const provider = openaiCodexProvider();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(`PRIVATE ${token()}`);
			}),
		);
		await expect(provider.refreshModels?.(refreshContext().context)).rejects.toThrow(
			"retaining offline model metadata",
		);
		vi.mocked(fetch).mockImplementation(async () => new Response("PRIVATE INVALID JSON"));
		const { context, publications } = refreshContext();
		await expect(provider.refreshModels?.(context)).rejects.toThrow("Invalid official Codex model catalog");
		expect(publications.some((publication) => publication.persist)).toBe(false);
	});

	it("keeps hidden models addressable but out of the advertised account selection", async () => {
		const provider = openaiCodexProvider();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ models: [...catalog().models, ...catalog("hidden-codex", 272000, "hide").models] }),
					),
			),
		);
		await provider.refreshModels?.(refreshContext().context);
		expect(provider.getModels().some((model) => model.id === "hidden-codex")).toBe(true);
		expect(provider.filterModels?.(provider.getModels(), undefined).map((model) => model.id)).toEqual([
			"gpt-6.1-sol",
		]);
	});

	it("honors cancellation and rejected publications", async () => {
		const provider = openaiCodexProvider();
		vi.stubGlobal("fetch", vi.fn());
		const controller = new AbortController();
		controller.abort();
		await provider.refreshModels?.(refreshContext(undefined, { signal: controller.signal }).context);
		await provider.refreshModels?.(refreshContext(undefined, { publish: async () => false }).context);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not fetch without OAuth and reports invalid routing without exposing tokens", async () => {
		const provider = openaiCodexProvider();
		vi.stubGlobal("fetch", vi.fn());
		await provider.refreshModels?.(refreshContext(undefined, { credential: undefined }).context);
		await expect(
			provider.refreshModels?.(
				refreshContext(undefined, {
					credential: { type: "oauth", access: "PRIVATE INVALID TOKEN", refresh: "private", expires: 0 },
				}).context,
			),
		).rejects.toThrow("Codex OAuth account routing is unavailable");
		expect(fetch).not.toHaveBeenCalled();
	});
});
