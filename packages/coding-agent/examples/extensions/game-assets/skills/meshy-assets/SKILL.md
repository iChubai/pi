---
name: meshy-assets
description: Use the official Meshy MCP for 3D generation, multiview inputs, remeshing, retexturing, humanoid rigging, catalog animation and asset downloads. Preserve native parameters and task IDs; use the server's built-in wait mode.
compatibility: An independently provisioned official Meshy MCP server and authorized Meshy API account, connected through Pi's native MCP support.
---

# Meshy assets

Read [the package README](../../README.md) for setup and backend limits. The package extension only calls `pi.registerMcpServer`; it does not replace Meshy's tools or implement another task queue.

## Connect and discover

If Meshy is already configured in Pi, disable this package's `extensions/meshy.ts` and use the existing server. Otherwise the user provisions a reviewed official `meshy-mcp-server` executable, sets `MESHY_MCP_COMMAND` to its path, and provides `MESHY_API_KEY` through the environment. Never print or copy the key into a request, profile, prompt or shared config. Reload Pi and inspect `/mcp` inside the session. Shell `pi mcp list` does not load extension registrations.

Discover the server's actual tool schemas before use:

```js
text(await searchTools("3D generation rigging animation", { namespace: "mcp__meshy" }));
text(await describeTool("mcp__meshy__meshy_image_to_3d"));
```

Adapt the namespace when reusing a differently named server.

## Choose native operations

- `meshy_text_to_3d`, `meshy_text_to_3d_refine`, `meshy_image_to_3d`, `meshy_multi_image_to_3d`: choose actual model/version, reference mode, topology, PBR and output settings from the discovered schema.
- `meshy_remesh`, `meshy_retexture`: revise the same asset when geometry or appearance needs a local correction; preserve its UV layout when required and supported.
- `meshy_rig`, `meshy_animate`: rig a supported textured humanoid and select catalog actions. Rigging may already include useful base animations; inspect the result before paying for more. This is not arbitrary text-to-skeletal-motion generation.
- `meshy_get_task_status`, `meshy_list_tasks`, `meshy_download_model`: reuse the original task and let the server manage waiting/downloads.

Do not force every asset through every operation. Use existing or procedural assets when appropriate. Do not replace an unavailable selected model, reduce polygon count or change texture quality without authorization.

## Create once, save the ID, then wait

Put native creation arguments in a project-local request file and get generation/upload authorization. Call the selected creation tool once. Check `isError`, then persist its task ID/type and returned data with the existing write tool before a long wait. Print the ID immediately; do not rely solely on codemode `store()`, whose writes are committed only if the entire script succeeds.

Example wait for a previously saved image-to-3D task:

```js
// @options: {"timeout_ms": 360000}
const result = await tools.mcp__meshy__meshy_get_task_status({
  task_id: "SAVED_TASK_ID",
  task_type: "image-to-3d",
  wait: true,
  timeout_seconds: 300,
  response_format: "json"
});
if (result.isError) throw new Error(JSON.stringify(result.content));
text(result.structuredContent ?? result.content);
```

A wait timeout is not a canceled generation. Reuse the ID on the next query, not the create tool. Download the chosen format to a new absolute project path with `meshy_download_model`; preserve returned paths. For animation, use an engine-compatible rig/animation format rather than assuming a preview video is the motion asset.

## Recovery and limitations

- A creation call with a lost reply is unknown. Inspect the provider history before any replacement; do not automatically claim the newest task. Rigging/animation have no list endpoints in the reviewed MCP, so a missing ID may require provider support.
- The reviewed official client internally retries some requests, including POST. This registration does not change that behavior and does not guarantee one billable creation. Do not add another retry layer.
- Cancellation depends on provider task state. Queued cancellation, in-progress work, and deleting a completed asset are different operations; do not use `meshy_cancel_task` without inspecting its current semantics and the task state.
- Download promptly within the provider's retention window. Local files, not expiring service URLs, belong in the game project.
- Meshy rigging targets supported humanoids. Apply required size/orientation/topology constraints and validate deformation, retargeting and controller behavior in-engine. Generated mesh geometry is not a collision model or a finished character controller.
