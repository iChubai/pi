import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";

// Source-based type checking needs the checkout's ignored model metadata, not a build.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "packages/ai/src/providers/data/.manifest.json"))) {
	const { revision } = JSON.parse(
		readFileSync(join(root, "nix/model-catalog.json"), "utf8"),
	);
	if (!/^sha256-[0-9a-f]{64}$/.test(revision))
		throw new Error("Invalid model catalog revision");
	const response = await fetch(
		`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`,
	);
	if (!response.ok)
		throw new Error(`Public catalog download failed: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (
		`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== revision
	) {
		throw new Error("Public catalog integrity mismatch");
	}
	const directory = mkdtempSync(join(tmpdir(), "pi-customizations-catalog-"));
	try {
		const path = join(directory, "models.all.json");
		writeFileSync(path, bytes);
		hydrateModelCatalog(join(root, "packages/ai"), path);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
