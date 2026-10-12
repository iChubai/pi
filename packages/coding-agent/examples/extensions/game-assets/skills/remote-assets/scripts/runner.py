#!/usr/bin/env python3
"""Portable, dependency-free runner for trusted adapters on POSIX development machines."""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from urllib.parse import quote

PROTOCOL = 1
RUNNER_VERSION = "2"
TERMINAL = {"succeeded", "failed", "canceled"}


def read_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def encoded(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode("utf-8")


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def checked_id(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("Generation ID must be 32 lowercase hexadecimal characters")
    return value


def checked_cache_key(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("Invalid input cache key")
    return value


def relative_file(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError("Invalid relative artifact path")
    if name.startswith("/") or any(part in {"", ".", ".."} for part in name.split("/")):
        raise ValueError(f"Unsafe relative path: {name}")
    path = root.joinpath(*PurePosixPath(name).parts)
    for parent in [path, *path.parents]:
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError(f"Symlinks are not allowed: {name}")
    if root.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Path escapes artifact directory: {name}")
    return path


@contextmanager
def locked(path: Path, blocking: bool = True):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a+b") as stream:
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(stream, flags)
        # Close rather than LOCK_UN: an adapter may inherit this same lock.
        # If the supervisor dies, the live adapter must keep the resource busy.
        yield stream


def validate_profile(profile: dict) -> None:
    """Check configuration shape only; never inspect a model environment here."""
    if not isinstance(profile, dict):
        raise ValueError("profile must be an object")
    command = profile.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) and arg and "\x00" not in arg for arg in command):
        raise ValueError("profile.command must be a nonempty argv array")
    environment = profile.get("env", {})
    if not isinstance(environment, dict) or not all(
        re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) and isinstance(value, str) and "\x00" not in value
        for key, value in environment.items()
    ):
        raise ValueError("profile.env must map environment names to strings")
    for field in ("model", "revision", "resource"):
        if not isinstance(profile.get(field), str) or not profile[field]:
            raise ValueError(f"profile.{field} is required")
    tasks = profile.get("tasks")
    if not isinstance(tasks, list) or not tasks or not all(isinstance(task, str) and task for task in tasks):
        raise ValueError("profile.tasks must be a nonempty list of tasks")
    seconds = profile.get("max_seconds", 600)
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("profile.max_seconds must be finite and positive")
    if profile.get("cancel", "none") not in {"none", "process-group"}:
        raise ValueError("profile.cancel must be none or process-group")
    paths = {}
    if "cwd" in profile:
        paths["cwd"] = profile["cwd"]
    if "code" in profile:
        code = profile["code"]
        if not isinstance(code, dict) or set(code) - {"path", "revision"}:
            raise ValueError("profile.code accepts path and optional revision")
        paths["code.path"] = code.get("path")
        if "revision" in code and (not isinstance(code["revision"], str) or not code["revision"]):
            raise ValueError("profile.code.revision must be a version label")
    weights = profile.get("weights", {})
    if not isinstance(weights, dict):
        raise ValueError("profile.weights must map names to path/revision objects")
    for name, weight in weights.items():
        if not name or not isinstance(weight, dict) or set(weight) != {"path", "revision"}:
            raise ValueError("Each named weight requires path and revision")
        if not isinstance(weight["revision"], str) or not weight["revision"]:
            raise ValueError("Weight revision must identify a provisioned snapshot")
        paths[f"weights.{name}.path"] = weight["path"]
    for name, value in paths.items():
        if not isinstance(value, str) or "\x00" in value or not Path(value).is_absolute():
            raise ValueError(f"profile.{name} must be an absolute path (no ~ expansion)")
    if "python_modules" in profile:
        modules = profile["python_modules"]
        if not isinstance(modules, list) or not all(
            isinstance(name, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) for name in modules
        ):
            raise ValueError("profile.python_modules must list top-level Python module names")
    encoded(profile)


def inspect_profile(profile: dict) -> dict:
    """Explicit, read-only preflight. Does not invoke the adapter or load weights."""
    validate_profile(profile)
    environment = {**os.environ, **profile.get("env", {})}
    cwd = profile.get("cwd")
    command = profile["command"][0]
    if "/" in command and not Path(command).is_absolute():
        # An undeclared cwd is a future run directory, not the SSH login directory.
        executable = shutil.which(str(Path(cwd) / command)) if cwd else None
    else:
        executable = shutil.which(command, path=environment.get("PATH", os.defpath))
    checks = {"command": {"ok": executable is not None, "executable": executable}}

    def inspect_path(name: str, value: str, directory_only: bool = False) -> dict:
        path = Path(value)
        is_directory = path.is_dir()
        readable = os.access(path, os.R_OK | (os.X_OK if is_directory else 0))
        check = {"ok": readable and (is_directory or (not directory_only and path.is_file())), "path": value}
        checks[name] = check
        return check

    if cwd:
        inspect_path("cwd", cwd, directory_only=True)
    code = profile.get("code")
    if code:
        check = inspect_path("code", code["path"])
        if "revision" in code:
            check["revision"] = code["revision"]
    for name, weight in profile.get("weights", {}).items():
        check = inspect_path(f"weights.{name}", weight["path"])
        check["revision"] = weight["revision"]
    if "python_modules" in profile and executable:
        try:
            # Run this standard-library probe with the model Python, not host.python.
            # find_spec on top-level names does not import the requested packages.
            probe = subprocess.run(
                [executable, "-B", str(Path(__file__).resolve()), "--root", "/", "python-info"],
                input=encoded(profile["python_modules"]), cwd=cwd, env=environment,
                check=True, capture_output=True, timeout=10,
            )
            info = json.loads(probe.stdout)
            checks["python"] = {**info, "ok": all(info["modules"].values())}
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            checks["python"] = {"ok": False, "error": str(error)}
    return {"ok": all(check["ok"] for check in checks.values()), "checks": checks,
            "checked_at": time.time(), "scope": "environment-and-paths", "inference_tested": False}


def validate_request(request: dict) -> None:
    if not isinstance(request, dict) or type(request.get("version")) is not int or request["version"] != PROTOCOL:
        raise ValueError("Unsupported request version")
    checked_id(request["id"])
    validate_profile(request["profile"])
    if request.get("task") not in request["profile"]["tasks"]:
        raise ValueError("The configured profile does not support this task")
    if not isinstance(request.get("parameters", {}), dict):
        raise ValueError("parameters must be an object")
    inputs = request.get("inputs", [])
    if not isinstance(inputs, list):
        raise ValueError("inputs must be an array")
    names = set()
    for item in inputs:
        name = item["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) or name in names:
            raise ValueError("Input names must be unique, simple filenames")
        names.add(name)
        checked_cache_key(item["sha256"])
        if type(item["size"]) is not int or item["size"] < 0:
            raise ValueError("Invalid input size")
    encoded(request)


def run_dir(root: Path, generation: str) -> Path:
    return root / "runs" / checked_id(generation)


def state(path: Path, status: str, **fields: object) -> dict:
    previous = read_json(path / "state.json") if (path / "state.json").exists() else {}
    result = {**previous, **fields, "state": status, "updated_at": time.time()}
    atomic_json(path / "state.json", result)
    return result


def status(root: Path, generation: str) -> dict:
    path = run_dir(root, generation)
    if not (path / "request.json").exists():
        return {"id": generation, "state": "not_found", "observed_at": time.time()}
    request = read_json(path / "request.json")
    current = read_json(path / "state.json") if (path / "state.json").exists() else {"state": "prepared"}
    if current["state"] not in TERMINAL and (path / "execution-started.json").exists():
        try:
            with locked(path / "run.lock", blocking=False):
                # Completion may have happened between the initial read and this lock.
                current = read_json(path / "state.json")
                if current["state"] not in TERMINAL:
                    current = {**current, "last_recorded_state": current["state"], "state": "unknown",
                               "error": "Execution was started but no owner holds its lock; inspect logs, do not rerun"}
        except BlockingIOError:
            pass
    result = {**current, "id": generation,
              "model": request["profile"]["model"], "revision": request["profile"]["revision"],
              "resource": request["profile"]["resource"], "observed_at": time.time()}
    if current["state"] == "succeeded":
        result["result"] = read_json(path / "result.json")
    return result


def submit(root: Path, request: dict) -> dict:
    validate_request(request)
    path = run_dir(root, request["id"])
    with locked(path / "submit.lock"):
        existing = path / "request.json"
        if existing.exists():
            if encoded(read_json(existing)) != encoded(request):
                raise ValueError("Generation ID already belongs to a different request")
        else:
            for item in request.get("inputs", []):
                blob = root / "inputs" / checked_cache_key(item["sha256"])
                if not blob.is_file() or blob.stat().st_size != item["size"]:
                    raise ValueError(f"Input is missing or incomplete: {item['name']}")
            state(path, "prepared", created_at=time.time())
            atomic_json(existing, request)
        current = status(root, request["id"])
        if current["state"] not in TERMINAL and current["state"] != "unknown":
            with (path / "worker.log").open("ab", buffering=0) as log:
                subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), "--root", str(root), "run", request["id"]],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True,
                )
        return status(root, request["id"])


