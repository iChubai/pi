---
name: ltx-video
description: Generate or revise LTX-2.5 video assets using native text/image conditioning, keyframe interpolation or retake time windows. Run local inference with existing shell tools and the official CLI; use the bundled remote-assets skill only for selected SSH execution.
compatibility: An already provisioned LTX-2.5 Python environment, compatible local weights, and an authorized device/budget. SSH execution additionally uses the bundled remote-assets skill.
---

# LTX-2.5 video

Read [video usage](../../docs/video.md). Paths here resolve from this skill directory. H3 setup is not required.

## Local inference

Use the existing Bash tools to call the prepared model interpreter and official `ltx_pipelines.distilled`, `ltx_pipelines.keyframe_interpolation`, or `ltx_pipelines.retake` CLI. Pass actual local media/weight paths and an explicit output path, preserving native options. The video documentation includes a direct CLI example. No adapter, profile, runner, upload cache or new local inference layer is required.

Choose the authorized device and compatible components before running. Keep resolution, seed, frame count/rate, quantization, offload and reference strength explicit when needed. Set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` to use prepared weights; do not install dependencies or fetch weights during generation. Do not lower quality or switch devices after failure without approval. Use existing process/log tools and preserve the command, output path and elapsed time.

## SSH inference

Only for a selected remote device, load the bundled `/skill:remote-assets`; its script is `../remote-assets/scripts/assets.py` relative to this skill. Read [adapter parameters](references/parameters.md).

The user prepares the official LTX environment, weights and device. Put `scripts/ltx_adapter.py` in an authorized remote directory. Register its path, the model interpreter, the official code directory, all required weights and `CUDA_VISIBLE_DEVICES` in the selected profile. Use [the SSH configuration example](../../examples/ltx-config.example.json).

Select a profile for `distilled`, `keyframe_interpolation`, or `retake`; the latter two are not automatically compatible with a distilled generation profile's full weight set. Inspect the registered component versions, not GPU memory alone. Use remote-assets `setup`/`validate` when provisioning changes, then an authorized small inference to establish actual compatibility.

1. Write `task: "video-generation"` and `parameters.arguments` as native CLI option groups. Bind uploaded media by `{"input":"name"}` and optional LoRAs by `{"weight":"registered-name"}`. These bindings are for remote execution, not a required local request format.
2. Submit with the selected profile and keep its generation ID. Let `wait ID --seconds 600` poll in the program while unrelated local work continues.
3. `fetch ID` retrieves the completed MP4. Use the same ID for recovery, logs or supported cancellation. Do not replace it after a connection failure or unknown execution state.

The adapter uses the configured interpreter and registered weight paths, keeps the model child in the runner-owned process group, and publishes a manifest only after the child completes. It does not schedule devices or certify asset quality.

## Inspect the asset

Choose existing assets or local editing when they solve the problem without generation. Inspect actual frames/audio and playback in the engine. MP4 is not a skeletal animation, transparent effect or guaranteed seamless loop. Use existing FFmpeg/engine tools for processing, then decide whether an edit or another generation is warranted.
