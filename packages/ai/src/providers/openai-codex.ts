import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";
import { withOfficialCodexCatalog } from "./openai-codex-catalog.ts";

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return withOfficialCodexCatalog(
		createProvider({
			id: "openai-codex",
			name: "OpenAI Codex (legacy)",
			baseUrl: "https://chatgpt.com/backend-api",
			auth: {
				oauth: lazyOAuth({
					name: "OpenAI (ChatGPT Plus/Pro)",
					isSubscription: true,
					load: loadOpenAICodexOAuth,
				}),
			},
			models: Object.values(OPENAI_CODEX_MODELS),
			api: openAICodexResponsesApi(),
		}),
	);
}
