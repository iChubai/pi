import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execNpmSync } from "../scripts/npm-command.mjs";

const profileDir = dirname(fileURLToPath(import.meta.url));
const officialPlugin = /^npm:@langfuse\/pi-observability-plugin(?:@|$)/;

function readSettings(path) {
	if (!existsSync(path)) return {};
	let settings;
	try {
		settings = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Cannot parse ${path}; no settings were overwritten.`);
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error(`Expected an object in ${path}.`);
	}
	for (const key of ["packages", "extensions"]) {
		if (settings[key] !== undefined && !Array.isArray(settings[key])) {
			throw new Error(`Expected an array for ${key} in ${path}.`);
		}
	}
	return settings;
}

function packageIdentity(source) {
	if (source.startsWith("npm:")) {
		return source.replace(/(@[^/@]+)$/, "");
	}
	if (source.startsWith("git:")) {
		return source.replace(/@[^/@]+$/, "");
	}
	return source;
}

export function mergeProfile(settings, profile, baseDir, agentDir) {
	const requested = profile.packages.map((source) =>
		source.startsWith("./") ? resolve(baseDir, source) : source,
	);
	const identities = new Set(requested.map(packageIdentity));
	const packages = [];
	for (const entry of settings.packages ?? []) {
		const source = typeof entry === "string" ? entry : entry?.source;
		if (typeof source !== "string")
			throw new Error(
				"Invalid package declaration; no settings were overwritten.",
			);
		if (officialPlugin.test(source)) {
			packages.push({
				...(typeof entry === "string" ? { source } : entry),
				extensions: [],
			});
			continue;
		}
		const localSource =
			!source.startsWith("npm:") &&
			!source.startsWith("git:") &&
			!source.includes("://");
		const resolved = localSource ? resolve(agentDir, source) : source;
		// Relocate the previous user-local or checkout-local copy without loading two tracers.
		const previousEnhanced =
			localSource && /(?:^|[/\\])langfuse-enhanced[/\\]?$/.test(resolved);
		if (!previousEnhanced && !identities.has(packageIdentity(resolved)))
			packages.push(entry);
	}
	packages.push(...requested);
	const extensions = (settings.extensions ?? []).filter(
		(entry) => entry !== "builtin:mcp" && entry !== "-builtin:mcp",
	);
	extensions.push(...profile.extensions);
	return { ...settings, packages, extensions };
}

export function setup({
	agentDir = resolve(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
	),
	baseDir = profileDir,
	runPi = (args, options) =>
		execFileSync(process.env.PI_BIN || "pi", args, options),
	runNpm = execNpmSync,
} = {}) {
	const profile = JSON.parse(
		readFileSync(join(baseDir, "profile.json"), "utf8"),
	);
	const settingsPath = join(agentDir, "settings.json");
	const original = readSettings(settingsPath);
	// Validate before installing anything. The post-install merge reads fresh settings.
	mergeProfile(original, profile, baseDir, agentDir);
	runPi(["--version"], { stdio: "pipe" });
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	let backup;
	if (existsSync(settingsPath)) {
		backup = join(
			agentDir,
			`settings.before-customizations.${Date.now()}.${process.pid}.json`,
		);
		writeFileSync(backup, readFileSync(settingsPath), {
			flag: "wx",
			mode: 0o600,
		});
	}
	const options = {
		cwd: baseDir,
		stdio: "inherit",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			npm_config_ignore_scripts: "true",
			NPM_CONFIG_IGNORE_SCRIPTS: "true",
		},
	};
	runNpm(
		[
			"ci",
			"--prefix",
			join(baseDir, "langfuse-enhanced"),
			"--ignore-scripts",
			"--legacy-peer-deps",
		],
		options,
	);
	for (const source of profile.packages) {
		if (!source.startsWith("./")) runPi(["install", source], options);
	}
	const current = readSettings(settingsPath);
	const updated = mergeProfile(current, profile, baseDir, agentDir);
	const temporary = `${settingsPath}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(updated, null, "\t")}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, settingsPath);
	} catch {
		throw new Error(
			`Could not save ${settingsPath}. Existing settings and any backup remain in place.`,
		);
	}
	for (const name of ["langfuse", "mcp"]) {
		const path = join(agentDir, `${name}.json`);
		if (!existsSync(path)) {
			writeFileSync(path, readFileSync(join(baseDir, `${name}.example.json`)), {
				flag: "wx",
				mode: 0o600,
			});
		} else {
			chmodSync(path, 0o600);
		}
	}
	return { agentDir, backup, settingsPath };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (process.argv.length > 2) {
		console.error("Usage: node customizations/setup.mjs");
		process.exitCode = 1;
	} else {
		try {
			const result = setup();
			console.log(`Configured ${result.settingsPath}`);
			if (result.backup) console.log(`Previous settings: ${result.backup}`);
			console.log(
				`Fill in ${join(result.agentDir, "langfuse.json")} and configure ${join(result.agentDir, "mcp.json")}.`,
			);
			console.log(
				"Restart Pi and start a new session. Keep this checkout in place.",
			);
		} catch (error) {
			console.error(
				`Customization setup failed: ${error instanceof Error ? error.message : "unknown error"}`,
			);
			process.exitCode = 1;
		}
	}
}
