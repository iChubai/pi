import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, type JsonObject } from "@earendil-works/pi-ai";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexImageExtension from "../../examples/extensions/codex-image.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

function pngImage(width = 1, height = 1, shade = 255): string {
	const image = new PhotonImage(new Uint8Array(width * height * 4).fill(shade), width, height);
	try {
		return Buffer.from(image.get_bytes()).toString("base64");
	} finally {
		image.free();
	}
}

const PNG = pngImage();
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;

async function createImageHarness(withAuth = true, options: HarnessOptions = {}): Promise<Harness> {
	const harness = await createHarness({
		...options,
		extensionFactories: [codexImageExtension, ...(options.extensionFactories ?? [])],
		settings: { images: { autoResize: false }, ...options.settings },
	});
	if (withAuth) {
		await harness.authStorage.modify("openai-codex", async () => ({
			type: "oauth",
			access: token,
			refresh: "test-refresh",
			expires: Date.now() + 3_600_000,
		}));
	}
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("codex_image", { prompt: "A red square", outputPath: join(harness.tempDir, "image.png") })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	return harness;
}

async function requestImage(harness: Harness, params: JsonObject = {}, images?: ImageContent[]) {
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("codex_image", { prompt: "Edit the image", outputPath: "image.png", ...params })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Generate or edit an image", { images });
	return getToolResult(harness, "codex_image");
}

function appendGeneratedPreview(harness: Harness, preview: string, path: string, original: string): string {
	return harness.sessionManager.appendMessage({
		role: "toolResult",
		toolName: "codex_image",
		toolCallId: "previous-generation",
		content: [{ type: "image", data: preview, mimeType: "image/png" }],
		details: { path, originalSha256: createHash("sha256").update(Buffer.from(original, "base64")).digest("hex") },
		isError: false,
		timestamp: Date.now(),
	});
}

