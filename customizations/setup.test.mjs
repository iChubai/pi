import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeProfile, setup } from "./setup.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(
	readFileSync(join(sourceDir, "profile.json"), "utf8"),
);

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-profile-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const baseDir = join(root, "checkout", "customizations");
	const agentDir = join(root, "agent");
	mkdirSync(baseDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const name of [
		"profile.json",
		"langfuse.example.json",
		"mcp.example.json",
	]) {
		copyFileSync(join(sourceDir, name), join(baseDir, name));
	}
	const calls = [];
	const runPi = (args, options) => calls.push({ command: "pi", args, options });
	const runNpm = (args, options) =>
		calls.push({ command: "npm", args, options });
	return { root, baseDir, agentDir, calls, runPi, runNpm };
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function assertPrivate(path) {
	if (process.platform !== "win32")
		assert.equal(statSync(path).mode & 0o777, 0o600);
}

test("merges a portable profile without changing unrelated settings or its inputs", (t) => {
	const { baseDir, agentDir } = fixture(t);
	const settings = {
		defaultProvider: "existing-provider",
		hideThinkingBlock: true,
		packages: [
			"npm:unrelated-tools@1.2.3",
			{ source: "npm:filtered-tools@2.0.0", extensions: [] },
			{
				source: "npm:@langfuse/pi-observability-plugin@0.1.2",
				skills: ["existing-skill"],
			},
			"npm:pi-mcp-adapter@5.1.0",
			"git:github.com/langfuse/skills@old-commit",
			join(agentDir, "local", "langfuse-enhanced"),
		],
		extensions: ["existing-extension.ts", "builtin:mcp"],
	};
	const original = structuredClone(settings);
	const result = mergeProfile(settings, profile, baseDir, agentDir);
	assert.deepEqual(settings, original);
	assert.equal(result.defaultProvider, settings.defaultProvider);
	assert.equal(result.hideThinkingBlock, true);
	assert.deepEqual(result.packages.slice(0, 2), settings.packages.slice(0, 2));
	assert.deepEqual(result.packages[2], {
		source: "npm:@langfuse/pi-observability-plugin@0.1.2",
		skills: ["existing-skill"],
		extensions: [],
	});
	assert.deepEqual(result.packages.slice(3), [
		resolve(baseDir, "langfuse-enhanced"),
		...profile.packages.slice(1),
	]);
	assert.deepEqual(result.extensions, [
		"existing-extension.ts",
		"-builtin:mcp",
	]);
	assert.deepEqual(mergeProfile(result, profile, baseDir, agentDir), result);
});

test("disables an unversioned official tracer and relocates a relative enhanced tracer", (t) => {
	const { baseDir, agentDir } = fixture(t);
	const result = mergeProfile(
		{
			packages: [
				"npm:@langfuse/pi-observability-plugin",
				"./local/langfuse-enhanced",
			],
		},
		profile,
		baseDir,
		agentDir,
	);
	assert.deepEqual(result.packages[0], {
		source: "npm:@langfuse/pi-observability-plugin",
		extensions: [],
	});
	assert.equal(result.packages.length, profile.packages.length + 1);
});

