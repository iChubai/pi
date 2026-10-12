#!/usr/bin/env python3
"""Submit and retrieve asset generations without moving the local Pi workspace."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import runner

RUNNER = Path(__file__).with_name("runner.py")


class TransportError(RuntimeError):
    pass


class Transport:
    def __init__(self, host: dict):
        self.host = host

    def command(self, arguments: list[str]) -> list[str]:
        if self.host["transport"] == "local":
            return arguments
        return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
                "--", self.host["target"], shlex.join(arguments)]

    def run(self, arguments: list[str], *, data: bytes | None = None, source: Path | None = None,
            destination: Path | None = None, append: bool = False) -> bytes:
        input_stream = source.open("rb") if source else None
        output_stream = destination.open("ab" if append else "wb") if destination else None
        try:
            result = subprocess.run(
                self.command(arguments), input=data, stdin=input_stream,
                stdout=output_stream if output_stream else subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=self.host.get("timeout_seconds", 120),
            )
            if output_stream:
                output_stream.flush()
                os.fsync(output_stream.fileno())
            if result.returncode:
                message = result.stderr.decode("utf-8", errors="replace")[-4096:]
                raise TransportError(f"Command exited {result.returncode}: {message}")
            return result.stdout or b""
        except (OSError, subprocess.TimeoutExpired) as error:
            raise TransportError(str(error)) from error
        finally:
            if input_stream:
                input_stream.close()
            if output_stream:
                output_stream.close()

    def call(self, worker: str, action: str, *arguments: str, data: bytes | None = None,
             source: Path | None = None) -> dict:
        raw = self.run([self.host["python"], worker, "--root", self.host["root"], action, *arguments],
                       data=data, source=source)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("Response is not an object")
            return value
        except (ValueError, UnicodeError) as error:
            raise TransportError("Invalid runner response; generation state may be unknown") from error

    def install(self, source: Path, worker: str) -> None:
        if self.host["transport"] == "local":
            target = Path(worker)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
                temporary.write(source.read_bytes())
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary.name, target)
        else:
            # Only reviewed paths enter the shell. Requests/prompts are always JSON
            # on stdin or in files; they are never interpolated into commands.
            temporary = f"{worker}.upload-{uuid.uuid4().hex}"
            script = (f"umask 077; mkdir -p -- {shlex.quote(str(Path(worker).parent))} && "
                      f"cat > {shlex.quote(temporary)} && mv -- {shlex.quote(temporary)} {shlex.quote(worker)}")
            self.run(["sh", "-c", script], source=source)


def load_config(path: Path) -> tuple[dict, Path]:
    config = runner.read_json(path)
    if type(config.get("version")) is not int or config["version"] != runner.PROTOCOL:
        raise ValueError("Unsupported configuration version")
    hosts = config.get("hosts")
    profiles = config.get("profiles")
    if not isinstance(hosts, dict) or not hosts or not isinstance(profiles, dict) or not profiles:
        raise ValueError("Configuration must contain hosts and profiles")
    for name, host in hosts.items():
        if not isinstance(host, dict) or host.get("transport") not in {"ssh", "local"}:
            raise ValueError(f"Invalid transport for {name}")
        if not isinstance(host.get("root"), str) or not Path(host["root"]).is_absolute():
            raise ValueError(f"Host {name} requires an absolute root path (no ~ expansion)")
        if host["transport"] == "ssh" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", host.get("target", "")):
            raise ValueError("SSH targets must be aliases from the user's SSH configuration")
        if not isinstance(host.get("python"), str) or not host["python"] or "\x00" in host["python"]:
            raise ValueError("Each host requires a Python executable")
        timeout = host.get("timeout_seconds", 120)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Host timeout_seconds must be finite and positive")
    for name, profile in profiles.items():
        if not isinstance(profile, dict) or profile.get("host") not in hosts:
            raise ValueError(f"Unknown host for profile {name}")
        runner.validate_profile(profile)
    if config.get("default_profile") not in profiles:
        raise ValueError("default_profile must name a configured profile")
    state = config.get("state_dir", ".remote-assets")
    if not isinstance(state, str) or not state:
        raise ValueError("state_dir must be a path")
    directory = Path(state).expanduser()
    if not directory.is_absolute():
        directory = path.resolve().parent / directory
    return config, directory.resolve()


def worker_path(host: dict) -> str:
    return str(Path(host["root"]) / "workers" / runner.RUNNER_VERSION / "runner.py")


def check_profile(config: dict, directory: Path, name: str) -> dict:
    if name not in config["profiles"]:
        raise ValueError(f"Unknown profile: {name}")
    profile = copy.deepcopy(config["profiles"][name])
    host = copy.deepcopy(config["hosts"][profile["host"]])
    result = Transport(host).call(worker_path(host), "validate-profile", data=runner.encoded(profile))
    report = directory / "checks" / f"{quote(name, safe='')}.json"
    result = {**result, "profile_name": name, "profile": profile, "host": host,
              "runner_version": runner.RUNNER_VERSION, "report_path": str(report)}
    runner.atomic_json(report, result)
    return result


def snapshot_input(source: Path, directory: Path) -> tuple[str, int]:
    if not source.is_file():
        raise ValueError(f"Input is not a file: {source}")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".input-", dir=directory)
    try:
        # One digest during the copy lets later requests skip uploading this input.
        digest = hashlib.sha256()
        with source.open("rb") as stream, os.fdopen(descriptor, "wb") as target:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                target.write(chunk)
                digest.update(chunk)
            size = target.tell()
            target.flush()
            os.fsync(target.fileno())
        cache_key = digest.hexdigest()
        os.replace(temporary, directory / cache_key)
        return cache_key, size
    finally:
        Path(temporary).unlink(missing_ok=True)


def prepare(config: dict, directory: Path, request_path: Path, profile_name: str | None,
            generation: str | None = None) -> dict:
    generation = runner.checked_id(generation) if generation else uuid.uuid4().hex
    record = directory / "runs" / generation
    with runner.locked(record / "receipt.lock"):
        if (record / "receipt.json").exists():
            raise ValueError("Generation ID already exists locally; use resume rather than submit")
        profile_name = profile_name or config["default_profile"]
        if profile_name not in config["profiles"]:
            raise ValueError(f"Unknown profile: {profile_name}")
        profile = copy.deepcopy(config["profiles"][profile_name])
        source = runner.read_json(request_path)
        if set(source) - {"task", "parameters", "inputs"}:
            raise ValueError("Request accepts only task, parameters, and inputs")
        inputs = []
        for item in source.get("inputs", []):
            path = Path(item["path"]).expanduser()
            if not path.is_absolute():
                path = request_path.resolve().parent / path
            cache_key, size = snapshot_input(path, directory / "inputs")
            inputs.append({"name": item["name"], "sha256": cache_key, "size": size})
        request = {"version": runner.PROTOCOL, "id": generation, "profile": profile,
                   "task": source["task"], "parameters": source.get("parameters", {}), "inputs": inputs}
        runner.validate_request(request)
        host = copy.deepcopy(config["hosts"][profile["host"]])
        receipt = {"version": runner.PROTOCOL, "id": generation, "profile_name": profile_name,
                   "host": host, "worker": worker_path(host), "runner_version": runner.RUNNER_VERSION,
                   "request": request, "created_at": time.time()}
        # This receipt freezes routing and execution parameters before any remote write.
        runner.atomic_json(record / "receipt.json", receipt)
    return receipt


def receipt_for(directory: Path, generation: str) -> dict:
    record = directory / "runs" / runner.checked_id(generation) / "receipt.json"
    if not record.exists():
        raise ValueError(f"Unknown local generation: {generation}")
    return runner.read_json(record)


def observe(directory: Path, receipt: dict, transport: Transport | None = None) -> dict:
    transport = transport or Transport(receipt["host"])
    try:
        result = transport.call(receipt["worker"], "status", receipt["id"])
        runner.atomic_json(directory / "runs" / receipt["id"] / "observation.json", result)
        return result
    except TransportError as error:
        last = directory / "runs" / receipt["id"] / "observation.json"
        return {"id": receipt["id"], "state": "unknown", "transport_error": str(error),
                "last_observation": runner.read_json(last) if last.exists() else None,
                "hint": "Query this ID again. Do not submit a replacement or switch machines."}


def send(directory: Path, receipt: dict, transport: Transport | None = None) -> dict:
    transport = transport or Transport(receipt["host"])
    generation = receipt["id"]
    start = time.monotonic()
    try:
        for item in receipt["request"].get("inputs", []):
            if not transport.call(receipt["worker"], "has", item["sha256"])["present"]:
                transport.call(receipt["worker"], "put", item["sha256"], str(item["size"]),
                               source=directory / "inputs" / item["sha256"])
        uploaded = time.monotonic()
        result = transport.call(receipt["worker"], "submit", data=runner.encoded(receipt["request"]))
        runner.atomic_json(directory / "runs" / generation / "observation.json", result)
        runner.atomic_json(directory / "runs" / generation / f"send-{time.time_ns()}.json",
                           {"input_seconds": uploaded - start, "submit_seconds": time.monotonic() - uploaded})
        return result
    except TransportError as error:
        return {"id": generation, "state": "unknown", "transport_error": str(error),
                "hint": "Receipt saved. Use status or resume with this ID; do not create a replacement."}


def fetch(directory: Path, receipt: dict, previews_only: bool = False, transport: Transport | None = None) -> dict:
    transport = transport or Transport(receipt["host"])
    folder = directory / "runs" / receipt["id"]
    observation = folder / "observation.json"
    current = runner.read_json(observation) if observation.exists() else {}
    if current.get("state") != "succeeded":
        current = observe(directory, receipt, transport)
    if current["state"] != "succeeded":
        raise ValueError(f"Cannot fetch artifacts while state is {current['state']}")
    start = time.monotonic()
    files = []
    with runner.locked(folder / "fetch.lock"):
        for item in current["result"]["artifacts"]:
            if previews_only and item["role"] != "preview":
                continue
            if type(item["size"]) is not int or item["size"] < 0:
                raise ValueError("Invalid artifact size")
            target = runner.relative_file(folder / "files", item["path"])
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not target.exists():
                # Separate partial-file namespace avoids collisions with adapter filenames.
                partial = runner.relative_file(folder / "partial", item["path"])
                partial.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                offset = partial.stat().st_size if partial.exists() else 0
                if offset > item["size"]:
                    raise ValueError("Partial download exceeds expected size; inspect it before retrying")
                arguments = [receipt["host"]["python"], receipt["worker"], "--root", receipt["host"]["root"],
                             "get", receipt["id"], item["path"], "--offset", str(offset)]
                transport.run(arguments, destination=partial, append=True)
                if partial.stat().st_size != item["size"]:
                    raise ValueError("Download is incomplete; fetch again to resume")
                os.replace(partial, target)
            files.append({**item, "local_path": str(target)})
    result = {"id": receipt["id"], "files": files, "transfer_seconds": time.monotonic() - start,
              "validation": "files-only; engine import and visual/behavioral checks still required"}
    runner.atomic_json(folder / f"fetch-{time.time_ns()}.json", result)
    return result


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("profiles")
    sub.add_parser("list")
    for name in ("setup", "doctor"):
        command = sub.add_parser(name)
        command.add_argument("--host", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--profile", required=True)
    submit = sub.add_parser("submit")
    submit.add_argument("--request", type=Path, required=True)
    submit.add_argument("--profile")
    submit.add_argument("--id")
    for name in ("status", "resume", "cancel", "logs", "fetch", "wait"):
        command = sub.add_parser(name)
        command.add_argument("id")
        if name == "fetch":
            command.add_argument("--previews", action="store_true")
        if name == "wait":
            command.add_argument("--seconds", type=float, default=60)
            command.add_argument("--interval", type=float, default=2)
    args = parser.parse_args()
    config, directory = load_config(args.config)
    if args.action == "profiles":
        result = {"default_profile": config["default_profile"], "profiles": config["profiles"]}
    elif args.action == "list":
        result = {"generations": [{"id": path.parent.name, "profile": runner.read_json(path)["profile_name"]}
                                  for path in sorted((directory / "runs").glob("*/receipt.json"))]}
    elif args.action in {"setup", "doctor"}:
        if args.host not in config["hosts"]:
            raise ValueError(f"Unknown host: {args.host}")
        host = config["hosts"][args.host]
        transport = Transport(host)
        worker = worker_path(host)
        if args.action == "setup":
            transport.install(RUNNER, worker)
        result = transport.call(worker, "doctor")
        result["runner_version"] = runner.RUNNER_VERSION
    elif args.action == "validate":
        result = check_profile(config, directory, args.profile)
    elif args.action == "submit":
        receipt = prepare(config, directory, args.request, args.profile, args.id)
        result = send(directory, receipt)
    else:
        receipt = receipt_for(directory, args.id)
        transport = Transport(receipt["host"])
        if args.action == "status":
            result = observe(directory, receipt, transport)
        elif args.action == "resume":
            result = send(directory, receipt, transport)
        elif args.action == "fetch":
            result = fetch(directory, receipt, args.previews, transport)
        elif args.action in {"cancel", "logs"}:
            result = transport.call(receipt["worker"], args.action, args.id)
        else:
            if not math.isfinite(args.seconds) or args.seconds <= 0 or not math.isfinite(args.interval) or args.interval <= 0:
                raise ValueError("Wait duration and interval must be finite and positive")
            deadline = time.monotonic() + args.seconds
            previous = None
            while True:
                remaining = max(0.001, deadline - time.monotonic())
                bounded = Transport({**receipt["host"], "timeout_seconds": min(
                    remaining, receipt["host"].get("timeout_seconds", 120))})
                result = observe(directory, receipt, bounded)
                if result["state"] != previous:
                    print(json.dumps({"id": args.id, "state": result["state"]}), file=sys.stderr, flush=True)
                    previous = result["state"]
                if result["state"] in runner.TERMINAL or (result["state"] == "unknown" and "transport_error" not in result):
                    break
                if time.monotonic() >= deadline:
                    result = {**result, "wait_expired": True, "hint": "Only local waiting stopped; generation was not canceled"}
                    break
                time.sleep(min(args.interval, max(0, deadline - time.monotonic())))
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    if result.get("ok") is False or result.get("state") in {"failed", "canceled", "unknown", "not_found"} or result.get("wait_expired"):
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, TransportError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        sys.exit(1)
