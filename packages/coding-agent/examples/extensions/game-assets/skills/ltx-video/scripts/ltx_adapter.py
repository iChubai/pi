#!/usr/bin/env python3
"""Remote-assets adapter for the official LTX-2.5 CLI; no model imports or provisioning."""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PIPELINES = {"distilled", "keyframe_interpolation", "retake"}
MODEL_WEIGHTS = {"transformer": "--transformer-path", "text_encoder": "--text-encoder-path",
                 "video_vae": "--video-vae-path", "audio_vae": "--audio-vae-path"}
COMMON = {"--prompt", "--seed", "--offload", "--quantization", "--compile", "--hdr",
          "--diffvae-optimization", "--enhance-prompt", "--enhance-static-cache", "--lora"}
NEW_VIDEO = {"--height", "--width", "--num-frames", "--frame-rate", "--image"}
OPTIONS = {
    "distilled": COMMON | NEW_VIDEO | {"--num-generated-keyframes", "--decode-with-keyframes", "--chunked",
                                      "--chunk-pixel-frames", "--chunk-carry-frames", "--chunk-blend-frames"},
    "keyframe_interpolation": COMMON | NEW_VIDEO | {
        "--negative-prompt", "--num-inference-steps", "--video-cfg-guidance-scale", "--video-stg-guidance-scale",
        "--video-rescale-scale", "--a2v-guidance-scale", "--video-skip-step", "--video-stg-blocks",
        "--audio-cfg-guidance-scale", "--audio-stg-guidance-scale", "--audio-rescale-scale",
        "--v2a-guidance-scale", "--audio-skip-step", "--audio-stg-blocks", "--max-batch-size"},
    "retake": COMMON | {"--video-path", "--start-time", "--end-time", "--max-batch-size"},
}


def weight_path(profile: dict, name: str) -> str:
    try:
        path = Path(profile["weights"][name]["path"])
    except KeyError as error:
        raise ValueError(f"Register the {name} weight in profile.weights") from error
    if not path.is_absolute():
        raise ValueError(f"Registered {name} weight must be an absolute path")
    return str(path)


def command(request: dict, output: Path, pipeline: str) -> list[str]:
    if request.get("task") != "video-generation":
        raise ValueError("LTX adapter only supports video-generation")
    parameters = request["parameters"]
    if not isinstance(parameters, dict) or set(parameters) != {"arguments"}:
        raise ValueError("parameters must contain only arguments, a list of native LTX option groups")
    groups = parameters["arguments"]
    if not isinstance(groups, list) or not groups:
        raise ValueError("arguments must be a non-empty list of option groups")
    profile = request["profile"]
    weights = dict(MODEL_WEIGHTS)
    if pipeline != "retake":
        weights["spatial_upsampler"] = "--spatial-upsampler-path"
    if pipeline == "keyframe_interpolation":
        weights["distilled_lora"] = "--distilled-lora"
    if "prompt_enhancer" in profile.get("weights", {}):
        weights["prompt_enhancer"] = "--prompt-enhancer-gemma-root"
    arguments = [sys.executable, "-m", f"ltx_pipelines.{pipeline}"]
    for name, flag in weights.items():
        arguments.extend([flag, weight_path(profile, name)])
    inputs = {item["name"]: item for item in request.get("inputs", [])}
    prepared = {}
    seen = set()
    for group in groups:
        if not isinstance(group, list) or not group or not isinstance(group[0], str) or group[0] not in OPTIONS[pipeline]:
            raise ValueError(f"Unsupported {pipeline} option group: {group}")
        flag = group[0]
        if flag in seen and flag not in {"--image", "--lora"}:
            raise ValueError(f"Duplicate option: {flag}")
        seen.add(flag)
        if flag in {"--image", "--video-path", "--lora"}:
            binding = "weight" if flag == "--lora" else "input"
            if len(group) < 2 or not isinstance(group[1], dict) or set(group[1]) != {binding}:
                raise ValueError(f"{flag} requires a {{{binding}: name}} binding, not a host-local path")
        values = []
        for value in group[1:]:
            if isinstance(value, dict) and set(value) == {"weight"}:
                values.append(weight_path(profile, value["weight"]))
            elif isinstance(value, dict) and set(value) == {"input"}:
                name = value["input"]
                if name not in inputs:
                    raise ValueError(f"Unknown input: {name}")
                if name not in prepared:
                    # The transport cache is extensionless. A hard link retains the media suffix
                    # without another large copy; copy only when the input is on another filesystem.
                    directory = output.parent / "ltx-inputs"
                    directory.mkdir(exist_ok=True)
                    local = directory / f"{len(prepared)}{Path(name).suffix}"
                    try:
                        os.link(inputs[name]["path"], local)
                    except OSError as error:
                        if error.errno != errno.EXDEV:
                            raise
                        shutil.copyfile(inputs[name]["path"], local)
                    prepared[name] = str(local)
                values.append(prepared[name])
            elif type(value) in {str, int, float}:
                values.append(str(value))
            else:
                raise ValueError(f"Invalid value for {flag}: {value}")
        # A scalar prompt starting with '--' is still data, never a second CLI flag.
        if len(values) == 1:
            arguments.append(f"{flag}={values[0]}")
        else:
            if any(value.startswith("--") for value in values):
                raise ValueError(f"Option-looking value in multi-value group: {flag}")
            arguments.extend([flag, *values])
    if "--prompt" not in seen:
        raise ValueError("--prompt is required")
    if pipeline == "retake" and not {"--video-path", "--start-time", "--end-time"} <= seen:
        raise ValueError("retake requires --video-path, --start-time, and --end-time")
    arguments.extend(["--output-path", str(output / "video.mp4")])
    return arguments


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pipeline", choices=sorted(PIPELINES), required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    argv = command(request, output, args.pipeline)
    # Keep the runner's inherited resource locks in the model child, including if
    # this adapter is killed. The child stays in the runner-owned process group.
    subprocess.run(argv, check=True, close_fds=False,
                   env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    video = output / "video.mp4"
    if not video.is_file() or video.stat().st_size == 0:
        raise ValueError("LTX exited without producing video.mp4")
    manifest = {"artifacts": [{"path": "video.mp4", "role": "asset", "format": "mp4"}],
                "metadata": {"model": request["profile"]["model"], "pipeline": args.pipeline}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"LTX adapter: {error}", file=sys.stderr)
        sys.exit(1)
