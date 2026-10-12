# LTX remote adapter parameters

This request format is only for the bundled SSH adapter. Local inference uses the official CLI directly with local paths; it does not require this JSON, a profile or a runner. See [video usage](../../../docs/video.md).

The adapter invokes the official CLI with argv, not a shell. `parameters` has one field, `arguments`: a list of native option groups. Values can be strings, numbers, `{"input":"name"}`, or `{"weight":"name"}`. Zero-value options are one-element groups, such as `["--enhance-prompt"]`.

```json
{
  "task": "video-generation",
  "parameters": {
    "arguments": [
      ["--prompt", "The portal slowly brightens; a locked camera holds the composition."],
      ["--seed", 42],
      ["--height", 512],
      ["--width", 768],
      ["--num-frames", 121],
      ["--frame-rate", 24],
      ["--image", {"input": "first.png"}, 0, 1.0]
    ]
  },
  "inputs": [{"name": "first.png", "path": "./first.png"}]
}
```

Input paths resolve relative to this request file before the transport snapshots them. The adapter restores the filename suffix in a job-local hard link (or a copy across filesystems), because the transport cache itself is extensionless. Inputs are read-only model references, not an output location.

## Profile bindings

Set `command` to `[MODEL_PYTHON, ADAPTER_PATH, "--pipeline", PIPELINE]`.

| Pipeline | Registered weights |
| --- | --- |
| `distilled` | `transformer` (distilled), `text_encoder`, `video_vae`, `audio_vae`, `spatial_upsampler` |
| `keyframe_interpolation` | `transformer` (dev), `text_encoder`, `video_vae`, `audio_vae`, `spatial_upsampler`, `distilled_lora` |
| `retake` | `transformer` (distilled), `text_encoder`, `video_vae`, `audio_vae` |

Each entry is `{ "path": "/absolute/path/on/host", "revision": "deployment-label" }`. Use components compatible with LTX-2.5; filenames and labels alone are not a compatibility check. The adapter binds these paths to the corresponding official flags; requests cannot replace component paths or `--output-path`.

For an extra style/control LoRA, register a weight such as `style` and add `["--lora", {"weight":"style"}, 0.8]`. This does not establish that the LoRA is compatible with the selected pipeline. A separate `prompt_enhancer` weight can supply the optional `--prompt-enhancer-gemma-root` for prompt enhancement; no automatic download is attempted.

## Native options

All pipelines accept the following reviewed options:

- `--prompt`, `--seed`, `--offload`, `--quantization`, `--compile`, `--hdr`, `--diffvae-optimization`
- `--enhance-prompt`, `--enhance-static-cache`, repeated `--lora`

`distilled` and `keyframe_interpolation` additionally accept:

- `--height`, `--width`, `--num-frames`, `--frame-rate`
- repeated `--image INPUT FRAME_INDEX STRENGTH [CRF]`

`distilled` additionally accepts the official generated-keyframe and long-clip controls: `--num-generated-keyframes`, `--decode-with-keyframes`, `--chunked`, `--chunk-pixel-frames`, `--chunk-carry-frames`, `--chunk-blend-frames`.

`keyframe_interpolation` additionally accepts `--negative-prompt`, `--num-inference-steps`, `--max-batch-size`, video/audio CFG and STG guidance scales, rescale scales, skip steps and STG blocks, plus `--a2v-guidance-scale` and `--v2a-guidance-scale`. Add two or more `--image` groups at the intended frame indices for keyframe interpolation. It requires the matching dev model and refinement LoRA, not just a different entry point.

`retake` requires `--video-path`, `--start-time`, and `--end-time`, and also accepts `--max-batch-size`:

```json
{
  "task": "video-generation",
  "parameters": {
    "arguments": [
      ["--prompt", "Keep the composition; the portal flashes briefly then dims."],
      ["--seed", 43],
      ["--video-path", {"input":"shot.mp4"}],
      ["--start-time", 1.0],
      ["--end-time", 3.0]
    ]
  },
  "inputs": [{"name":"shot.mp4", "path":"./shot.mp4"}]
}
```

The reviewed retake CLI regenerates both video and audio inside the selected interval, retaining the source size and frame rate. Its source frame count must satisfy `8k+1`, and width/height must be multiples of 32. Prepare mismatched clips explicitly with existing media tools; the adapter does not silently crop/resample them. Separate audio-only/video-only retakes are Python API features, not exposed by this CLI adapter.

The official parser checks option arity and value constraints. Unknown or pipeline-inapplicable options are rejected by the adapter, including abbreviated option names. Backend defaults remain backend defaults; the package does not tune them or fall back after OOM. For controlled experiments, set relevant options explicitly and retain the profile/request receipt.

Output is `video.mp4` and the remote-assets `manifest.json`. The manifest is a file contract, not proof of timing, quality, looping, alpha or engine compatibility.
