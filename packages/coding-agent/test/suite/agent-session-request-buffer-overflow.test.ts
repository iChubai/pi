import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const bufferError = "exceeded request buffer limit while retrying upstream";
const oldHistory = `old history:${"x".repeat(8000)}`;

async function createSeededHarness(compactionEnabled = true): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 10_000 }],
		settings: {
			compaction: { enabled: compactionEnabled, keepRecentTokens: 1 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		},
	});
	harness.setResponses([fauxAssistantMessage(oldHistory)]);
	await harness.session.prompt("earlier question");
	return harness;
}

describe("AgentSession request-buffer overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts before retrying a request-buffer overflow without token usage", async () => {
		const harness = await createSeededHarness();
		harnesses.push(harness);
		let failedRequest = "";
		let recoveredRequest = "";
		harness.setResponses([
			(context) => {
				failedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: bufferError });
			},
			fauxAssistantMessage("summary of earlier work"),
			fauxAssistantMessage("Original request: current question"),
			(context) => {
				recoveredRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("continued after compaction");
			},
		]);

		await harness.session.prompt("current question");

		expect(harness.faux.state.callCount).toBe(5);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "overflow" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(recoveredRequest.length).toBeLessThan(failedRequest.length);
		expect(recoveredRequest).toContain("summary of earlier work");
		expect(recoveredRequest).toContain("current question");
		expect(recoveredRequest).not.toContain(oldHistory);
		expect(harness.session.getLastAssistantText()).toBe("continued after compaction");
		expect(harness.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ content: [{ type: "text", text: oldHistory }] }),
				}),
			]),
		);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("stops after one compact-and-retry if the smaller request still overflows", async () => {
		const harness = await createSeededHarness();
		harnesses.push(harness);
		const error = () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: bufferError,
				timestamp: Date.now() + 10_000,
			});
		harness.setResponses([
			error,
			fauxAssistantMessage("summary of earlier work"),
			fauxAssistantMessage("Original request: current question"),
			error,
		]);

		await harness.session.prompt("current question");

		expect(harness.faux.state.callCount).toBe(5);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			willRetry: false,
			errorMessage: expect.stringContaining("after one compact-and-retry attempt"),
		});
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not replay the oversized request when automatic compaction is disabled", async () => {
		const harness = await createSeededHarness(false);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: bufferError })]);

		await harness.session.prompt("current question");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("reports failure without replaying an oversized summarization request", async () => {
		const harness = await createSeededHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: bufferError }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: bufferError }),
		]);

		await harness.session.prompt("current question");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			errorMessage: expect.stringContaining(bufferError),
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.session.isIdle).toBe(true);
	});
});
