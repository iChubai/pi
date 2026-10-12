---
name: minimax-video
description: Generate MiniMax H3 videos through the official mmx CLI using text, first/last frames, or image/video/audio references. Preserve task IDs, wait in a program, and retrieve MP4 files for game cutscenes, in-world screens, or video assets.
compatibility: POSIX, Python 3.9+, an independently installed mmx-cli with H3 support, and authorized MiniMax Pay-as-you-go video access.
---

# MiniMax H3 video

Read [video usage](../../docs/video.md) before first use. Paths below are relative to this skill directory. This backend does not require LTX or SSH setup; all skills are included in game-assets.

## Prepare

Use the user's authorized account region, shot requirements, and budget. Check the installed `mmx --version` and `mmx video generate --help` once during setup; the reviewed version is 1.0.27. Have the user authenticate interactively with `mmx auth login`, selecting a Pay-as-you-go/Credit API key. `mmx auth status --output json --quiet` reports masked authentication; do not read the credential file or put a key in arguments, requests, or the conversation. Do not install or log in automatically.

## Generate

1. Decide whether a new video is needed or an existing file/local edit suffices. A rendered game frame can anchor an in-world screen or cutscene. Native video audio is not a substitute for independently triggered gameplay sounds.
2. Write a JSON request using CLI option names. Example:

   ```json
   {
     "prompt": "A fixed-camera broadcast monitor shows a weather map. The narrator calmly announces approaching rain. No camera movement.",
     "duration": 5,
     "ratio": "16:9"
   }
   ```

   `image` is the first frame; `last-frame` supplies an ending frame. `reference-image`, `reference-video`, and `reference-audio` accept one path/URL or an array. Local paths resolve relative to the request file. Frame inputs and reference inputs are different modes; do not mix them. Audio reference requires an image/video reference. Frame mode uses `adaptive` ratio. This mmx version exposes H3 at 2K; do not claim other REST parameters are supported.
3. Run `python3 scripts/h3.py submit --request REQUEST --job NEW_JOB_DIRECTORY --region global` (or `cn`). Generation requires prior authorization; installing the skill is not authorization to spend.
4. Keep the returned task ID and job path. Continue independent local work. Use one `python3 scripts/h3.py wait --job JOB --seconds 600` rather than polling in model turns.
5. Run `python3 scripts/h3.py fetch --job JOB`. It returns `video.mp4` after a complete download. Inspect frames/audio using available media tools, import into the actual engine, and evaluate playback before spending on another generation.

## Recover

`status --job JOB`, `wait --job JOB`, and `fetch --job JOB` reuse the same provider task. Never repeat submission into a new directory merely because a response, wait, or download failed.

A job without a saved task ID is unknown, not a confirmed failure. Check whether the submit process is still active and inspect the provider task history. If the operator identifies the original task, `attach --job JOB --task-id ID` associates it explicitly. Do not pick the newest task automatically.

Ctrl-C, a wait timeout, disabling the skill, or removing the package does not cancel the provider task. Download promptly: the provider query window is seven days. Repeated fetch preserves existing local files; move a file aside to fetch it again. Cancellation/deletion is not exposed by this wrapper.
