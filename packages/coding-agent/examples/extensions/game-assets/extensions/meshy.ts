import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Connect an explicitly provisioned official server; never install it during startup. */
export default function meshyAssets(pi: ExtensionAPI) {
	const command = process.env.MESHY_MCP_COMMAND;
	if (!command) return;

	pi.registerMcpServer("meshy", {
		command,
		exposure: "codemode",
		timeout: 360,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Pi resolves this literal environment reference.
		env: { MESHY_API_KEY: "${MESHY_API_KEY}" },
		description:
			"Meshy asset generation: text/image/multi-image to 3D, remesh, retexture, rigging, animation, task waiting and downloads. Generation can incur charges.",
	});
}
