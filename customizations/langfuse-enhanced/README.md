# Portable Langfuse extension

Fork of `@langfuse/pi-observability-plugin@0.1.2`, retaining its MIT license.
Credentials remain in `~/.pi/agent/langfuse.json` (or `PI_CODING_AGENT_DIR`); no credentials belong in this package. Cross-machine installation is documented in [the customization profile](../README.md).

## What is recorded

- `Pi Turn` traces with `Conversational Turn` agent roots, nested `LLM Call` generations and tool observations.
- Generation input: the complete payload exposed by Pi's `before_provider_request` hook, including the system prompt, history, tool definitions and request parameters. It is masked and copied; the request sent to the model is not modified. `metadata.input_source` identifies provider payloads versus the session-context fallback.
- Generation output: complete text, `reasoning_content` for thinking actually returned by the provider, and function calls with arguments. Hidden reasoning cannot be recovered; opaque thinking signatures are masked in inputs and omitted from outputs.
- Session grouping, inherited subagent parents, usage, cost, first-token timing, errors, compaction and branch summaries, as in the upstream extension. Starting metadata and truncation markers survive SDK updates; an incomplete flush is reported as pending rather than sent.
- User images remain on root input; tool-produced images appear on tool/root output. Native base64 image/audio sources become Langfuse media references without re-encoding their binary bytes.

View everything in the existing Langfuse project. Select `LLM Call`, then Input/Output. Thinking is stored as `reasoning_content`. The root is tagged `pi` and `langfuse-enhanced`.

## Redaction and limits

Masking happens before export, including inputs, outputs, metadata, encoded JSON arguments, common text assignments, and text/JSON attachments. It covers configured Langfuse keys, credential-like environment values, common credential fields, vendor-key/JWT/private-key patterns, and common PII fields/patterns. Tool schemas retain their structure while sensitive defaults are masked. Cycles become markers; masking failures export `[redaction-failed]`, never the original value.

This is heuristic masking, not a complete PII detector. Unlabelled names, unusual secrets, paths, and PII inside binary images/audio/documents may remain. There is no OCR or binary-media anonymization. Full prompts, thinking and tool content can contain confidential information beyond these patterns; use appropriate Langfuse access and retention controls.

- `LANGFUSE_TRACING_ENABLED=false`: disable tracing.
- `LANGFUSE_MEDIA_UPLOAD_ENABLED=false`: omit inline media bytes rather than uploading them.
- `PI_LANGFUSE_MASK_PII=false` or `"maskPii": false` in private config: opt out of PII masking only; credential masking stays active.
- `PI_LANGFUSE_MAX_CHARS` (default `20000`): limits root prompt previews and summarization previews, **not generation input/output or tool input/output**. Preview truncation is marked and performed after masking. Large payloads remain subject to Langfuse/transport limits.

Do not enable this package and the official plugin's extension simultaneously. The setup script disables an existing official plugin with `"extensions": []` and retains its package for rollback; it does not install the official plugin on a new machine. To roll back, disable/remove this package entry and re-enable or install the official extension, then restart Pi. Start a fresh session if you do not want previous conversation history included in future model-input traces.

## Tests

Run `node --test test/trace-data.test.ts` from this directory with Node 22.23.3 or later. Tests use synthetic data and do not contact models or Langfuse. Dependencies are pinned in `package-lock.json` and installed without lifecycle scripts. This local fork will not automatically inherit upstream plugin updates.
