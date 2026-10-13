import type { ModelImageResizeOptions } from "./types.ts";

// Keep image preparation no less restrictive than coding-agent's historical
// defaults: 2000px / 4.5 MiB. This is Pi policy, not an upstream model limit.
// Explicit model configuration takes precedence.
export const DEFAULT_IMAGE_RESIZE: Readonly<ModelImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
};
