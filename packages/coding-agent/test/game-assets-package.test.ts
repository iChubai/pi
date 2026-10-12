import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPackageDir } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const packageRoot = join(getPackageDir(), "examples", "extensions", "game-assets");
const skillNames = [
	"elevenlabs-audio",
	"game-assets",
	"image-assets",
	"ltx-video",
	"meshy-assets",
	"minimax-video",
	"remote-assets",
];

describe("game-assets package", () => {
	let directory: string;
	let settings: SettingsManager;
	let manager: DefaultPackageManager;
	let loader: DefaultResourceLoader;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-game-assets-test-"));
		const cwd = join(directory, "project");
		const agentDir = join(directory, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv("HOME", directory);
		vi.stubEnv("MESHY_MCP_COMMAND", undefined);
		vi.stubEnv("MESHY_API_KEY", undefined);
		settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
		await manager.installAndPersist(packageRoot, { local: true });
		await settings.flush();
		// No built-in MCP extension: load registrations, never start a server or connect to a provider.
		loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
	});

	afterEach(async () => {
		await settings.flush();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("installs all seven sibling skills and removes the single package declaration", async () => {
		await loader.reload();
		expect(loader.getSkills().diagnostics).toEqual([]);
		expect(
			loader
				.getSkills()
				.skills.map((skill) => skill.name)
				.sort(),
		).toEqual(skillNames);
		for (const skill of loader.getSkills().skills) {
			expect(skill.filePath).toBe(join(packageRoot, "skills", skill.name, "SKILL.md"));
		}
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().warnings).toEqual([]);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
			join(packageRoot, "extensions", "meshy.ts"),
		]);
		expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);
		expect(manager.listConfiguredPackages()).toHaveLength(1);

		expect(await manager.removeAndPersist(packageRoot, { local: true })).toBe(true);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);
		expect(manager.listConfiguredPackages()).toEqual([]);
		expect(existsSync(join(packageRoot, "skills", "remote-assets", "scripts", "assets.py"))).toBe(true);
	});

	it("does not load project resources or registrations before project trust", async () => {
		vi.stubEnv("MESHY_MCP_COMMAND", join(directory, "unstarted-meshy-server"));
		settings.setProjectTrusted(false);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);

		settings.setProjectTrusted(true);
		await loader.reload();
		expect(
			loader
				.getSkills()
				.skills.map((skill) => skill.name)
				.sort(),
		).toEqual(skillNames);
		expect(loader.getExtensions().runtime.mcpServers.list()).toHaveLength(1);
	});

	it.each(skillNames)("can enable only %s using the same skills/ path convention", async (name) => {
		settings.setProjectPackages([{ source: packageRoot, extensions: [], skills: [`skills/${name}/SKILL.md`] }]);
		await loader.reload();
		expect(loader.getSkills().diagnostics).toEqual([]);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([name]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);
	});

	it("registers the prepared Meshy command with native environment references", async () => {
		const command = join(directory, "unstarted-meshy-server");
		vi.stubEnv("MESHY_MCP_COMMAND", command);
		vi.stubEnv("MESHY_API_KEY", "test-secret-not-for-serialization");
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const servers = loader.getExtensions().runtime.mcpServers.list();
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({
			name: "meshy",
			config: {
				command,
				exposure: "codemode",
				timeout: 360,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Expect a literal reference, not the secret.
				env: { MESHY_API_KEY: "${MESHY_API_KEY}" },
			},
		});
		expect(JSON.stringify(servers)).not.toContain("test-secret-not-for-serialization");
	});

	it("filters the Meshy extension independently from its skill", async () => {
		vi.stubEnv("MESHY_MCP_COMMAND", join(directory, "unstarted-meshy-server"));
		settings.setProjectPackages([{ source: packageRoot, skills: [] }]);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getExtensions().runtime.mcpServers.list()).toHaveLength(1);

		settings.setProjectPackages([{ source: packageRoot, extensions: [] }]);
		await loader.reload();
		expect(
			loader
				.getSkills()
				.skills.map((skill) => skill.name)
				.sort(),
		).toEqual(skillNames);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);
	});

	it("can disable all resources and re-enable them without reinstalling", async () => {
		settings.setProjectPackages([{ source: packageRoot, extensions: [], skills: [] }]);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);

		settings.setProjectPackages([packageRoot]);
		await loader.reload();
		expect(
			loader
				.getSkills()
				.skills.map((skill) => skill.name)
				.sort(),
		).toEqual(skillNames);
		expect(loader.getExtensions().extensions).toHaveLength(1);
	});
});