def collect_outputs(path: Path) -> dict:
    output = path / "output"
    manifest_path = relative_file(output, "manifest.json")
    if manifest_path.stat().st_size > 65536:
        raise ValueError("Artifact manifest must not exceed 64 KiB; store large metadata as an auxiliary file")
    manifest = read_json(manifest_path)
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts or len(artifacts) > 128:
        raise ValueError("Adapter must emit 1..128 artifacts in output/manifest.json")
    result = []
    seen = set()
    for artifact in artifacts:
        name = artifact["path"]
        file = relative_file(output, name)
        if name == "manifest.json" or name in seen or not stat.S_ISREG(file.stat().st_mode):
            raise ValueError("Artifacts must be distinct regular files, not manifest.json")
        if artifact.get("role") not in {"asset", "preview", "auxiliary"}:
            raise ValueError("Artifact role must be asset, preview, or auxiliary")
        if not isinstance(artifact.get("format"), str) or not artifact["format"]:
            raise ValueError("Artifact format is required")
        seen.add(name)
        result.append({"path": name, "role": artifact["role"], "format": artifact["format"],
                       "size": file.stat().st_size})
    if not any(item["role"] == "asset" for item in result):
        raise ValueError("At least one asset is required")
    return {"artifacts": result, "metadata": manifest.get("metadata", {}), "validation": "files-only"}