test("creates private empty templates and installs only pinned remote packages without scripts", (t) => {
	const context = fixture(t);
	const result = setup(context);
	assert.equal(result.backup, undefined);
	assert.deepEqual(
		readJson(result.settingsPath),
		mergeProfile({}, profile, context.baseDir, context.agentDir),
	);
	assert.equal(readJson(join(context.agentDir, "langfuse.json")).secretKey, "");
	assert.equal(
		readJson(join(context.agentDir, "langfuse.json")).baseUrl,
		"https://us.cloud.langfuse.com",
	);
	assert.deepEqual(readJson(join(context.agentDir, "mcp.json")), {
		mcpServers: {},
	});
	for (const name of ["settings", "langfuse", "mcp"])
		assertPrivate(join(context.agentDir, `${name}.json`));
	assert.deepEqual(
		context.calls.map(({ command, args }) => [command, args]),
		[
			["pi", ["--version"]],
			[
				"npm",
				[
					"ci",
					"--prefix",
					join(context.baseDir, "langfuse-enhanced"),
					"--ignore-scripts",
					"--legacy-peer-deps",
				],
			],
			...profile.packages.slice(1).map((source) => ["pi", ["install", source]]),
		],
	);
	for (const call of context.calls.slice(1)) {
		assert.equal(call.options.env.PI_CODING_AGENT_DIR, context.agentDir);
		assert.equal(call.options.env.npm_config_ignore_scripts, "true");
		assert.equal(call.options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
	}
});

test("backs up settings and retains credentials, server configuration and post-install settings", (t) => {
	const context = fixture(t);
	const settingsPath = join(context.agentDir, "settings.json");
	const original = '{"theme":"original","packages":["npm:keep@1.0.0"]}\n';
	writeFileSync(settingsPath, original);
	const privateConfig = '{"secretKey":"synthetic-private-value"}\n';
	const mcpConfig = '{"mcpServers":{"existing":{"command":"existing-tool"}}}\n';
	writeFileSync(join(context.agentDir, "langfuse.json"), privateConfig);
	writeFileSync(join(context.agentDir, "mcp.json"), mcpConfig);
	const runPi = (args, options) => {
		context.runPi(args, options);
		if (args[0] === "install") {
			const settings = readJson(settingsPath);
			settings.cliInstallPreserved = true;
			writeFileSync(settingsPath, JSON.stringify(settings));
		}
	};
	const result = setup({ ...context, runPi });
	assert.equal(readFileSync(result.backup, "utf8"), original);
	assertPrivate(result.backup);
	assert.equal(readJson(settingsPath).cliInstallPreserved, true);
	assert.equal(readJson(settingsPath).theme, "original");
	assert.equal(
		readFileSync(join(context.agentDir, "langfuse.json"), "utf8"),
		privateConfig,
	);
	assert.equal(
		readFileSync(join(context.agentDir, "mcp.json"), "utf8"),
		mcpConfig,
	);
	const first = readJson(settingsPath);
	setup(context);
	assert.deepEqual(readJson(settingsPath), first);
});

test("rejects invalid settings before installing and omits parser excerpts", (t) => {
	const context = fixture(t);
	const path = join(context.agentDir, "settings.json");
	const invalid = '{"secretKey":"synthetic-sensitive-marker", BROKEN';
	writeFileSync(path, invalid);
	assert.throws(
		() => setup(context),
		(error) => {
			assert.match(error.message, /Cannot parse/);
			assert.doesNotMatch(error.message, /synthetic-sensitive-marker/);
			return true;
		},
	);
	assert.equal(readFileSync(path, "utf8"), invalid);
	assert.equal(context.calls.length, 0);
});

test("rejects malformed package declarations without modifying settings", (t) => {
	const context = fixture(t);
	const path = join(context.agentDir, "settings.json");
	for (const settings of [
		null,
		[],
		{ packages: "wrong" },
		{ extensions: {} },
		{ packages: [{}] },
	]) {
		const original = JSON.stringify(settings);
		writeFileSync(path, original);
		assert.throws(() => setup(context));
		assert.equal(readFileSync(path, "utf8"), original);
	}
	assert.equal(context.calls.length, 0);
});

test("a dependency installation failure keeps the settings backup and does not enable a new tracer", (t) => {
	const context = fixture(t);
	const path = join(context.agentDir, "settings.json");
	const original = JSON.stringify({
		packages: ["npm:@langfuse/pi-observability-plugin@0.1.2"],
	});
	writeFileSync(path, original);
	assert.throws(
		() =>
			setup({
				...context,
				runNpm: () => {
					throw new Error("Synthetic install failure");
				},
			}),
		/Synthetic install failure/,
	);
	assert.equal(readFileSync(path, "utf8"), original);
	assert.equal(context.calls.length, 1);
	assert.equal(existsSync(join(context.agentDir, "langfuse.json")), false);
});
