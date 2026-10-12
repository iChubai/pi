#!/usr/bin/env python3
"""ElevenLabs native TTS, sound-effects and music requests; no automatic POST retries."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import sys
import tempfile
import time
from contextlib import contextmanager
from http.client import HTTPResponse, IncompleteRead
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

HOSTS = {"global": "https://api.elevenlabs.io", "us": "https://api.us.elevenlabs.io",
         "eu": "https://api.eu.residency.elevenlabs.io", "in": "https://api.in.residency.elevenlabs.io",
         "sg": "https://api.sg.residency.elevenlabs.io"}
PATHS = {"sound-effects": "/v1/sound-generation", "music": "/v1/music"}
BODY_FIELDS = {
    "tts": {"text", "model_id", "language_code", "voice_settings", "pronunciation_dictionary_locators", "seed",
            "previous_text", "next_text", "previous_request_ids", "next_request_ids", "use_pvc_as_ivc",
            "apply_text_normalization", "apply_language_text_normalization"},
    "sound-effects": {"text", "loop", "duration_seconds", "prompt_influence", "model_id"},
    "music": {"prompt", "composition_plan", "music_length_ms", "model_id", "seed", "force_instrumental",
              "finetune_id", "respect_sections_durations", "store_for_inpainting", "sign_with_c2pa"},
}
CATALOG_PATHS = {"models": "/v1/models", "voices": "/v2/voices", "history": "/v1/history"}
CATALOG_FIELDS = {
    "models": set(),
    "voices": {"search", "page_size", "next_page_token", "voice_type", "category", "sort", "sort_direction"},
    "history": {"page_size", "start_after_history_item_id", "voice_id", "model_id", "date_before_unix",
                "date_after_unix", "sort_direction", "search", "source"},
}
CODECS = {"mp3", "wav", "pcm", "opus", "ulaw", "alaw"}
MIME_EXTENSIONS = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
                   "audio/ogg": "ogg", "application/ogg": "ogg", "audio/opus": "opus",
                   "audio/pcm": "pcm", "audio/basic": "ulaw", "audio/flac": "flac"}
SAVED_HEADERS = ("request-id", "history-item-id", "song-id", "character-cost")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Keep xi-api-key on the explicitly selected official API host.
        raise ValueError("Unexpected API redirect; no credentials forwarded")


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
def locked(job: Path):
    with (job / ".lock").open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def api_key() -> str:
    value = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not value:
        raise ValueError("Set ELEVENLABS_API_KEY in the process environment; do not put it in requests")
    return value


def open_api(region: str, path: str, key: str, timeout: float, body: dict | None = None,
             query: dict | None = None) -> HTTPResponse:
    parameters = {name: str(value).lower() if isinstance(value, bool) else value
                  for name, value in (query or {}).items() if value is not None}
    url = HOSTS[region] + path + ("?" + urlencode(parameters) if parameters else "")
    payload = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
    request = Request(url, data=payload, headers={"xi-api-key": key, "Content-Type": "application/json"},
                      method="GET" if body is None else "POST")
    return build_opener(NoRedirects()).open(request, timeout=timeout)


def validate(request: dict) -> tuple[str, dict, dict]:
    if not isinstance(request, dict) or set(request) - {"operation", "voice_id", "body", "query"}:
        raise ValueError("Request accepts operation, voice_id, body and query only")
    operation = request.get("operation")
    if operation not in BODY_FIELDS:
        raise ValueError("operation must be tts, sound-effects or music")
    body = request.get("body")
    if not isinstance(body, dict) or set(body) - BODY_FIELDS[operation]:
        raise ValueError(f"Unsupported {operation} body fields")
    if not isinstance(body.get("model_id"), str) or not body["model_id"].strip():
        raise ValueError("Choose an explicit body.model_id")
    if operation in {"tts", "sound-effects"}:
        if not isinstance(body.get("text"), str) or not body["text"].strip():
            raise ValueError("body.text must be a non-empty string")
    else:
        has_prompt = isinstance(body.get("prompt"), str) and bool(body["prompt"].strip())
        has_plan = isinstance(body.get("composition_plan"), dict) and bool(body["composition_plan"])
        if has_prompt == has_plan:
            raise ValueError("music requires exactly one of prompt or composition_plan")
        if has_prompt and body.get("seed") is not None:
            raise ValueError("Music seed is supported with composition_plan, not prompt")
        if has_plan and any(body.get(name) is not None for name in ("music_length_ms", "force_instrumental")):
            raise ValueError("music_length_ms and force_instrumental apply to prompt, not composition_plan")
    if operation == "tts":
        voice = request.get("voice_id")
        if not isinstance(voice, str) or not voice.strip():
            raise ValueError("tts requires voice_id")
        path = f"/v1/text-to-speech/{quote(voice, safe='')}"
    else:
        if "voice_id" in request:
            raise ValueError("voice_id only applies to tts")
        path = PATHS[operation]
    allowed_query = {"output_format"} | ({"enable_logging", "optimize_streaming_latency"} if operation == "tts" else set())
    query = request.get("query", {})
    if not isinstance(query, dict) or set(query) - allowed_query:
        raise ValueError(f"Unsupported {operation} query fields")
    default_format = "auto" if operation == "music" else "mp3_44100_128"
    query = {"output_format": default_format, **query}
    output_format = query["output_format"]
    if not isinstance(output_format, str) or not (output_format.split("_")[0] in CODECS
                                                or (operation == "music" and output_format == "auto")):
        raise ValueError("Unsupported output_format codec; no format fallback is performed")
    # Native nested settings and plans go through unchanged; model-specific validation belongs to the API.
    return path, body, query


def receive(job: Path, response: HTTPResponse, output_format: str | None, source: dict) -> dict:
    content_type = response.headers.get("Content-Type", "").split(";")[0].lower().strip()
    if content_type and not content_type.startswith("audio/") and content_type not in {"application/octet-stream", "application/ogg"}:
        raise ValueError(f"Expected audio, received {content_type}")
    extension = output_format.split("_")[0] if output_format and output_format != "auto" else MIME_EXTENSIONS.get(content_type, "audio")
    if extension not in CODECS | {"ogg", "flac", "audio"}:
        extension = "audio"
    filename = f"audio.{extension}"
    metadata = {"file": filename, "content_type": content_type, "output_format": output_format,
                "received_at": time.time(),
                "generation_request_id": response.headers.get("request-id"), **source,
                "headers": {name: response.headers[name] for name in SAVED_HEADERS if response.headers.get(name)}}
    # Save IDs before reading the body so a failed TTS download can recover from history.
    save_json(job / "response.json", metadata)
    partial = job / f"{filename}.partial"
    with partial.open("wb") as target:
        size = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            target.write(block)
            size += len(block)
    length = response.headers.get("Content-Length")
    if size == 0 or (length is not None and size != int(length)):
        raise ValueError("Audio response is incomplete; do not repeat the generation POST")
    os.replace(partial, job / filename)
    return {"job": str(job), "state": "succeeded", **metadata, "file": str(job / filename), "size": size}


def generate(request_path: Path, job: Path, region: str, timeout: float) -> dict:
    request = read_json(request_path)
    path, body, query = validate(request)
    # Reject non-JSON values before creating the intent or making a paid request.
    json.dumps({"body": body, "query": query}, allow_nan=False)
    key = api_key()
    job.mkdir(parents=True, exist_ok=False, mode=0o700)
    with locked(job):
        save_json(job / "receipt.json", {"region": region, "request": request, "path": path,
                                         "query": query, "created_at": time.time()})
        try:
            with open_api(region, path, key, timeout, body=body, query=query) as response:
                return receive(job, response, query["output_format"], {"source": "generation"})
        except HTTPError as error:
            if 400 <= error.code < 500 and error.code != 408:
                save_json(job / "failure.json", {"state": "failed", "http_status": error.code})
            raise


def status(job: Path) -> dict:
    read_json(job / "receipt.json")
    response_path = job / "response.json"
    response = read_json(response_path) if response_path.exists() else {}
    file = job / response["file"] if response else None
    if file and file.is_file():
        return {"job": str(job), "state": "succeeded", **response, "file": str(file), "size": file.stat().st_size}
    try:
        with locked(job):
            pass
    except BlockingIOError:
        return {"job": str(job), "state": "running", **response}
    if (job / "failure.json").exists():
        return {"job": str(job), **read_json(job / "failure.json")}
    return {"job": str(job), "state": "unknown", **response,
            "message": "No complete local audio. Inspect provider history/support using saved IDs; do not regenerate automatically."}


def recover(job: Path, history_id: str | None, timeout: float) -> dict:
    current = status(job)
    if current["state"] == "succeeded":
        return current
    receipt = read_json(job / "receipt.json")
    request = receipt["request"]
    if request["operation"] != "tts":
        raise ValueError("History recovery is only wired for TTS, not sound-effects or music")
    history_id = history_id or current.get("history_item_id") or current.get("headers", {}).get("history-item-id")
    if not history_id:
        raise ValueError("No history ID saved; inspect history and explicitly supply --history-id for the original request")
    key = api_key()
    path = f"/v1/history/{quote(history_id, safe='')}"
    with locked(job):
        current = status(job)
        if current["state"] == "succeeded":
            return current
        with open_api(receipt["region"], path, key, timeout) as response:
            item = json.load(response)
        if item.get("history_item_id") != history_id:
            raise ValueError("History returned a different item")
        for name, expected in (("voice_id", request["voice_id"]), ("model_id", request["body"]["model_id"]),
                               ("request_id", current.get("generation_request_id"))):
            if expected and item.get(name) and item[name] != expected:
                raise ValueError(f"History item has a different {name}")
        # Never pick the newest item or POST again. An operator associates IDs when the reply was lost.
        with open_api(receipt["region"], path + "/audio", key, timeout) as response:
            return receive(job, response, None, {"source": "history", "history_item_id": history_id,
                                                "generation_request_id": current.get("generation_request_id"),
                                                "history_output_format": item.get("output_format")})


def catalog(kind: str, region: str, query: dict, timeout: float):
    if not isinstance(query, dict) or set(query) - CATALOG_FIELDS[kind]:
        raise ValueError(f"Unsupported {kind} query fields")
    if kind != "models":
        query = {"page_size": 20, **query}
    with open_api(region, CATALOG_PATHS[kind], api_key(), timeout, query=query) as response:
        return json.load(response)


def positive(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("Expected a positive finite number")
    return number


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=positive, default=300, help="Network timeout in seconds; no automatic retry")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("generate")
    create.add_argument("--request", type=Path, required=True)
    create.add_argument("--job", type=Path, required=True)
    create.add_argument("--region", choices=HOSTS, default="global")
    inspect = commands.add_parser("status")
    inspect.add_argument("--job", type=Path, required=True)
    download = commands.add_parser("recover")
    download.add_argument("--job", type=Path, required=True)
    download.add_argument("--history-id")
    listing = commands.add_parser("catalog")
    listing.add_argument("kind", choices=CATALOG_PATHS)
    listing.add_argument("--region", choices=HOSTS, default="global")
    listing.add_argument("--query", type=Path)
    args = parser.parse_args()
    if args.command == "generate":
        result = generate(args.request, args.job.resolve(), args.region, args.timeout)
    elif args.command == "recover":
        result = recover(args.job.resolve(), args.history_id, args.timeout)
    elif args.command == "status":
        result = status(args.job.resolve())
    else:
        result = catalog(args.kind, args.region, read_json(args.query) if args.query else {}, args.timeout)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 2 if isinstance(result, dict) and result.get("state") in {"failed", "unknown"} else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, IncompleteRead) as error:
        print(json.dumps({"error": str(error), "recovery": "Inspect the same job after a generation error; do not automatically POST again."}),
              file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Stopped locally. This does not confirm provider cancellation; inspect the same job.", file=sys.stderr)
        sys.exit(130)