def execute(root: Path, generation: str) -> None:
    path = run_dir(root, generation)
    child = None
    try:
        with locked(path / "run.lock", blocking=False) as run_lock:
            request = read_json(path / "request.json")
            current = read_json(path / "state.json") if (path / "state.json").exists() else state(path, "prepared")
            if current["state"] in TERMINAL or (path / "execution-started.json").exists():
                return
            profile = request["profile"]
            resource = quote(profile["resource"], safe="")
            started_waiting = time.monotonic()
            state(path, "waiting", worker_pid=os.getpid())
            resource_path = root / "resources" / f"{resource}.lock"
            resource_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with resource_path.open("a+b") as resource_lock:
                while True:
                    if (path / "cancel-requested.json").exists():
                        state(path, "canceled", finished_at=time.time(), reason="Canceled before execution")
                        return
                    try:
                        fcntl.flock(resource_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(0.2)
                output = path / "output"
                output.mkdir(exist_ok=True, mode=0o700)
                input_paths = []
                for item in request.get("inputs", []):
                    blob = root / "inputs" / item["sha256"]
                    input_paths.append({**item, "path": str(blob)})
                adapter_request = {**request, "inputs": input_paths}
                atomic_json(path / "adapter-request.json", adapter_request)
                started = time.monotonic()
                # Durable intent precedes executing the adapter. After a crash in this
                # window we deliberately report unknown rather than risk a duplicate.
                atomic_json(path / "execution-started.json", {"at": time.time()})
                state(path, "running", started_at=time.time(), wait_seconds=started - started_waiting)
                command = [*profile["command"], "--request", str(path / "adapter-request.json"),
                           "--output", str(output)]
                with (path / "adapter.log").open("ab", buffering=0) as log:
                    child = subprocess.Popen(
                        command, cwd=profile.get("cwd", str(path)), env={**os.environ, **profile.get("env", {})},
                        stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                        pass_fds=(run_lock.fileno(), resource_lock.fileno()),
                    )
                    reason = None
                    deadline_reported = False
                    while child.poll() is None:
                        if (path / "cancel-requested.json").exists():
                            reason = "canceled"
                        elif time.monotonic() - started >= profile.get("max_seconds", 600):
                            reason = "timeout"
                        if reason:
                            if profile.get("cancel", "none") == "none":
                                # Non-cancelable adapters must keep their locks until
                                # completion. Stopping the client would not cancel a service.
                                if not deadline_reported:
                                    state(path, "running", deadline_exceeded=True)
                                    deadline_reported = True
                                reason = None
                            else:
                                os.killpg(child.pid, signal.SIGTERM)
                                try:
                                    child.wait(timeout=3)
                                except subprocess.TimeoutExpired:
                                    os.killpg(child.pid, signal.SIGKILL)
                                    child.wait()
                                break
                        time.sleep(0.2)
                    elapsed = time.monotonic() - started
                    if reason:
                        state(path, "canceled" if reason == "canceled" else "failed", error=reason,
                              finished_at=time.time(), execution_seconds=elapsed)
                    elif child.returncode != 0:
                        state(path, "failed", error=f"Adapter exited {child.returncode}",
                              finished_at=time.time(), execution_seconds=elapsed)
                    else:
                        result = collect_outputs(path)
                        atomic_json(path / "result.json", result)
                        state(path, "succeeded", finished_at=time.time(), execution_seconds=elapsed)
    except BlockingIOError:
        return
    except Exception as error:
        if child is not None and child.poll() is None:
            state(path, "unknown", error=f"Supervisor error; adapter may still be running: {error}")
        else:
            state(path, "failed", error=f"{type(error).__name__}: {error}", finished_at=time.time())


def put_input(root: Path, cache_key: str, size: int) -> dict:
    cache_key = checked_cache_key(cache_key)
    folder = root / "inputs"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".input-", dir=folder)
    try:
        with os.fdopen(descriptor, "wb") as target:
            shutil.copyfileobj(sys.stdin.buffer, target)
            target.flush()
            os.fsync(target.fileno())
        if Path(temporary).stat().st_size != size:
            raise ValueError("Uploaded input is incomplete")
        os.replace(temporary, folder / cache_key)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {"sha256": cache_key}


