# Trace Studio

A local, read-only session observatory for pi. Retains the original [Pi Trace Viewer](https://github.com/ZKiteLM/pi-trace-viewer) Session layout and styles, with a compact-data backend for long sessions and separate statistics/call views. It does not patch `node_modules`, invoke a model, upload trace data, or insert extension messages into the conversation.

## Install

Requires pi 1.1.0 or later. Install the two pinned browser dependencies without lifecycle scripts:

```bash
npm install --prefix /absolute/path/to/trace-viewer --ignore-scripts --legacy-peer-deps --workspaces=false
pi install /absolute/path/to/trace-viewer
```

The package manifest loads only `index.ts`. Do not enable this package and `pi-trace-viewer` simultaneously: both register `/trace-view`. To retain the old package for rollback, disable its extensions in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "npm:pi-trace-viewer@0.2.0", "extensions": [] },
    "/absolute/path/to/trace-viewer"
  ]
}
```

Preserve other packages/settings. When replacing a running upstream viewer, run `/trace-view stop` before `/reload` so its retained server also closes. New sessions load the package automatically.

## Commands

- `/trace-view`: print the current session's URL. Open that exact URL in a browser.
- `/trace-view off`: pause live recording; native session history remains inspectable.
- `/trace-view on`: resume recording, or restart a stopped viewer.
- `/trace-view stop`: close the server and flush pending journal writes.
- `/trace-view status`: report the URL and capture state.
- `pi --no-pi-trace`: disable automatic startup for that invocation.
- `pi --pi-trace-port 17890`: choose the starting port. Occupied ports are skipped. Port `0` requests an ephemeral port.

The server binds only `127.0.0.1`. It rejects foreign Host/Origin headers, cross-site browser requests, and non-GET methods. There is no remote-access mode. `/reload` retains the local server and the capture preference; quitting closes it. Detached sessions are pruned when more than eight sessions are tracked; active sessions are not evicted. This is not a catalog of every session on disk.

## Views

All three views share the original Session top bar, navigation, monospace typography, palette, compact controls and flat bordered panels. LLM Calls and Statistics add their own content without introducing a different application shell. The original dark theme is the default; light mode and the saved choice apply across pages.

**Statistics** shows recorded input/output usage, weighted cache reuse, median client-observed call duration, provider errors/additional exposed requests, tool timing coverage, and trends:

- Input-context growth with compaction boundaries.
- Call latency; first visible output time is available in the call inspector.
- Last captured request's JSON byte size, not compressed HTTP wire size.
- Cache-read share per call.
- Additional observed provider requests within a call.

Chart gaps mean unknown measurements, not zeros. Sparse measurements appear as points. Sampling retains extrema and gaps instead of smoothing away spikes. Hover or use Left/Right/Home/End to inspect a chart; click or Enter opens its call.

**Session** is the default page. It restores the upstream top bar, 400px resizable tree sidebar, branch connectors, colored multi-line thinking/text/tool previews, session header and original message/tool/disclosure styles. Statistics and LLM Calls remain separate navigation entries rather than replacing this interface. Selecting a node reads its continuous ancestry without changing pi's active branch. The reader pages twenty entries at a time and fetches only visible/open bodies; Older/Newer/Selected node controls traverse the full branch. Default opening starts with the oldest page and retains the current selection; Follow active leaf is opt-in. The original Default/No-tools/User/Labeled/All filters and full-content search remain available. Variable-height tree rows stay virtualized; Arrow Up/Down/Home/End and pointer/keyboard sidebar resizing work. Each entry retains copy-link/full-JSON controls, original-entry inspection, image enlargement and a Context shortcut when its call is indexed.

Search covers full native records and captured context, payloads, final output and stream events—not just previews. It scans locally in cancellable, bounded pages, returning IDs and progress rather than shipping every body to the browser. Results are a snapshot; Search again includes later changes. Unavailable journal bytes are reported rather than treated as a complete negative result. Session information retains counts, recorded estimated costs, models, the current system prompt and active tools.

**LLM Calls** is a lightweight numbered index with kind/status, model/API, captured one-based turn within an agent run, exposed request count and tool/output summaries. Historical turn indexes remain unknown. The inspector has Output, Pi Context, Provider payload, Compare, Stream and Raw views. Per-message JSON, compaction cut points/source messages, tool calls/results, custom records and encrypted thinking signatures remain inspectable. Message bodies, thinking, images and JSON expand lazily; messages page in groups of 40 and stream events in groups of 80. Live inspectors refresh on request/completion transitions, not per token; Follow latest keeps the stream view current with at most eighty event shells. Images enlarge in a keyboard-contained dialog, with an original-byte download and no remote-image fetches. Entry/call links and full JSON/text can be copied; original `entry`/`call`/`mode` links are accepted. Large text has a bounded preview and an explicit full-original download. Escape closes the image first, then the inspector. All views use the same original palette and share the explicit light/dark theme choice. Narrow screens retain the session picker, use the original slide-out Session sidebar, and keep dialogs keyboard-contained.

The statistics scope selects **current branch** or **entire history**. A branch is an ancestry path, not the model's visible context. Compaction and context replacement can remove messages from a request while retaining those messages in history. Captured Input/Backend views, when available, are the evidence of what a call observed.

## What is known, and what is not

- Native assistant, tool-result, compaction and usage entries supply their recorded usage. Token totals are not subscription quota. Cost fields, when present in raw records, are recorded estimates, not billing receipts.
- Historical messages do not supply request payloads or timing measurements retroactively. Their unknown fields stay unknown.
- Live calls are matched to their persisted assistant messages so usage/call indexes do not count both copies. Failed calls and completed nested tools without native result entries use their recorded branch/call anchors.
- New timing records use a monotonic clock. Call time covers context observation through completion, not just provider inference; first output includes thinking when exposed.
- Request counts measure payload hooks pi exposes, not confirmed HTTP sends. Additional payloads can be retry candidates, but this is not a complete retry count: a pi-level retry can start a separate indexed call, and transport retries may be hidden. Summaries and direct-HTTP tools may bypass provider hooks. Compaction preparation/cut points and the completed summary are still captured; no synthetic backend payload is fabricated.
- Generic context is a snapshot at this extension's hook. A later extension can change it. Active tool metadata is provided for inspection, but the actual mapped backend request is authoritative when exposed.
- Export JSONL exports the native session, including all its branches. The detailed sidecar journal is separate.

## Storage and performance

Sidecars remain in `<session-cwd>/.pi-traces/<session-id>.jsonl`. Existing compatible schema-1 sidecars can be indexed without rewriting them. Directories created by this extension are `0700`, journal files `0600`; symlink directories/files are refused. Writes are queued and batched, not synchronous filesystem appends per stream delta. Growing `partial` objects are excluded before serialization.

The server keeps compact entry/call/tool indexes and disk offsets rather than all past payloads. `/updates?after=<revision>` returns changed rows and removed duplicate IDs. SSE only announces changes; notifications are coalesced. Full records are fetched only for selected inspectors or visible/open entries in a bounded transcript page. Full-content search reads on the server and returns compact matches; it does not preload all bodies in the browser. Hidden browser tabs suspend their updates. Journal reads load at most 32 MiB per detail request; oversized details remain in the private sidecar. If persistence fails, the viewer reports it and bounds retained detail buffers instead of breaking the agent.

**Traces are sensitive.** They can contain prompts, source files, tool results, images and secrets embedded in ordinary text. Credential/header-key redaction is not comprehensive text-secret removal. Ignore `.pi-traces/` in Git in every traced project. Do not publish the files or expose the server through a tunnel.

## Development and verification

Backend tests use the coding-agent harness and faux provider:

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/trace-studio-extension.test.ts
```

