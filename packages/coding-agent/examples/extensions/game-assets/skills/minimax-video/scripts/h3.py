#!/usr/bin/env python3
"""Persist H3 task IDs and resume observation using the official mmx CLI."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import urlopen

MODEL = "MiniMax-H3"
ENDPOINTS = {"global": "https://api.minimax.io", "cn": "https://api.minimaxi.com"}
TERMINAL = {"succeeded", "failed", "cancelled", "expired"}
OPTIONS = {"prompt", "image", "last-frame", "reference-image", "reference-video", "reference-audio",
           "duration", "ratio", "callback-url"}
REPEATABLE = {"reference-image", "reference-video", "reference-audio"}
MEDIA = REPEATABLE | {"image", "last-frame"}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value: dict) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def mutation(job: Path):
    # Submit, manual attachment, and download must not overlap for one job.
    with (job / ".lock").open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another command is modifying this job") from error
        yield


def generation_args(request: dict, directory: Path) -> list[str]:
    if not isinstance(request, dict) or set(request) - OPTIONS:
        raise ValueError(f"Request fields must be mmx options: {', '.join(sorted(OPTIONS))}")
    if not isinstance(request.get("prompt"), str) or not request["prompt"].strip():
        raise ValueError("A non-empty prompt is required")
    if ("image" in request or "last-frame" in request) and request.get("ratio", "adaptive") != "adaptive":
        raise ValueError("H3 first/last-frame input requires ratio adaptive; mmx would otherwise override it")
    arguments = []
    for name, value in request.items():
        values = value if name in REPEATABLE and isinstance(value, list) else [value]
        if not values:
            raise ValueError(f"{name} must not be empty")
        for item in values:
            if name == "duration":
                if type(item) is not int or not 4 <= item <= 15:
                    raise ValueError("duration must be an integer from 4 to 15")
            elif not isinstance(item, str) or not item.strip():
                raise ValueError(f"{name} must be a non-empty string")
            if name in MEDIA:
                if item.startswith("data:"):
                    raise ValueError("Use a local file or URL, not inline base64 in a saved request")
                if not item.startswith("mm_file://") and not urlsplit(item).scheme:
                    media = (directory / item).resolve()
                    if not media.is_file():
                        raise ValueError(f"Input file not found: {media}")
                    item = str(media)
            arguments.append(f"--{name}={item}")
    return arguments


def mmx(receipt: dict, arguments: list[str], timeout: float) -> dict:
    command = [receipt["mmx"], *arguments, "--model", MODEL, "--region", receipt["region"],
               "--base-url", ENDPOINTS[receipt["region"]], "--output", "json", "--non-interactive",
               "--timeout", str(timeout)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout,
                            env={**os.environ, "MINIMAX_VERBOSE": "0"})
    if result.returncode:
        raise ValueError(f"mmx exited {result.returncode}: {result.stderr.strip()[-8192:]}")
    response = json.loads(result.stdout)
    if not isinstance(response, dict):
        raise ValueError("Expected a JSON object from mmx")
    return response


def submit(request_path: Path, job: Path, executable: str, region: str, timeout: float) -> dict:
    arguments = generation_args(read_json(request_path), request_path.resolve().parent)
    resolved = shutil.which(executable)
    if not resolved:
        raise ValueError("mmx is not installed; provision the official CLI before submitting")
    # This directory is the submission intent. Never POST again into an existing directory.
    job.mkdir(parents=True, exist_ok=False)
    receipt = {"model": MODEL, "mmx": str(Path(resolved).absolute()), "region": region,
               "arguments": arguments, "created_at": time.time()}
    with mutation(job):
        save_json(job / "receipt.json", receipt)
        response = mmx(receipt, ["video", "generate", *arguments, "--async"], timeout)
        task_id = response.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("No task ID returned; submission is unknown. Do not resubmit")
        try:
            save_json(job / "task.json", {"task_id": task_id})
        except OSError as error:
            raise ValueError(f"Task created: {task_id}; could not save task.json: {error}") from error
    return {"job": str(job), "task_id": task_id, "model": MODEL, "status": "submitted"}


def status(job: Path, timeout: float, refresh: bool = False) -> dict:
    receipt = read_json(job / "receipt.json")
    if not (job / "task.json").exists():
        return {"job": str(job), "status": "unknown",
                "message": "No task ID saved. Submission may still be in progress or its reply was lost. "
                           "Inspect the provider task history; do not submit a replacement."}
    task_id = read_json(job / "task.json")["task_id"]
    observation = job / "observation.json"
    if not refresh and observation.exists():
        cached = read_json(observation)
        if cached.get("status") in TERMINAL:
            return cached
    result = mmx(receipt, ["video", "task", "get", "--task-id", task_id], timeout)
    if result.get("task_id") != task_id or result.get("model") != MODEL:
        raise ValueError("mmx returned a different task or model")
    if result.get("status") not in TERMINAL | {"queued", "running"}:
        raise ValueError(f"Unknown provider status: {result.get('status')}")
    result.update({"job": str(job), "observed_at": time.time()})
    save_json(observation, result)
    return result


def attach(job: Path, task_id: str, timeout: float) -> dict:
    with mutation(job):
        if (job / "task.json").exists():
            raise ValueError("This job already has a task ID; use status or wait")
        receipt = read_json(job / "receipt.json")
        result = mmx(receipt, ["video", "task", "get", "--task-id", task_id], timeout)
        if result.get("task_id") != task_id or result.get("model") != MODEL:
            raise ValueError("The supplied ID is not a matching H3 task")
        if result.get("status") not in TERMINAL | {"queued", "running"}:
            raise ValueError(f"Unknown provider status: {result.get('status')}")
        # The operator, not a latest-task heuristic, associates the provider task with this request.
        save_json(job / "task.json", {"task_id": task_id, "attached_manually": True})
        result.update({"job": str(job), "observed_at": time.time()})
        save_json(job / "observation.json", result)
    return result


def wait(job: Path, seconds: float, interval: float, timeout: float) -> dict:
    deadline = time.monotonic() + seconds
    result = {"job": str(job), "status": "unobserved"}
    while time.monotonic() < deadline:
        try:
            result = status(job, min(timeout, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return {**result, "wait_expired": True}
        if result["status"] in TERMINAL | {"unknown"}:
            return result
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(interval, remaining))
    return {**result, "wait_expired": True}


def download(url: str, destination: Path, timeout: float) -> None:
    if urlsplit(url).scheme != "https":
        raise ValueError("Expected an HTTPS video URL")
    partial = destination.with_suffix(".mp4.partial")
    with urlopen(url, timeout=timeout) as source, partial.open("wb") as target:
        expected = source.headers.get("Content-Length")
        size = 0
        while True:
            block = source.read(1024 * 1024)
            if not block:
                break
            target.write(block)
            size += len(block)
    if size == 0 or (expected is not None and size != int(expected)):
        raise ValueError("Download incomplete; fetch the same task again")
    os.replace(partial, destination)


def fetch(job: Path, timeout: float) -> dict:
    destination = job / "video.mp4"
    with mutation(job):
        if destination.is_file():
            return {"job": str(job), "status": "succeeded", "file": str(destination)}
        result = status(job, timeout)
        if result["status"] != "succeeded":
            return result
        try:
            download(result["url"], destination, timeout)
        except HTTPError as error:
            if error.code not in {403, 404}:
                raise
            # Refresh a stale signed URL, never recreate the paid task.
            result = status(job, timeout, refresh=True)
            if result["status"] != "succeeded":
                return result
            download(result["url"], destination, timeout)
    return {**result, "file": str(destination)}


def positive(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("Expected a positive finite number")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=positive, default=60, help="Per-command/network timeout in seconds")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("submit")
    create.add_argument("--request", type=Path, required=True)
    create.add_argument("--mmx", default="mmx", help="Path to an already installed official mmx CLI")
    create.add_argument("--region", choices=ENDPOINTS, default="global")
    parsers = {"submit": create}
    for name in ("status", "wait", "fetch", "attach"):
        parsers[name] = commands.add_parser(name)
    for command in parsers.values():
        command.add_argument("--job", type=Path, required=True)
    parsers["status"].add_argument("--refresh", action="store_true")
    parsers["wait"].add_argument("--seconds", type=positive, default=60)
    parsers["wait"].add_argument("--interval", type=positive, default=5)
    parsers["attach"].add_argument("--task-id", required=True)
    args = parser.parse_args()
    job = args.job.resolve()
    if args.command == "submit":
        result = submit(args.request, job, args.mmx, args.region, args.timeout)
    elif args.command == "status":
        result = status(job, args.timeout, args.refresh)
    elif args.command == "wait":
        result = wait(job, args.seconds, args.interval, args.timeout)
    elif args.command == "attach":
        result = attach(job, args.task_id, args.timeout)
    else:
        result = fetch(job, args.timeout)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 2 if result.get("wait_expired") or result.get("status") in {"failed", "cancelled", "expired", "unknown"} else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error), "recovery": "If submit was attempted, inspect the same job. Do not resubmit."}),
              file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Stopped locally. The provider task is not canceled; use the same job for status/wait/fetch.", file=sys.stderr)
        sys.exit(130)