def cancel(root: Path, generation: str) -> dict:
    path = run_dir(root, generation)
    current = status(root, generation)
    if current["state"] in TERMINAL:
        return current
    if current["state"] in {"not_found", "unknown"}:
        raise ValueError("Cannot confirm an owner for this generation; inspect it before canceling")
    request = read_json(path / "request.json")
    if request["profile"].get("cancel", "none") != "process-group":
        raise ValueError("This adapter does not support confirmed cancellation")
    atomic_json(path / "cancel-requested.json", {"at": time.time()})
    return {**status(root, generation), "cancel_requested": True}


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("submit")
    sub.add_parser("doctor")
    sub.add_parser("validate-profile")
    sub.add_parser("python-info")
    put = sub.add_parser("put")
    put.add_argument("cache_key")
    put.add_argument("size", type=int)
    has = sub.add_parser("has")
    has.add_argument("cache_key")
    for name in ("run", "status", "cancel", "logs", "get"):
        item = sub.add_parser(name)
        item.add_argument("id")
        if name == "get":
            item.add_argument("path")
            item.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    if args.action == "run":
        execute(root, args.id)
        return 0
    if args.action == "submit":
        result = submit(root, json.load(sys.stdin))
    elif args.action == "status":
        result = status(root, args.id)
    elif args.action == "cancel":
        result = cancel(root, args.id)
    elif args.action == "put":
        result = put_input(root, args.cache_key, args.size)
    elif args.action == "has":
        blob = root / "inputs" / checked_cache_key(args.cache_key)
        result = {"present": blob.is_file()}
    elif args.action == "validate-profile":
        result = inspect_profile(json.load(sys.stdin))
    elif args.action == "python-info":
        modules = json.load(sys.stdin)
        result = {"executable": sys.executable, "version": platform.python_version(), "prefix": sys.prefix,
                  "modules": {name: importlib.util.find_spec(name) is not None for name in modules}}
    elif args.action == "doctor":
        gpu = None
        if shutil.which("nvidia-smi"):
            probe = subprocess.run(["nvidia-smi", "--query-gpu=uuid,name,memory.total,memory.free",
                                    "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
            gpu = {"exit_code": probe.returncode, "output": probe.stdout.strip(), "error": probe.stderr.strip()}
        result = {"protocol": PROTOCOL, "python": sys.version, "platform": platform.platform(),
                  "root": str(root), "nvidia": gpu, "compatibility": "not-validated"}
    elif args.action == "logs":
        result = {}
        for name in ("worker.log", "adapter.log"):
            path = run_dir(root, args.id) / name
            if path.exists():
                with path.open("rb") as stream:
                    stream.seek(max(0, path.stat().st_size - 8192))
                    result[name] = stream.read(8192).decode("utf-8", errors="replace")
    else:
        path = run_dir(root, args.id)
        if status(root, args.id)["state"] != "succeeded":
            raise ValueError("Artifacts are available only after successful file validation")
        artifacts = read_json(path / "result.json")["artifacts"]
        artifact = next((item for item in artifacts if item["path"] == args.path), None)
        if artifact is None or not 0 <= args.offset <= artifact["size"]:
            raise ValueError("Unknown artifact or invalid offset")
        with relative_file(path / "output", args.path).open("rb") as stream:
            stream.seek(args.offset)
            shutil.copyfileobj(stream, sys.stdout.buffer)
        return 0
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        sys.exit(1)
