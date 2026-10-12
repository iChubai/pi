# Adapter contract v1

An adapter is a reviewed executable command, usually a thin wrapper around an already installed model or service. No model package is imported by the transport runner. Local and remote Python need only the standard library; the adapter may use a separate, explicitly provisioned environment.

## Invocation

The runner executes the profile's argv array, without a shell, and appends:

```text
--request /absolute/run/adapter-request.json --output /absolute/run/output
```

The request contains `version`, `id`, `task`, `parameters`, a frozen `profile`, and `inputs`. Each input has `name`, `path`, `sha256`, and `size`. `sha256` is a cache key computed once during the local snapshot to skip repeated uploads, not a requirement to rehash the input. `path` points to the cached file, without its original extension; use `name` or an explicit file type when a library requires an extension. Treat cached inputs as read-only.

Prompts and model parameters are data in this JSON, never command interpolation. The adapter must reject unsupported parameters rather than silently ignore them. `profile.model` identifies the model and `profile.revision` labels the deployment configuration; neither proves which code or weights are installed. Runtime environment, precision, geometry/texture settings, and supported hardware belong to the profile/adapter, not to automatic fallback logic.

## Registered environment, code, and weights

- `command[0]` selects the executable. For a directly launched Python adapter, use the absolute interpreter path from its environment. `hosts.*.python` is only the base transport runner and may differ. An optional absolute `cwd` sets the adapter working directory; otherwise it is the run directory.
- Optional `code` contains an absolute `path` to a source directory or file and an optional `revision` label. A tag, commit, or working-copy label can describe the code being used.
- Optional `weights` maps model-specific names to `{path, revision}`. Paths are absolute files or directories on the selected host; cache symlinks are allowed. Code and weight revisions are registered independently. Explicit validation checks path access without reading file contents or invoking Git.
- Optional `python_modules` lists top-level import names such as `torch` or `PIL`. Explicit validation uses the model interpreter to locate them, without importing them, and records interpreter version/prefix. Omit it for non-Python/container launch commands.

The adapter receives this registration unchanged in `request["profile"]`. A real model adapter must use the corresponding registered weight paths, for example `request["profile"]["weights"]["shape"]["path"]`, rather than logging those paths while secretly loading another default checkpoint. Do not download missing weights, install dependencies, or silently switch precision/models as a fallback.

Provisioning, `validate --profile NAME`, and an authorized small inference are separate operations. Normal generation uses the registered configuration directly. For reproducible experiments, fix code, environment, and weights during provisioning.

Exit zero only after producing all artifacts and closing their files. A nonzero exit is a failed generation. Standard output and error go to `adapter.log`; do not print credentials. Logs and retained files need user-managed quotas and cleanup.

## Output

Write `output/manifest.json` (maximum 64 KiB):

```json
{
  "artifacts": [
    {"path": "model.glb", "role": "asset", "format": "glb"},
    {"path": "preview.png", "role": "preview", "format": "png"},
    {"path": "metrics.json", "role": "auxiliary", "format": "json"}
  ],
  "metadata": {
    "units": "meters",
    "up_axis": "Y",
    "seed": 42
  }
}
```

At least one `asset` is required. All paths must be distinct relative paths to regular files inside `output`, not symlinks; no `..`, backslashes, or `manifest.json` as an artifact. The runner records byte counts for resumable transfer. Keep large metadata in an auxiliary file. Do not alter files after reporting completion.

Units, coordinates, material channels, rig/skeleton conventions, and native output settings must reflect what was actually produced. Use unknown or omit unsupported claims. The transport does not convert formats or certify asset usability.

## Lifetime and cancellation

- `cancel: process-group` is only for adapters whose entire computation runs in their owned process group. Do not daemonize, detach children, or return before child work finishes. Cancellation signals that group and waits for the adapter process; it cannot revoke external side effects.
- `cancel: none` is appropriate when stopping the local adapter would not stop an existing remote service or paid task. Such an adapter must keep tracking the underlying work to completion. `max_seconds` becomes a reported soft deadline, not a kill guarantee.
- The runner survives ordinary SSH connection closure by launching a detached process with file-based logs. Remote reboot, account/session cleanup policies, full disks, and filesystem failure are not masked. Use an appropriate user-managed persistent service if the host kills background processes on logout.
- The same generation ID and identical request may be submitted again. A durable execution-intent marker is written before starting inference. If that execution is interrupted, it is not automatically repeated. This favors avoiding duplicate expensive work over automatic recovery from every crash; it is not a general exactly-once guarantee.
- Update a host's runner after its active tasks finish. Runner paths use an explicit release version.
- Per-resource file locks serialize only this runner's work under the same host root and resource name. They do not reserve GPUs against other programs. Adapter subprocesses inherit the run/resource locks so a crashed supervisor does not immediately release a live adapter's reservation. A multi-process adapter must preserve the required lifetime itself.

## Limits

Version labels record the configured code and checkpoints; environment checks establish path access and module discovery. Real inference, native-library compatibility, and output quality require running the model on the chosen device and inspecting its result.

This is the SSH runner's adapter contract, not a required protocol for local GPU inference.
