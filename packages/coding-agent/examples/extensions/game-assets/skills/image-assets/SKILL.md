---
name: image-assets
description: Create or edit game reference images, UI icons, decals and texture candidates using already available Codex image tools or Pi image models such as Gemini and FLUX through OpenRouter. Reuse native image calls instead of installing another image wrapper.
---

# Image assets

This skill adds workflow guidance, not a new image API or credentials. Keep the current chat model and local file tools. Use the user's authorized image backend and budget.

## Discover existing capabilities

If `codex_image` is available, inspect its tool schema. It uses `/login openai-codex` subscription credentials, not an OpenAI API key or the independent `openai` OAuth login. This package does not install or copy that extension.

For Pi image models, use codemode:

```js
const available = await models.getAvailableOfType("image");
text(available.map(({ provider, id, input }) => ({ provider, id, input })));
```

Pi supports image models through OpenRouter, including Google Gemini and BFL FLUX entries when present in the catalog/account. OpenRouter is the access channel, not a new model maker. Availability is not an authorization to spend. If codemode is disabled, add `+codemode` to the existing `defaultTools` configuration, preserving other entries; do not replace the tool set.

## Generate or edit

For a configured `codex_image`, use its actual parameters, including `referenced_image_paths`, `size`, `quality`, `background` and `outputPath`. A codemode example after tool discovery and authorization:

```js
// @options: {"timeout_ms": 300000}
const result = await tools.codex_image({
  prompt: "A readable game inventory icon of a brass key, matching the supplied reference style.",
  referenced_image_paths: ["/absolute/project/art/style-reference.png"],
  background: "transparent",
  size: "1024x1024",
  quality: "high",
  outputPath: "/absolute/project/art/key-candidate-01.png"
});
image(result.image_url);
if (result.output_hint) text(result.output_hint);
```

For a selected Pi image model, substitute the provider/id discovered above:

```js
// @options: {"timeout_ms": 300000}
const model = await models.getModelOfType("image", "openrouter", "CHOSEN_MODEL_ID");
if (!model) throw new Error("Selected image model is not registered");
const reference = await tools.read({ path: "/absolute/project/art/style-reference.png" });
const result = await models.generateImages(model, {
  input: [{ type: "text", text: "Create a brass-key inventory icon in this visual style." }, reference]
});
if (result.stopReason !== "stop") throw new Error(result.errorMessage || result.stopReason);
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

`image()` displays an image and returns its saved temporary path in the tool result; copy the required original file into the project. Do not print or store base64 in a conversation. Preserve the selected model and its reported usage in the work record.

Pi's current `generateImages` context exposes prompt/reference blocks, not every provider-specific quality, mask, seed or resolution option. Do not invent such fields or claim a prompt guarantees them. When exact controls are needed, use an already available native tool that exposes them (such as the supported Codex parameters), or explicitly add the needed backend rather than silently ignoring settings. This package does not add direct OpenAI Images, Gemini or BFL REST clients.

## Existing local models

If the user has a prepared local image model, invoke its native CLI/Python or existing service with the current Bash tools. Preserve its own reference, mask, device and quality options. No new local inference wrapper or remote-assets profile is needed. This package does not install or implement Qwen-Image or other candidate local backends; availability and GPU compatibility must be established in the actual authorized environment.

## Inspect in context

Use common style/subject references when consistency matters. Make local edits rather than regenerating everything when only one region is wrong. Check icon readability at actual UI size; inspect alpha/blend mode, color space and UV placement in-engine. An attractive picture is not automatically a PBR material set, a consistent multiview reconstruction or a seamless texture. Compare resulting files in the actual game before choosing another paid call.