Browser validation uses an isolated headless Chrome profile and mock records, with no provider calls. A 2,007-entry/1,007-call fixture verifies initial loading without detail requests, bounded viewport rows, lazy large-payload expansion, sanitized Markdown, light/dark themes and narrow-screen layout. A separate 2,009-entry/1,004-call parity fixture verifies selected-branch paging, full-record searches, custom state, image zoom/original-byte links, full JSON clipboard output, context comparison/message paging, bounded live streams, automatic completion updates, legacy entry/call links, pointer/keyboard resizing and mobile controls. An additional original-layout fixture checks the default Session entry point, upstream layout/styles, variable-height virtualization, lazy ancestry reading, full-content search, original attachment bytes, copy/JSON controls, themes, separate statistics/call navigation, resizing and mobile sidebar behavior. A 2,003-entry/1,001-call style-unification fixture compares computed fonts, colors, top-bar dimensions and controls across all views in desktop/mobile and dark/light modes. It also checks chart rendering, lazy 3 MiB payload inspection, full-content call search, virtual rows, context/stream paging, modal focus and reduced motion, without external app requests. These fixtures use mock data; their measurements are not a performance guarantee for arbitrary sessions.

See [pi extensions](../../../docs/extensions.md) and [packages](../../../docs/packages.md) for loading and resource discovery. Upstream Pi Trace Viewer attribution is retained in [LICENSE](LICENSE).
