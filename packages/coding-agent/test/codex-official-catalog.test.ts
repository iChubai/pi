import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidThinkingLevel, parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const directories: string[] = [];

function credentials() {
	const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
	const storage = AuthStorage.inMemory({
		"openai-codex": { type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3600000 },
	});
	return { storage, access };
}

function directory() {
	const path = mkdtempSync(join(tmpdir(), "pi-official-codex-"));
	directories.push(path);
	return path;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("official Codex catalog integration", () => {
	it("ignores stale pi.dev windows at startup and uses the default for compaction", async () => {
		const store = new InMemoryCodingAgentModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: credentials().storage,
			modelsPath: null,
			modelsStore: store,
			allowModelNetwork: false,
		});
		const before = runtime.getModel("openai-codex", "gpt-6.1-sol")!;
		await store.write("openai-codex", {
			models: [{ ...before, contextWindow: 272000 }],
			checkedAt: Date.now(),
			lastModified: Date.now(),
		});
		await runtime.refresh({ providers: ["openai-codex"], allowNetwork: false });
		const sol = runtime.getModel("openai-codex", "gpt-6.1-sol")!;
		expect(sol.contextWindow).toBe(500000);
		expect(sol.maxContextWindow).toBe(872000);
		expect(shouldCompact(300000, sol.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(500000, sol.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
		expect(
			shouldCompact(
				300000,
				runtime.getModel("openai-codex", "gpt-6-luna")!.contextWindow,
				DEFAULT_COMPACTION_SETTINGS,
			),
		).toBe(true);
	});

	it("refreshes native account metadata instead of calling pi.dev", async () => {
		const store = new InMemoryCodingAgentModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: credentials().storage,
			modelsPath: null,
			modelsStore: store,
			allowModelNetwork: false,
		});
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			expect(String(input)).toContain("https://chatgpt.com/backend-api/codex/models?");
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-6.1-sol",
							display_name: "GPT-6.1-Sol",
							context_window: 550000,
							max_context_window: 872000,
							input_modalities: ["text", "image"],
							supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({
								effort,
							})),
							default_reasoning_level: "low",
							visibility: "list",
						},
					],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = await runtime.refresh({ providers: ["openai-codex"], force: true, allowNetwork: true });
		expect(result.errors.size).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(runtime.getModel("openai-codex", "gpt-6.1-sol")?.contextWindow).toBe(550000);
		expect((await runtime.getAvailable("openai-codex")).map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
	});

	it("preserves explicit model overrides and ultra sampling parameters", async () => {
		const modelsPath = join(directory(), "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						modelOverrides: {
							"gpt-6.1-sol": {
								contextWindow: 700000,
								defaultThinkingLevel: "high",
								samplingParamsByThinkingLevel: { ultra: { temperature: 0.7 } },
							},
						},
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: credentials().storage,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		});
		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getModel("openai-codex", "gpt-6.1-sol")).toMatchObject({
			contextWindow: 700000,
			maxContextWindow: 872000,
			defaultThinkingLevel: "high",
			samplingParamsByThinkingLevel: { ultra: { temperature: 0.7 } },
		});
	});

	it("uses the official reasoning default only when no user preference exists", async () => {
		const runtime = await ModelRuntime.create({
			credentials: credentials().storage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		const options = {
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "openai-codex",
			defaultModelId: "gpt-6.1-sol",
			modelRuntime: runtime,
		};
		expect((await findInitialModel(options)).thinkingLevel).toBe("low");
		expect((await findInitialModel({ ...options, defaultThinkingLevel: "high" })).thinkingLevel).toBe("high");
		expect(
			(await findInitialModel({ ...options, modelThinkingLevels: { "openai-codex/gpt-6.1-sol": "ultra" } }))
				.thinkingLevel,
		).toBe("ultra");
	});

	it("accepts ultra in CLI, settings, and the model-aware selector", async () => {
		expect(isValidThinkingLevel("ultra")).toBe(true);
		expect(parseArgs(["--thinking", "ultra"]).thinking).toBe("ultra");
		const settings = SettingsManager.inMemory();
		settings.setDefaultThinkingLevel("ultra");
		await settings.flush();
		expect(settings.getDefaultThinkingLevel()).toBe("ultra");
		initTheme("dark");
		const selector = new ThinkingSelectorComponent(
			"ultra",
			["high", "max", "ultra"],
			() => {},
			() => {},
		);
		expect(selector.getSelectList().getSelectedItem()?.value).toBe("ultra");
		expect(theme.getThinkingBorderColor("ultra")("border")).toBe(theme.getThinkingBorderColor("max")("border"));
	});

	it("sends ultra unchanged to Codex without making a model request", async () => {
		const { access } = credentials();
		vi.stubGlobal("fetch", vi.fn());
		const onPayload = vi.fn(() => {
			throw new Error("synthetic stop before dispatch");
		});
		const response = await streamSimple(
			openaiCodexProvider()
				.getModels()
				.find((model) => model.id === "gpt-6.1-sol")!,
			normalizeContext({ systemPrompt: "test", messages: [] }),
			{
				apiKey: access,
				reasoning: "ultra",
				onPayload,
				transport: "sse",
				maxRetries: 0,
			},
		).result();
		expect(response.stopReason).toBe("error");
		expect(onPayload).toHaveBeenCalledWith(
			expect.objectContaining({ reasoning: expect.objectContaining({ effort: "ultra" }) }),
			expect.anything(),
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
