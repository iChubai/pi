---
name: game-assets
description: Choose and combine authorized image, 3D, rigging, motion, video, speech, sound-effect and music backends for a playable game. Use existing Pi tools, Meshy, ElevenLabs and bundled video/SSH skills; run local GPU inference with existing shell tools and native model commands.
---

# Game asset capabilities

Read [the package README](../../README.md) for installation and current backend status. This is a choice of capabilities, not a mandatory pipeline or a new model registry. Project files and the engine remain the source of truth.

## Select the needed capability

| Need | Skill / existing interface |
| --- | --- |
| Style reference, concept art, icons, image editing, texture candidates | `image-assets`: existing `codex_image` or Pi image models through codemode |
| Text/image/multi-image to 3D, remesh, retexture | `meshy-assets`: official Meshy MCP |
| Humanoid rigging and catalog animation | `meshy-assets`: official rig/animate tools |
| Speech, event sound effects, ambience, music | `elevenlabs-audio`: native ElevenLabs API |
| Video generation / video retake | Bundled `minimax-video` / `ltx-video` |
| A user-provisioned local GPU model | Existing Bash, Python, native model CLI or already running service; no extra execution layer |
| A user-provisioned SSH GPU model | Bundled `remote-assets`, with an actual model-specific adapter/profile |

Load only the relevant skills. Missing tools or credentials are setup requirements, not reasons to silently use another provider. Qwen-Image, TRELLIS.2, Hunyuan3D and HY-Motion remain candidates: this package provides no model-specific integration or provisioned environment for them. A generic SSH profile does not make them runnable.

For local GPU inference, use the already prepared environment and native commands directly. Do not add a local runner, registry, task protocol or SSH profile merely to invoke a local model. Keep native device, precision, input and quality options explicit; do not install dependencies, download weights or switch devices during normal generation. The bundled SSH module is optional and only needed for selected remote requests.

## Work from the game requirement

Start from the actual camera, interaction, scale, style, platform and budget. Reuse an existing asset or make one procedurally when that is the better fit. Generate one candidate, several candidates, or a local revision according to the uncertainty that needs resolving; none of these is a fixed default pipeline.

A weapon might need geometry/materials, collision, hand and muzzle sockets, animation, sound, VFX, UI and gameplay parameters. A generated mesh supplies only part of that asset. Video of a moving character is not controllable skeletal animation. Multiview reference images are not UV-aligned textures or a cubemap.

Preserve each backend's native settings: reference images, UV behavior, target topology, animation IDs, voice/model IDs, durations, seeds, output formats and quality controls. Do not compress them into a shared generate(prompt) call.

After generation, use existing Blender/FFmpeg/engine tools to process and import files. Inspect actual gameplay, playback and performance. For example, an effect turning opaque in-engine may need a material blend-mode fix, not another paid image. Record the parameters, provider task/request IDs, local files, elapsed time and reported usage. Do not claim a file manifest proves gameplay quality.

## Resource and recovery rules

Use only the user's authorized services, device profiles, uploads and budget. Installation alone is not permission to generate, clone voices, download weights, or reserve a GPU. Keep credentials out of prompts, job JSON and logs.

Let native task waiting or a script handle waiting. Save task IDs before long waits; after a lost reply, inspect the original task instead of issuing another paid creation. Existing successful local files should be reused. Provider-side retry/cancellation behavior differs by backend; the SSH runner's same-ID protections do not transfer to commercial APIs.
