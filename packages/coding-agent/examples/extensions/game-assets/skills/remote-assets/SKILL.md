---
name: remote-assets
description: Register existing remote model profiles, submit asset-generation requests to configured SSH GPU machines, recover a generation, and fetch artifacts into the local project. Use only for SSH 3D/image/motion/video generation; local GPU inference uses existing tools and native model commands.
compatibility: Python 3.9+ and POSIX on the client and remote; OpenSSH for remote profiles. Model environments and adapters are provisioned separately.
---

# Remote assets

Read [SSH usage](../../docs/remote.md) before first use and [the adapter contract](references/adapter-contract.md) before adding a backend. Paths below are relative to this skill directory. This skill is part of game-assets; Pi's normal file tools remain local. Do not require a profile or this runner for local GPU inference: use the existing Bash/Python/native CLI or already running service directly.

## Configuration

Use the user's explicit configuration file and selected profile. Registration lives in that file's `profiles`, not Pi's provider/model settings:

- `command[0]` selects the model executable/environment.
- `code` records the code path and version label.
- `weights` records named checkpoint paths and versions.
- `env` selects devices and other non-secret settings.

Get authorization before remote setup or generation. Use configured SSH aliases with host-key checking. Keep credentials out of configuration environments, requests, and logs.

## Workflow

Run `python3 scripts/assets.py --config /absolute/path/config.json ...`.

1. `profiles` lists local configuration.
2. On initial setup or runner updates: `setup --host NAME`. Finish existing tasks before updating a host's runner.
3. After provisioning or configuration changes: `validate --profile NAME` checks paths and Python module discovery. Code/weight revisions are labels; validation does not read model files or require a clean Git worktree. `doctor --host NAME` is optional host diagnostics.
4. Write a JSON request with model-specific parameters. `submit --request FILE --profile NAME` returns an ID without rerunning environment checks. Input paths are relative to the request file.
5. Keep the ID and continue independent local work. Use `status ID` or one bounded `wait ID --seconds 60`; let the program wait rather than repeatedly polling in model turns.
6. `fetch ID --previews` retrieves previews. Read returned images with Pi's read tool; `fetch ID` retrieves all completed files. Check actual engine import, appearance, and behavior for the user's task.

Input snapshots use one content digest to skip repeated uploads. Downloads use byte counts and publish after completion. Completed results and local files are reused without hash scans.

## Recovery

- `list` finds local IDs; `logs ID` reads log tails.
- On connection loss, query or `resume` the same ID. Do not create a replacement request or switch machines.
- `unknown` execution state requires inspecting the original work; do not delete execution markers or automatically rerun it.
- Repeat `fetch ID` to resume an interrupted download. Existing local files are preserved; move one aside if it needs downloading again.
- `cancel ID` requests supported cancellation; query status to confirm. Stopping SSH or `wait` does not cancel generation.

## Limits

The selected profile must point to a real model adapter; the sibling `ltx-video` skill supplies its own adapter. Environment checks do not establish real model/GPU compatibility; actual inference needs an authorized device and budget. Device locks coordinate this package's tasks, not other programs. Model installation, paid services, automatic routing, and model residency are separate from this skill.
