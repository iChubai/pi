import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { record } from "./format.ts";
import type { TraceRecord } from "./types.ts";

interface LineRef {
	offset: number;
	length: number;
	type: string;
	pending?: Buffer;
}
const MAX_DETAIL_BYTES = 32 * 1024 * 1024;

/** Append-only sidecar with a small offset index. Large historical payloads stay on disk. */
export class Journal {
	readonly path: string;
	private status = "Opening trace journal";
	get state(): string {
		return this.status;
	}
	set state(value: string) {
		if (this.status === value) return;
		this.status = value;
		this.onStateChange?.();
	}
	private onStateChange?: () => void;
	private handle?: FileHandle;
	private offset = 0;
	private sequence = 0;
	private refs = new Map<string, LineRef[]>();
	private queue: LineRef[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private writing: Promise<void> = Promise.resolve();
	private closed = false;
	private retainedBytes = 0;

	constructor(cwd: string, privateSessionId: string, onStateChange?: () => void) {
		this.onStateChange = onStateChange;
		this.path = join(cwd, ".pi-traces", `${encodeURIComponent(privateSessionId)}.jsonl`);
		this.sessionId = privateSessionId;
	}
	private readonly sessionId: string;

	async initialize(onRecord: (value: TraceRecord) => void): Promise<void> {
		try {
			const directory = dirname(this.path);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const directoryStat = await lstat(directory);
			if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Unsafe trace directory");
			this.handle = await open(
				this.path,
				constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
				0o600,
			);
			await this.handle.chmod(0o600);
			// Incremental reads avoid loading every past input/payload into memory at startup.
			const buffer = Buffer.alloc(64 * 1024);
			let position = 0,
				lineOffset = 0;
			const pieces: Buffer[] = [];
			let pendingLength = 0;
			for (;;) {
				const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position);
				if (!bytesRead) break;
				position += bytesRead;
				const data = Buffer.from(buffer.subarray(0, bytesRead));
				let start = 0;
				for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
					pieces.push(data.subarray(start, end));
					const length = pendingLength + end - start;
					this.loadLine(Buffer.concat(pieces, length), lineOffset, length + 1, onRecord);
					lineOffset += length + 1;
					pieces.length = 0;
					pendingLength = 0;
					start = end + 1;
				}
				if (start < data.length) {
					pieces.push(data.subarray(start));
					pendingLength += data.length - start;
				}
				if (pendingLength > MAX_DETAIL_BYTES) throw new Error("Trace line exceeds the safe read limit");
			}
			this.offset = position;
			if (pendingLength) {
				this.loadLine(Buffer.concat(pieces, pendingLength), lineOffset, pendingLength, onRecord);
				// Preserve a truncated tail byte-for-byte; separate it from subsequent records.
				await this.handle.write("\n");
				this.offset++;
			}
			this.state = "Persisted locally";
		} catch {
			await this.handle?.close().catch(() => {});
			this.handle = undefined;
			this.state = "Memory only · journal unavailable";
		}
	}
	private loadLine(line: Buffer, offset: number, length: number, onRecord: (value: TraceRecord) => void): void {
		try {
			const value: unknown = JSON.parse(line.toString("utf8"));
			if (
				!record(value) ||
				value.schemaVersion !== 1 ||
				value.sessionId !== this.sessionId ||
				typeof value.type !== "string" ||
				typeof value.timestamp !== "string" ||
				typeof value.sequence !== "number"
			)
				return;
			const trace = value as TraceRecord;
			this.sequence = Math.max(this.sequence, trace.sequence);
			if (typeof trace.callId === "string") {
				const refs = this.refs.get(trace.callId) ?? [];
				refs.push({ offset, length, type: trace.type });
				this.refs.set(trace.callId, refs);
			}
			onRecord(trace);
		} catch {
			/* An interrupted final write is not a valid event. */
		}
	}
	append(
		value: Omit<TraceRecord, "schemaVersion" | "sessionId" | "sequence" | "timestamp"> & { timestamp?: string },
	): TraceRecord {
		const trace = {
			...value,
			schemaVersion: 1,
			sessionId: this.sessionId,
			sequence: ++this.sequence,
			timestamp: value.timestamp ?? new Date().toISOString(),
		} as TraceRecord;
		if (this.closed) return trace;
		let pending: Buffer;
		try {
			pending = Buffer.from(`${JSON.stringify(trace)}\n`);
		} catch {
			this.state = "A detail could not be serialized";
			return {
				schemaVersion: 1,
				sessionId: this.sessionId,
				sequence: trace.sequence,
				timestamp: trace.timestamp,
				type: "capture_error",
				callId: trace.callId,
			};
		}
		const ref: LineRef = { offset: this.offset, length: pending.length, type: trace.type, pending };
		this.offset += pending.length;
		if (trace.callId) {
			const refs = this.refs.get(trace.callId) ?? [];
			refs.push(ref);
			this.refs.set(trace.callId, refs);
		}
		if (!this.handle) {
			// Recording failure must not break the agent or consume unbounded RAM.
			this.retain(ref);
			return trace;
		}
		this.queue.push(ref);
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, 250);
			this.timer.unref();
		}
		if (this.queue.length >= 256) void this.flush();
		return trace;
	}
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const batch = this.queue.splice(0);
		if (!batch.length) return this.writing;
		this.writing = this.writing.then(async () => {
			if (!this.handle) {
				for (const ref of batch) this.retain(ref);
				return;
			}
			try {
				const data = Buffer.concat(batch.flatMap((ref) => (ref.pending ? [ref.pending] : [])));
				let written = 0;
				while (written < data.length)
					written += (await this.handle.write(data, written, data.length - written)).bytesWritten;
				for (const ref of batch) ref.pending = undefined;
			} catch {
				await this.handle?.close().catch(() => {});
				this.handle = undefined;
				this.state = "Memory only · journal write failed";
				for (const ref of batch) this.retain(ref);
			}
		});
		return this.writing;
	}
	private retain(ref: LineRef): void {
		this.retainedBytes += ref.pending?.length ?? 0;
		if (this.retainedBytes > MAX_DETAIL_BYTES) {
			ref.pending = undefined;
			this.state = "Memory limit reached · some details unavailable";
		}
	}
	async read(
		callId: string,
		streams = false,
		after = 0,
	): Promise<{ records: TraceRecord[]; next: number | null; total: number }> {
		const refs = (this.refs.get(callId) ?? []).filter((ref) =>
			streams ? ref.type === "output_event" : ref.type !== "output_event",
		);
		const chosen = refs.slice(after, streams ? after + 80 : undefined);
		if (chosen.reduce((sum, ref) => sum + ref.length, 0) > MAX_DETAIL_BYTES)
			throw new Error("Detail exceeds 32 MiB; use the private trace file directly");
		const records: TraceRecord[] = [];
		for (const ref of chosen) {
			let data = ref.pending;
			if (!data && this.handle) {
				data = Buffer.alloc(ref.length);
				let read = 0;
				while (read < data.length) {
					const result = await this.handle.read(data, read, data.length - read, ref.offset + read);
					if (!result.bytesRead) break;
					read += result.bytesRead;
				}
				data = data.subarray(0, read);
			}
			if (!data) continue;
			try {
				records.push(JSON.parse(data.toString("utf8")) as TraceRecord);
			} catch {
				/* Incomplete writes are unavailable, not invented. */
			}
		}
		return { records, next: after + chosen.length < refs.length ? after + chosen.length : null, total: refs.length };
	}
	/** Search every recorded byte, including stream events, without loading a whole call. */
	async search(
		callId: string,
		query: string,
		signal?: AbortSignal,
	): Promise<{ matched: boolean; incomplete: boolean }> {
		let incomplete = false;
		const buffer = Buffer.alloc(64 * 1024);
		for (const ref of this.refs.get(callId) ?? []) {
			const decoder = new StringDecoder("utf8");
			let tail = "";
			for (let offset = 0; offset < ref.length; ) {
				signal?.throwIfAborted();
				const length = Math.min(buffer.length, ref.length - offset);
				let chunk: Buffer;
				if (ref.pending) chunk = ref.pending.subarray(offset, offset + length);
				else if (this.handle) {
					try {
						const { bytesRead } = await this.handle.read(buffer, 0, length, ref.offset + offset);
						chunk = buffer.subarray(0, bytesRead);
					} catch {
						incomplete = true;
						break;
					}
				} else {
					incomplete = true;
					break;
				}
				if (!chunk.length) {
					incomplete = true;
					break;
				}
				offset += chunk.length;
				const text =
					tail + decoder.write(chunk).toLowerCase() + (offset === ref.length ? decoder.end().toLowerCase() : "");
				if (text.includes(query)) return { matched: true, incomplete };
				tail = text.slice(-Math.max(1, query.length - 1));
				if (ref.pending) await yieldTurn();
			}
		}
		return { matched: false, incomplete };
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
		await this.writing;
		await this.handle?.close();
		this.handle = undefined;
	}
}
