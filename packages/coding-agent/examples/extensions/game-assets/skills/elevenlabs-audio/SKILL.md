---
name: elevenlabs-audio
description: Generate game dialogue, event sound effects, ambient loops and music through native ElevenLabs TTS, sound-generation and music APIs. Preserve voice/model IDs and native settings, save audio locally, and recover eligible TTS audio without regenerating it.
compatibility: POSIX, Python 3.9+, ELEVENLABS_API_KEY in the process environment, and an authorized account/model/voice/budget.
---

# ElevenLabs audio

Read [the package README](../../README.md) before setup. Script paths are relative to this skill directory. The helper uses the official REST endpoints directly and requires no Python dependencies. If an existing ElevenLabs hosted MCP already provides the needed TTS tool, reuse it; the helper also covers sound effects and music, which are not documented as hosted MCP capabilities.

## Choose the operation

- `tts`: dialogue or narration; choose an authorized voice and TTS model, language, voice settings and continuity controls.
- `sound-effects`: an event sound or ambience; preserve native `duration_seconds`, `loop`, `prompt_influence` and model selection.
- `music`: a cue from `prompt` or a native `composition_plan`; preserve model, section structure, duration in milliseconds, instrumental setting and optional finetune/source IDs. Music plans differ between model versions.

Use the user's authorized account region. Supply `ELEVENLABS_API_KEY` before starting the process; do not read or display the variable, put it on a command line, or save it in JSON. Generating audio, listing account resources, and using licensed voices require the appropriate account access. This skill does not clone voices.

## Discover available IDs

Read-only calls, after account access is authorized:

```sh
python3 scripts/audio.py catalog models
python3 scripts/audio.py catalog voices
```

`catalog voices --query FILE` accepts native `search`, `page_size`, `next_page_token`, `voice_type`, `category`, `sort` and `sort_direction`. Pagination is explicit. Select voices with appropriate usage rights. Model catalog presence is not a guarantee of every operation or account tier.

## Generate and inspect

Create a JSON request; complete examples live in `examples/eleven-*.json` at package root:

```json
{
  "operation": "sound-effects",
  "query": {"output_format": "mp3_44100_128"},
  "body": {
    "model_id": "eleven_text_to_sound_v2",
    "text": "A short mechanical door latch releases. No music or speech.",
    "duration_seconds": 2.0,
    "prompt_influence": 0.5,
    "loop": false
  }
}
```

Native body/query fields are preserved; TTS additionally needs top-level `voice_id`. Choose `body.model_id` explicitly. Do not substitute models or lower quality after an error. Music `seed` applies to a composition plan, not a simple prompt; `music_length_ms` and `force_instrumental` apply to a prompt, not a plan.

```sh
python3 scripts/audio.py --timeout 300 generate --request REQUEST --job NEW_JOB_DIRECTORY --region global
python3 scripts/audio.py status --job JOB
```

The request is synchronous: the program waits and saves the response, not the language model. Keep the job directory even if the tool times out. A directory is used for only one generation attempt; repeated generation into it is rejected. Completed files are published only after the response is fully written. PCM remains raw PCM, not a mislabeled WAV. No automatic audio conversion is performed.

Inspect/listen with available media and engine tools. Check actual dialogue timing, loop seams, loudness, spatialization and event triggering. Do not infer quality from a nonempty file. Use local trimming/mixing when it solves the issue before paying for another generation.

## Recover

`status` reads local files without credentials or API calls. `unknown` means no complete file and no live local request owner; it does not mean no charge occurred. A timeout or Ctrl-C does not confirm cancellation. The helper never retries a generation POST.

For TTS with provider history enabled:

```sh
python3 scripts/audio.py recover --job JOB
```

This uses a saved history-item ID when returned. Otherwise, inspect `catalog history --query FILE` or the provider UI and explicitly associate the original item:

```sh
python3 scripts/audio.py recover --job JOB --history-id CONFIRMED_ORIGINAL_ID
```

Recovery uses GET only; it does not choose the latest item or regenerate speech. Zero-retention requests have no history recovery. Sound effects and music do not have a recovery path wired here; inspect saved request/song IDs with the provider rather than retrying automatically. Existing completed local audio is preserved.