describe("Codex subscription image extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("uses pi's Codex OAuth credentials, saves the PNG, and returns an image to the agent", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json(
				{ created: 1, background: "opaque", data: [{ b64_json: PNG, generation_id: "generation-1" }] },
				{
					headers: { "x-codex-imagegen-request-id": "request-1" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);

		await harness.session.prompt("Generate an image");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(options?.method).toBe("POST");
		expect(options?.redirect).toBe("error");
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		const headers = new Headers(options?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("chatgpt-account-id")).toBe("test-account");
		expect(headers.get("originator")).toBe("pi");
		expect(headers.get("x-codex-image-turn-id")).toBeTruthy();
		expect(JSON.parse(String(options?.body))).toEqual({
			model: "gpt-image-2",
			prompt: "A red square",
			n: 1,
			size: "auto",
			quality: "auto",
			background: "opaque",
		});
		const result = getToolResult(harness, "codex_image");
		expect(result.isError).toBe(false);
		expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
		expect(result.details).toMatchObject({
			status: "completed",
			operation: "generate",
			model: "gpt-image-2",
			requestId: "request-1",
			generationId: "generation-1",
			transparentBackground: false,
			referencedImages: 0,
		});
		expect(harness.eventsOfType("tool_execution_update")[0]?.partialResult).toMatchObject({
			details: { status: "in_progress", operation: "generate" },
		});
		expect(await readFile(join(harness.tempDir, "image.png"))).toEqual(Buffer.from(PNG, "base64"));
		expect((await stat(join(harness.tempDir, "image.png"))).mode & 0o777).toBe(0o600);
	});

	it("saves to pi's agent directory when no output path is specified", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] })),
		);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codex_image", { prompt: "A red square" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Generate an image");

		const imagesDir = join(agentDir, "generated-images");
		const files = await readdir(imagesDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.png$/);
		expect(await readFile(join(imagesDir, files[0]!))).toEqual(Buffer.from(PNG, "base64"));
	});

	it("honors requested image options and paths relative to the working directory", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codex_image", {
						prompt: " A logo ",
						outputPath: "art/logo.png",
						quality: "high",
						size: "1536x1024",
						background: "transparent",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Generate a transparent logo");

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			prompt: "A logo",
			quality: "high",
			size: "1536x1024",
			background: "transparent",
		});
		expect(existsSync(join(harness.tempDir, "art/logo.png"))).toBe(true);
	});

	it.each<JsonObject>([
		{ prompt: " ", outputPath: "image.png" },
		{ prompt: "A red square", outputPath: "image.jpg" },
		{ prompt: "A red square", referenced_image_paths: Array.from({ length: 6 }, () => "reference.png") },
		{ prompt: "A red square", referenced_image_paths: [" "] },
		{ prompt: "A red square", num_last_images_to_include: 0 },
		{ prompt: "A red square", num_last_images_to_include: 6 },
		{ prompt: "A red square", num_last_images_to_include: 1.5 },
		{ prompt: "A red square", referenced_image_paths: ["reference.png"], num_last_images_to_include: 1 },
		{ prompt: "A red square", transparent_background: true, background: "opaque" },
		{ prompt: "A red square", unexpected_field: true },
	])("rejects invalid input before making a generation request: %j", async (params) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codex_image", params)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Generate an image");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(getToolResult(harness, "codex_image").isError).toBe(true);
	});

	it("rejects an unusable destination before making a generation request", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		await writeFile(join(harness.tempDir, "blocked"), "existing file");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codex_image", { prompt: "A red square", outputPath: "blocked/image.png" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Generate an image");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(getToolResult(harness, "codex_image").isError).toBe(true);
	});

	it("requires Codex OAuth instead of falling back to an OpenAI API key", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv("OPENAI_API_KEY", "must-not-be-used");
		const harness = await createImageHarness(false);
		harnesses.push(harness);

		await harness.session.prompt("Generate an image");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(getToolResult(harness, "codex_image").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "codex_image"))).toContain("/login openai-codex");
	});

	it.each(["bad-token", `header.${Buffer.from("{}").toString("base64url")}.signature`])(
		"rejects credentials without a ChatGPT account claim: %s",
		async (access) => {
			const fetchMock = vi.fn<typeof fetch>();
			vi.stubGlobal("fetch", fetchMock);
			const harness = await createImageHarness();
			harnesses.push(harness);
			await harness.authStorage.modify("openai-codex", async () => ({
				type: "oauth",
				access,
				refresh: "test-refresh",
				expires: Date.now() + 3_600_000,
			}));

			await harness.session.prompt("Generate an image");

			expect(fetchMock).not.toHaveBeenCalled();
			expect(getToolResult(harness, "codex_image").isError).toBe(true);
		},
	);

	it.each([403, 429, 503])("reports HTTP %s without retrying or creating an image file", async (status) => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json({ error: { message: "image access unavailable" } }, { status }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);

		await harness.session.prompt("Generate an image");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getToolResult(harness, "codex_image").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "codex_image"))).toContain(`(${status})`);
		expect(existsSync(join(harness.tempDir, "image.png"))).toBe(false);
	});

	it.each([
		{},
		{ data: [] },
		{ data: [{ b64_json: PNG }, { b64_json: PNG }] },
		{ data: [{ b64_json: "not base64" }] },
		{ data: [{ b64_json: Buffer.from("not a PNG").toString("base64") }] },
	])("rejects malformed image responses without writing a file: %j", async (body) => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => Response.json(body)),
		);
		const harness = await createImageHarness();
		harnesses.push(harness);

		await harness.session.prompt("Generate an image");

		expect(getToolResult(harness, "codex_image").isError).toBe(true);
		expect(existsSync(join(harness.tempDir, "image.png"))).toBe(false);
	});

	it.each([false, true])("does not overwrite an existing file or symlink (symlink: %s)", async (useSymlink) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const target = join(harness.tempDir, "original.png");
		const output = join(harness.tempDir, "image.png");
		await writeFile(target, "existing image");
		if (useSymlink) await symlink(target, output);
		else await writeFile(output, "existing image");

		await harness.session.prompt("Generate an image");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(getToolResult(harness, "codex_image").isError).toBe(true);
		expect(await readFile(output, "utf8")).toBe("existing image");
	});

	it.each([false, true])("maps transparent_background=%s to the Codex background option", async (transparent) => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json({
				background: transparent ? "transparent" : "opaque",
				data: [{ b64_json: PNG }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);

		const result = await requestImage(harness, { transparent_background: transparent });

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).background).toBe(
			transparent ? "transparent" : "opaque",
		);
		expect(result.details).toMatchObject({ transparentBackground: transparent });
	});

	it("edits an original local PNG without resizing or overwriting the reference", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json(
				{
					background: "transparent",
					data: [{ b64_json: PNG, generation_id: "edited-generation" }],
				},
				{ headers: { "x-codex-imagegen-request-id": "edit-request" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const original = pngImage(64, 32, 128);
		const referencePath = join(harness.tempDir, "reference.png");
		await writeFile(referencePath, Buffer.from(original, "base64"));

		const result = await requestImage(harness, {
			referenced_image_paths: ["reference.png"],
			transparent_background: true,
			quality: "high",
			size: "1536x1024",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			model: "gpt-image-2",
			prompt: "Edit the image",
			n: 1,
			background: "transparent",
			size: "1536x1024",
			quality: "high",
			images: [{ image_url: `data:image/png;base64,${original}` }],
		});
		expect(result.isError).toBe(false);
		expect(result.details).toMatchObject({
			operation: "edit",
			referencedImages: 1,
			generationId: "edited-generation",
			requestId: "edit-request",
		});
		expect(harness.eventsOfType("tool_execution_update")[0]?.partialResult).toMatchObject({
			details: { status: "in_progress", operation: "edit", referencedImages: 1 },
		});
		expect(await readFile(referencePath)).toEqual(Buffer.from(original, "base64"));
		expect(await readFile(join(harness.tempDir, "image.png"))).toEqual(Buffer.from(PNG, "base64"));
	});

	it("keeps all five local references in their requested order", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const references = Array.from({ length: 5 }, (_, i) => pngImage(1, 1, i * 40));
		const paths = references.map((_, i) => join(harness.tempDir, `reference-${i}.png`));
		await Promise.all(paths.map((path, i) => writeFile(path, Buffer.from(references[i]!, "base64"))));

		await requestImage(harness, { referenced_image_paths: paths });

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toEqual(
			references.map((data) => ({ image_url: `data:image/png;base64,${data}` })),
		);
	});

	it.each(["jpeg", "webp"])("preserves original %s reference bytes", async (format) => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
		let bytes: Buffer;
		try {
			bytes = Buffer.from(format === "jpeg" ? image.get_bytes_jpeg(90) : image.get_bytes_webp());
		} finally {
			image.free();
		}
		await writeFile(join(harness.tempDir, `reference.${format}`), bytes);

		await requestImage(harness, { referenced_image_paths: [`reference.${format}`] });

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/${format};base64,${bytes.toString("base64")}` },
		]);
	});

	it("converts GIF references to PNG as Codex does", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";
		await writeFile(join(harness.tempDir, "reference.gif"), Buffer.from(gif, "base64"));

		const result = await requestImage(harness, { referenced_image_paths: ["reference.gif"] });

		expect(result.isError).toBe(false);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body.images[0].image_url).toMatch(/^data:image\/png;base64,/);
		const image = PhotonImage.new_from_byteslice(Buffer.from(body.images[0].image_url.split(",")[1], "base64"));
		try {
			expect([image.get_width(), image.get_height()]).toEqual([1, 1]);
		} finally {
			image.free();
		}
	});

	it.each(["missing", "invalid", "oversized", "directory"])(
		"rejects a %s reference before sending a request",
		async (kind) => {
			const fetchMock = vi.fn<typeof fetch>();
			vi.stubGlobal("fetch", fetchMock);
			const harness = await createImageHarness();
			harnesses.push(harness);
			const path = join(harness.tempDir, "reference.png");
			if (kind === "invalid") {
				await writeFile(path, "not an image");
				vi.spyOn(PhotonImage, "new_from_byteslice").mockImplementation(() => {
					throw new Error("Invalid image");
				});
			} else if (kind === "oversized") {
				await writeFile(path, "");
				await truncate(path, 1024 * 1024 * 1024 + 1);
			}

			const result = await requestImage(harness, {
				referenced_image_paths: [kind === "directory" ? harness.tempDir : path],
			});

			expect(result.isError).toBe(true);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(existsSync(join(harness.tempDir, "image.png"))).toBe(false);
		},
	);

	it("treats an empty path list as generation", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);

		await requestImage(harness, { referenced_image_paths: [] });

		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("images");
	});

	it.each([4, 5])(
		"selects the last %s images across user, tool, custom, and current input messages in order",
		async (count) => {
			const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
			vi.stubGlobal("fetch", fetchMock);
			const harness = await createImageHarness();
			harnesses.push(harness);
			const images: ImageContent[] = Array.from({ length: 5 }, (_, i) => ({
				type: "image",
				data: pngImage(1, 1, i * 40),
				mimeType: "image/png",
			}));
			harness.sessionManager.appendMessage({ role: "user", content: images.slice(0, 2), timestamp: Date.now() });
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "read-reference",
				toolName: "read",
				content: [images[2]!],
				isError: false,
				timestamp: Date.now(),
			});
			harness.sessionManager.appendCustomMessageEntry("reference", [images[3]!], false);

			const result = await requestImage(harness, { referenced_image_paths: [], num_last_images_to_include: count }, [
				images[4]!,
			]);

			expect(result.isError).toBe(false);
			expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/images/edits");
			expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toEqual(
				images.slice(-count).map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
			);
		},
	);

	it("fails rather than silently using fewer recent images", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);

		const result = await requestImage(harness, { num_last_images_to_include: 1 });

		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("only 0 were available");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["hidden", "compacted", "abandoned"])("does not select images from %s context", async (kind) => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const root = harness.sessionManager.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
		const old = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "image", data: PNG, mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		if (kind === "hidden") harness.sessionManager.appendContextEdit(old, null);
		else if (kind === "compacted") harness.sessionManager.appendCompaction("Earlier image", null, 100);
		else harness.sessionManager.branch(root);
		const visible = pngImage(1, 1, 100);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "image", data: visible, mimeType: "image/png" }],
			timestamp: Date.now(),
		});

		const result = await requestImage(harness, { num_last_images_to_include: 2 });
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("only 1 were available");
		expect(fetchMock).not.toHaveBeenCalled();

		await requestImage(harness, { num_last_images_to_include: 1 });
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/png;base64,${visible}` },
		]);
	});

	it("uses the saved original, not a resized tool preview, for follow-up editing", async () => {
		const original = pngImage(64, 64);
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: original }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness(true, { settings: { images: { autoResize: true } } });
		harnesses.push(harness);
		if (!harness.session.model) throw new Error("Expected a model");
		harness.session.model.inputLimits = { images: { resize: { maxWidth: 16, maxHeight: 16 } } };
		const first = await requestImage(harness, { outputPath: "original.png" });
		const preview = first.content.find((block) => block.type === "image");
		expect(preview?.data).not.toBe(original);

		await requestImage(harness, { num_last_images_to_include: 1 });

		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/png;base64,${original}` },
		]);
	});

	it.each(["missing", "changed"])("falls back to the visible preview when the saved original is %s", async (kind) => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const path = join(harness.tempDir, "original.png");
		const preview = pngImage(1, 1, 50);
		appendGeneratedPreview(harness, preview, path, PNG);
		if (kind === "changed") await writeFile(path, Buffer.from(pngImage(1, 1, 100), "base64"));

		await requestImage(harness, { num_last_images_to_include: 1 });

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/png;base64,${preview}` },
		]);
	});

	it("does not restore the old original when a context edit replaces the visible image", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const path = join(harness.tempDir, "original.png");
		await writeFile(path, Buffer.from(PNG, "base64"));
		const entry = appendGeneratedPreview(harness, pngImage(1, 1, 50), path, PNG);
		const replacement = pngImage(1, 1, 100);
		harness.sessionManager.appendContextEdit(entry, {
			content: [{ type: "image", data: replacement, mimeType: "image/png" }],
		});

		await requestImage(harness, { num_last_images_to_include: 1 });

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/png;base64,${replacement}` },
		]);
	});

	it("restores recent generated-image references after reopening a saved session", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json({ data: [{ b64_json: PNG, generation_id: "generation-1" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const manager = SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		const original = await createImageHarness(true, { sessionManager: manager });
		harnesses.push(original);
		await requestImage(original);
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const resumed = await createImageHarness(true, { sessionManager: SessionManager.open(sessionFile!) });
		harnesses.push(resumed);

		const result = await requestImage(resumed, { num_last_images_to_include: 1 });

		expect(result.isError).toBe(false);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/png;base64,${PNG}` },
		]);
	});

	it("returns Codex-compatible structured image output to codemode scripts", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness(true, {
			extensionFactories: [createCodemodeExtension()],
			initialActiveToolNames: ["codemode", "codex_image"],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'const result = await tools.codex_image({prompt: "A cat", outputPath: "image.png"}); image(result.image_url); text(result.output_hint);',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Generate an image using codemode");

		const result = getToolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
		expect(getMessageText(result)).toContain("Original PNG saved to:");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns the image if a destination appears after generation, without overwriting it", async () => {
		const harness = await createImageHarness();
		harnesses.push(harness);
		const path = join(harness.tempDir, "image.png");
		const fetchMock = vi.fn<typeof fetch>(async () => {
			await writeFile(path, "created during generation");
			return Response.json({ data: [{ b64_json: PNG }] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestImage(harness);

		expect(result.isError).toBe(false);
		expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
		expect(result.details).toMatchObject({ path: null, saveError: expect.stringContaining("EEXIST") });
		expect(getMessageText(result)).toContain("do not automatically regenerate");
		expect(await readFile(path, "utf8")).toBe("created during generation");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("serializes calls sharing a destination so they do not spend quota twice", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codex_image", { prompt: "A cat", outputPath: "image.png" }),
					fauxToolCall("codex_image", { prompt: "A dog", outputPath: "image.png" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Generate two images");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const results = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "codex_image",
		);
		expect(results.map((result) => result.role === "toolResult" && result.isError)).toEqual([false, true]);
		expect(await readFile(join(harness.tempDir, "image.png"))).toEqual(Buffer.from(PNG, "base64"));
	});

	it("omits oversized UTF-8 output hints without losing the image or original file", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG }] })),
		);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const path = join(...Array.from({ length: 4 }, () => "界".repeat(66)), "image.png");

		const result = await requestImage(harness, { outputPath: path });

		expect(result.isError).toBe(false);
		expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
		expect(harness.eventsOfType("tool_execution_end")[0]?.result.structuredContent).not.toHaveProperty("output_hint");
		expect(await readFile(join(harness.tempDir, path))).toEqual(Buffer.from(PNG, "base64"));
	});

	it("times out a request after ten minutes without retrying", async () => {
		const timeout = new AbortController();
		const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const requested = Promise.withResolvers<void>();
		const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
			requested.resolve();
			return new Promise<Response>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const harness = await createImageHarness();
		harnesses.push(harness);
		const prompt = harness.session.prompt("Generate an image");
		await requested.promise;

		timeout.abort(new DOMException("Timed out", "TimeoutError"));
		await prompt;

		expect(timeoutMock).toHaveBeenCalledWith(600_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getToolResult(harness, "codex_image").isError).toBe(true);
		expect(existsSync(join(harness.tempDir, "image.png"))).toBe(false);
	});

	it.each([false, true])(
		"cancels an in-flight image request when the session is aborted (editing: %s)",
		async (editing) => {
			let markRequested = () => {};
			const requested = new Promise<void>((resolve) => {
				markRequested = resolve;
			});
			let requestSignal: AbortSignal | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async (_url, options) => {
					requestSignal = options?.signal ?? undefined;
					markRequested();
					return new Promise<Response>((_resolve, reject) => {
						requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
							once: true,
						});
					});
				}),
			);
			const harness = await createImageHarness();
			harnesses.push(harness);
			if (editing) {
				await writeFile(join(harness.tempDir, "reference.png"), Buffer.from(PNG, "base64"));
				harness.setResponses([
					fauxAssistantMessage(
						[
							fauxToolCall("codex_image", {
								prompt: "Edit the image",
								outputPath: "image.png",
								referenced_image_paths: ["reference.png"],
							}),
						],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				]);
			}
			const prompt = harness.session.prompt("Generate an image");
			await requested;

			await harness.session.abort();
			await prompt;

			expect(requestSignal?.aborted).toBe(true);
			expect(existsSync(join(harness.tempDir, "image.png"))).toBe(false);
			expect(harness.session.isIdle).toBe(true);
		},
	);
});
