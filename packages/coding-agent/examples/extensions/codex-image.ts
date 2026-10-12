/**
 * Generate and edit PNG images with Codex's ChatGPT subscription credentials.
 *
 * Load with `pi -e ./packages/coding-agent/examples/extensions/codex-image.ts`.
 * Authenticate in pi with `/login openai-codex`; the separate `openai` OAuth
 * flow and API keys are not used. The server still enforces account access and quota.
 *
 * Protocol reference: OpenAI Codex rust-v0.162.1,
 * codex-rs/codex-api/src/endpoint/images.rs and codex-rs/ext/image-generation/src/tool.rs.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ImageContent, Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { PhotonImage } from "@silvia-odwyer/photon-node";

const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images";
const MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 1024 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface ImageReference {
	image_url: string;
}

interface RecentImage {
	content: ImageContent;
	originalPath?: string;
	originalSha256?: string;
}

interface CodexImageDetails {
	status: "in_progress" | "completed";
	operation: "generate" | "edit";
	model: string;
	path: string | null;
	requestId: string | null;
	generationId: string | null;
	transparentBackground: boolean | null;
	referencedImages: number;
	originalSha256?: string;
	saveError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function accountIdFromToken(token: string): string {
	try {
		const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const claim = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
		const accountId = isRecord(claim) ? claim.chatgpt_account_id : undefined;
		if (typeof accountId === "string" && accountId.length > 0) return accountId;
	} catch {}
	throw new Error("Codex image generation needs ChatGPT credentials. Run /login openai-codex in pi.");
}

function decodeImage(body: unknown): {
	bytes: Buffer;
	generationId: string | null;
	transparentBackground: boolean | null;
} {
	if (!isRecord(body) || !Array.isArray(body.data) || body.data.length !== 1) {
		throw new Error("Codex image generation returned an invalid image response.");
	}
	const image: unknown = body.data[0];
	const data = isRecord(image) && typeof image.b64_json === "string" ? image.b64_json.trim() : undefined;
	if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
		throw new Error("Codex image generation returned invalid or oversized image data.");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		throw new Error("Codex image generation did not return a supported PNG image.");
	}
	return {
		bytes,
		generationId: isRecord(image) && typeof image.generation_id === "string" ? image.generation_id : null,
		transparentBackground: body.background === "transparent" ? true : body.background === "opaque" ? false : null,
	};
}

async function localReference(path: string, cwd: string, signal?: AbortSignal): Promise<ImageReference> {
	signal?.throwIfAborted();
	const absolutePath = resolve(cwd, path);
	const info = await stat(absolutePath);
	if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) {
		throw new Error(`Referenced image must be a file no larger than 1 GiB: ${absolutePath}`);
	}
	let bytes = await readFile(absolutePath, { signal });
	signal?.throwIfAborted();
	let mimeType: string;
	let image: PhotonImage | undefined;
	try {
		// Validate every input, but preserve PNG/JPEG/WebP originals byte-for-byte, as Codex does.
		image = PhotonImage.new_from_byteslice(bytes);
		if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
			mimeType = "image/png";
		} else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
			mimeType = "image/jpeg";
		} else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
			mimeType = "image/webp";
		} else {
			bytes = Buffer.from(image.get_bytes());
			mimeType = "image/png";
		}
	} catch {
		throw new Error(`Unable to decode referenced image: ${absolutePath}`);
	} finally {
		image?.free();
	}
	return { image_url: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

async function recentReferences(ctx: ExtensionContext, count: number, signal?: AbortSignal): Promise<ImageReference[]> {
	const images: RecentImage[] = [];
	// Projection respects branches, compaction, and context edits. Raw session entries do not.
	for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
		for (const message of entry.messages) {
			if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") continue;
			if (!Array.isArray(message.content)) continue;
			for (const content of message.content) {
				if (content.type !== "image") continue;
				const candidate: RecentImage = { content };
				const source = entry.sourceEntry.type === "message" ? entry.sourceEntry.message : undefined;
				if (
					source?.role === "toolResult" &&
					source.toolName === "codex_image" &&
					!source.isError &&
					source.content.some(
						(block) =>
							block.type === "image" && block.data === content.data && block.mimeType === content.mimeType,
					) &&
					isRecord(source.details) &&
					typeof source.details.path === "string" &&
					typeof source.details.originalSha256 === "string" &&
					/^[a-f0-9]{64}$/.test(source.details.originalSha256)
				) {
					candidate.originalPath = source.details.path;
					candidate.originalSha256 = source.details.originalSha256;
				}
				images.push(candidate);
			}
		}
	}
	if (images.length < count) {
		throw new Error(`Requested the last ${count} conversation images, but only ${images.length} were available.`);
	}
	return Promise.all(
		images.slice(-count).map(async ({ content, originalPath, originalSha256 }) => {
			signal?.throwIfAborted();
			if (originalPath && originalSha256) {
				try {
					const info = await stat(originalPath);
					if (info.isFile() && info.size <= MAX_IMAGE_BYTES) {
						const bytes = await readFile(originalPath, { signal });
						if (createHash("sha256").update(bytes).digest("hex") === originalSha256) {
							return { image_url: `data:image/png;base64,${bytes.toString("base64")}` };
						}
					}
				} catch {
					// A moved, deleted, or changed original must not replace the visible conversation image.
					signal?.throwIfAborted();
				}
			}
			return { image_url: `data:${content.mimeType};base64,${content.data}` };
		}),
	);
}

const parameters = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			description: "Detailed description of the image to generate or the edit to make",
		}),
		transparent_background: Type.Optional(
			Type.Boolean({
				description: "Request a transparent background. Defaults to false. Do not combine with background.",
			}),
		),
		referenced_image_paths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: MAX_EDIT_IMAGES,
				description:
					"Up to 5 local image paths to edit or use as references, in order. Prefer paths when all targets have one.",
			}),
		),
		num_last_images_to_include: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_EDIT_IMAGES,
				description:
					"Use the last 1–5 visible conversation images when a target has no local path. Cannot combine with nonempty referenced_image_paths.",
			}),
		),
		outputPath: Type.Optional(
			Type.String({ minLength: 1, description: "New .png file path; existing files are never overwritten" }),
		),
		size: Type.Optional(
			Type.Union([
				Type.Literal("auto"),
				Type.Literal("1024x1024"),
				Type.Literal("1536x1024"),
				Type.Literal("1024x1536"),
			]),
		),
		quality: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
		),
		background: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")], {
				description: "Alternative to transparent_background; defaults to opaque. Do not combine the two.",
			}),
		),
	},
	{ additionalProperties: false },
);

const codexImageTool = defineTool<typeof parameters, CodexImageDetails>({
	name: "codex_image",
	label: "Codex image",
	description:
		"Generate or edit one image with GPT Image through the user's Codex ChatGPT subscription, without OpenRouter or an API key. Supports up to 5 local reference images or the most recent conversation images. Saves the original PNG and returns an image preview. Requires /login openai-codex in pi. Requests may take several minutes. Do not automatically retry failed requests.",
	promptGuidelines: [
		"For a new image, omit both reference arguments. For edits, use referenced_image_paths when all targets have local paths; inspect unseen local images with read first.",
		"Use num_last_images_to_include only when a target has no local path. Choose the smallest recent-image window covering every target, at most 5 images. If that cannot cover all targets, ask the user to attach them again.",
		"Set transparent_background=true when transparency is requested. When editing, preserve existing transparency unless the user requests a change.",
		"Images are already displayed in tool results. Do not display them again with Markdown links. Copy saved original PNGs without re-encoding when the user wants another location.",
		"In codemode, call tools.codex_image(args), show the returned image_url with image(result.image_url), and show output_hint with text(result.output_hint) when present. Never print image base64.",
	],
	parameters,
	outputSchema: Type.Object({ image_url: Type.String(), output_hint: Type.Optional(Type.String()) }),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const prompt = params.prompt.trim();
		if (!prompt) throw new Error("Image prompt must not be empty.");
		const paths = params.referenced_image_paths ?? [];
		const count = params.num_last_images_to_include;
		if (paths.length > MAX_EDIT_IMAGES || paths.some((path) => !path.trim())) {
			throw new Error("referenced_image_paths must contain at most 5 nonempty paths.");
		}
		if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_EDIT_IMAGES)) {
			throw new Error("num_last_images_to_include must be between 1 and 5.");
		}
		if (paths.length > 0 && count !== undefined) {
			throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include.");
		}
		if (params.background !== undefined && params.transparent_background !== undefined) {
			throw new Error("Provide only one of background or transparent_background.");
		}
		const outputPath = params.outputPath
			? resolve(ctx.cwd, params.outputPath)
			: join(getAgentDir(), "generated-images", `${randomUUID()}.png`);
		if (!outputPath.toLowerCase().endsWith(".png")) throw new Error("Image outputPath must end in .png.");

		// Serialize the existence check and request as well as the write: duplicate destinations must not spend quota twice.
		return withFileMutationQueue(outputPath, async () => {
			signal?.throwIfAborted();
			try {
				await lstat(outputPath);
				throw new Error(`Image output file already exists: ${outputPath}`);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			const images =
				count !== undefined
					? await recentReferences(ctx, count, signal)
					: await Promise.all(paths.map((path) => localReference(path, ctx.cwd, signal)));
			const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
			if (!auth?.auth.apiKey) throw new Error("Run /login openai-codex in pi before generating images.");
			const token = auth.auth.apiKey;
			const accountId = accountIdFromToken(token);
			await mkdir(dirname(outputPath), { recursive: true });
			await access(dirname(outputPath), constants.W_OK);
			const headers = new Headers();
			for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
				if (typeof value === "string") headers.set(name, value);
			}
			headers.set("Authorization", `Bearer ${token}`);
			headers.set("ChatGPT-Account-ID", accountId);
			headers.set("Content-Type", "application/json");
			headers.set("Accept", "application/json");
			headers.set("originator", "pi");
			headers.set("x-codex-image-turn-id", randomUUID());

			const details: CodexImageDetails = {
				status: "in_progress",
				operation: images.length > 0 ? "edit" : "generate",
				model: MODEL,
				path: null,
				requestId: null,
				generationId: null,
				transparentBackground: null,
				referencedImages: images.length,
			};
			onUpdate?.({
				content: [{ type: "text", text: `${images.length > 0 ? "Editing" : "Generating"} ${MODEL} image...` }],
				details,
			});
			const timeoutSignal = AbortSignal.timeout(600_000);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			requestSignal.throwIfAborted();
			const response = await fetch(`${IMAGE_ENDPOINT}/${images.length > 0 ? "edits" : "generations"}`, {
				method: "POST",
				headers,
				signal: requestSignal,
				redirect: "error",
				body: JSON.stringify({
					model: MODEL,
					prompt,
					n: 1,
					size: params.size ?? "auto",
					quality: params.quality ?? "auto",
					background: params.background ?? (params.transparent_background ? "transparent" : "opaque"),
					...(images.length > 0 ? { images } : {}),
				}),
			});
			const requestId = response.headers.get("x-codex-imagegen-request-id");
			if (!response.ok) {
				const errorBody = (await response.text()).slice(0, 2000);
				throw new Error(
					`Codex image ${details.operation} failed (${response.status}): ${errorBody}${requestId ? ` (request ID: ${requestId})` : ""}`,
				);
			}
			const body: unknown = await response.json();
			const { bytes, generationId, transparentBackground } = decodeImage(body);
			requestSignal.throwIfAborted();
			let savedPath: string | null = outputPath;
			let saveError: string | undefined;
			try {
				await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
			} catch (error) {
				// Like Codex, return the generated image even if artifact persistence fails after generation.
				savedPath = null;
				saveError = error instanceof Error ? error.message : String(error);
			}
			const hint = savedPath
				? `Generated ${MODEL} image. Original PNG saved to: ${savedPath}\nCopy the original PNG without re-encoding if another location is requested. The image is already displayed; do not display it again with a Markdown link.`
				: `Generated ${MODEL} image, but saving the original PNG failed: ${saveError}. The image is returned below; do not automatically regenerate it.`;
			const outputHint = Buffer.byteLength(hint, "utf8") <= 1024 ? hint : undefined;
			const data = bytes.toString("base64");
			return {
				content: [
					{ type: "text", text: outputHint ?? `Generated ${MODEL} image.` },
					{ type: "image", data, mimeType: "image/png" },
				],
				structuredContent: {
					image_url: `data:image/png;base64,${data}`,
					...(outputHint ? { output_hint: outputHint } : {}),
				},
				details: {
					...details,
					status: "completed",
					path: savedPath,
					requestId,
					generationId,
					transparentBackground,
					originalSha256: createHash("sha256").update(bytes).digest("hex"),
					...(saveError ? { saveError } : {}),
				},
			};
		});
	},
});

export default function codexImageExtension(pi: ExtensionAPI) {
	pi.registerTool(codexImageTool);
}
