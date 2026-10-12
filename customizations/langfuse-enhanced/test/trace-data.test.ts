import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAssistantOutput,
	containsInlineMedia,
	createDataMasker,
	hasAssistantOutput,
	MASK_FAILURE_MARK,
	PII_MARK,
	SECRET_MARK,
} from "../src/trace-data.ts";

test("keeps complete model history and parameters without changing agent input", () => {
	const payload = {
		model: "test-model",
		messages: [
			{ role: "system", content: "system policy" },
			{ role: "user", content: "x".repeat(30000) },
		],
		temperature: 0.4,
	};
	const masked = createDataMasker()(payload);
	assert.deepEqual(masked, payload);
	assert.notEqual(masked, payload);
});

test("redacts structured credentials and PII", () => {
	assert.deepEqual(
		createDataMasker()({
			apiKey: "unrecognized-format",
			headers: { Authorization: "Bearer short", Cookie: "session=value" },
			user: {
				email: "alice@example.com",
				fullName: "Test User",
				phoneNumber: "+1 415 555 1234",
			},
			model: "test-model",
			sessionId: "session-123",
			tokenUsage: 12,
		}),
		{
			apiKey: SECRET_MARK,
			headers: { Authorization: SECRET_MARK, Cookie: SECRET_MARK },
			user: { email: PII_MARK, fullName: PII_MARK, phoneNumber: PII_MARK },
			model: "test-model",
			sessionId: "session-123",
			tokenUsage: 12,
		},
	);
});

test("masks nested JSON encoded inside tool arguments and file contents", () => {
	const masked = createDataMasker()({
		arguments: JSON.stringify({
			password: "private-password",
			nested: { email: "alice@example.com" },
		}),
	}) as Record<string, string>;
	assert.deepEqual(JSON.parse(masked.arguments), {
		password: SECRET_MARK,
		nested: { email: PII_MARK },
	});
});

test("masks known environment credentials even when they have no vendor prefix", () => {
	const mask = createDataMasker({
		env: { FAL_KEY: "unknown-format-secret", PATH: "/usr/bin" },
	});
	assert.equal(
		mask("key=unknown-format-secret, path=/usr/bin"),
		`key=${SECRET_MARK}, path=/usr/bin`,
	);
});

test("masks credential and PII text patterns, headers and env-file assignments", () => {
	const mask = createDataMasker();
	const input =
		"OPENAI_API_KEY=some-private-value\nAuthorization: Basic dGVzdDpwYXNz\nContact alice@example.com at +1 415 555 1234. SSN 123-45-6789. Host 192.168.1.12";
	const output = String(mask(input));
	for (const value of [
		"some-private-value",
		"dGVzdDpwYXNz",
		"alice@example.com",
		"+1 415 555 1234",
		"123-45-6789",
		"192.168.1.12",
	]) {
		assert.ok(!output.includes(value), value);
	}
	assert.ok(output.includes(SECRET_MARK));
	assert.ok(output.includes(PII_MARK));
});

test("redacts embedded JSON fragments and complete cookie header lines", () => {
	const output = String(
		createDataMasker()(
			'debug payload: {"password": "unknown-private", "model": "test"}\nCookie: a=private-one; b=private-two',
		),
	);
	for (const secret of ["unknown-private", "private-one", "private-two"])
		assert.ok(!output.includes(secret));
	assert.ok(output.includes('"model": "test"'));
});

test("masks vendor keys, JWTs, URL credentials and PEM private keys", () => {
	const values = [
		"sk-lf-fake-test-key",
		"pk-lf-fake-test-key",
		"sk-proj-abcdefghijklmnopqrstuvw",
		"ghp_abcdefghijklmnopqrstuvwxyz",
		"eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.abcdefghijk",
		"-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
	];
	const mask = createDataMasker();
	for (const value of values) assert.equal(mask(value), SECRET_MARK);
	assert.equal(
		mask("https://user:pass@example.com/path"),
		`https://${SECRET_MARK}@example.com/path`,
	);
});

test("preserves tool JSON schemas while masking sensitive defaults", () => {
	const payload = {
		tools: [
			{
				parameters: {
					type: "object",
					properties: {
						apiKey: {
							type: "string",
							description: "Credential for the API",
							default: "private-default",
						},
						email: { type: "string", default: "alice@example.com" },
						query: { type: "string", description: "Search query" },
					},
					required: ["apiKey", "query"],
				},
			},
		],
	};
	const output = JSON.stringify(createDataMasker()(payload));
	assert.ok(output.includes('"apiKey":{"type":"string"'));
	assert.ok(output.includes('"query":{"type":"string"'));
	assert.ok(output.includes('"required":["apiKey","query"]'));
	assert.ok(!output.includes("private-default"));
	assert.ok(!output.includes("alice@example.com"));
});

test("redacts sensitive enum values without changing schema array structure", () => {
	const schema = {
		type: "object",
		properties: {
			apiKey: { type: "string", enum: ["private-one", "private-two"] },
			email: { type: "string", examples: ["alice@example.com"] },
		},
	};
	assert.deepEqual(createDataMasker()(schema), {
		type: "object",
		properties: {
			apiKey: { type: "string", enum: [SECRET_MARK, SECRET_MARK] },
			email: { type: "string", examples: [PII_MARK] },
		},
	});
});

test("an arbitrary properties object is not exempt from masking", () => {
	assert.deepEqual(
		createDataMasker()({ properties: { apiKey: "unknown-secret" } }),
		{
			properties: { apiKey: SECRET_MARK },
		},
	);
	assert.deepEqual(
		createDataMasker()({ apiKey: { type: "string", value: "unknown-secret" } }),
		{
			apiKey: SECRET_MARK,
		},
	);
	assert.deepEqual(
		createDataMasker()({
			type: "object",
			properties: { apiKey: "unknown-secret" },
		}),
		{ type: "object", properties: { apiKey: SECRET_MARK } },
	);
	assert.deepEqual(
		createDataMasker()({
			type: "object",
			description: "test",
			apiKey: "unknown-secret",
		}),
		{ type: "object", description: "test", apiKey: SECRET_MARK },
	);
});

test("does not change trace IDs, ISO dates, numeric usage and model names", () => {
	const payload = {
		traceId: "55f7672482f9629e1076b98ebf5d2c5b",
		startTime: "2026-10-12T07:30:00.000Z",
		usageDetails: { input: 100, output: 12 },
		model: "claude-sonnet-4-5",
		latency: 0.3,
	};
	assert.deepEqual(createDataMasker()(payload), payload);
});

test("masks common Chinese PII fields, labels, mobile numbers and ID numbers", () => {
	const mask = createDataMasker();
	assert.deepEqual(
		mask({
			姓名: "张三",
			手机号: "13800138000",
			身份证号: "11010119900101001X",
			密码: "private",
		}),
		{ 姓名: PII_MARK, 手机号: PII_MARK, 身份证号: PII_MARK, 密码: SECRET_MARK },
	);
	const text = String(
		mask(
			"姓名：张三，手机号：13800138000，密码：private。号码 13800138000 11010119900101001X",
		),
	);
	for (const value of ["张三", "13800138000", "private", "11010119900101001X"])
		assert.ok(!text.includes(value));
	assert.equal(
		mask("af13123456789bb7c0000000000000000"),
		"af13123456789bb7c0000000000000000",
	);
});

test("PII opt-out does not disable secret masking", () => {
	assert.deepEqual(
		createDataMasker({ maskPii: false })({
			email: "alice@example.com",
			password: "private",
		}),
		{ email: "alice@example.com", password: SECRET_MARK },
	);
});

test("preserves original image bytes and turns native image sources into media URIs", () => {
	const uri = "data:image/png;base64,aGVsbG8=";
	assert.equal(createDataMasker()(uri), uri);
	assert.deepEqual(
		createDataMasker()({
			type: "base64",
			media_type: "image/png",
			data: "aGVsbG8=",
		}),
		{ type: "base64", media_type: "image/png", data: uri },
	);
	assert.equal(
		createDataMasker({ mediaEnabled: false })(uri),
		"[media upload disabled]",
	);
	const mask = createDataMasker();
	const input = { type: "base64", media_type: "image/png", data: "aGVsbG8=" };
	assert.deepEqual(
		mask(mask(input)),
		mask(input),
		"export-time masking must not double-prefix media URIs",
	);
});

test("detects nested provider-request media for extended flush budgets", () => {
	assert.equal(
		containsInlineMedia({
			messages: [
				{ content: { image_url: { url: "data:image/png;base64,aGVsbG8=" } } },
			],
		}),
		true,
	);
	assert.equal(
		containsInlineMedia({ messages: [{ content: "ordinary text" }] }),
		false,
	);
});

test("redacts text attachments before converting them back to media", () => {
	const text = JSON.stringify({
		apiKey: "private-attachment-key",
		email: "alice@example.com",
	});
	const uri = `data:application/json;base64,${Buffer.from(text).toString("base64")}`;
	const output = String(createDataMasker()(uri));
	const decoded = Buffer.from(output.split(",")[1], "base64").toString("utf8");
	assert.deepEqual(JSON.parse(decoded), {
		apiKey: SECRET_MARK,
		email: PII_MARK,
	});
});

test("masks dictionary keys without losing fields to redaction collisions", () => {
	const output = createDataMasker({
		secrets: ["key-secret-one", "key-secret-two"],
	})({
		"key-secret-one": 1,
		"key-secret-two": 2,
		"alice@example.com": 3,
	}) as Record<string, unknown>;
	assert.deepEqual(Object.values(output), [1, 2, 3]);
	assert.ok(!JSON.stringify(output).includes("key-secret"));
	assert.ok(!JSON.stringify(output).includes("alice@example.com"));
});

test("handles cycles and hostile getters without exporting original secrets", () => {
	const circular: Record<string, unknown> = { password: "private" };
	circular.self = circular;
	assert.deepEqual(createDataMasker()(circular), {
		password: SECRET_MARK,
		self: "[circular-ref]",
	});
	const hostile = Object.defineProperty({}, "payload", {
		enumerable: true,
		get: () => {
			throw new Error("private");
		},
	});
	assert.equal(createDataMasker()(hostile), MASK_FAILURE_MARK);
});

test("deeply nested payloads fail closed", () => {
	let nested: Record<string, unknown> = { password: "private" };
	for (let index = 0; index < 300; index += 1) nested = { child: nested };
	assert.equal(createDataMasker()(nested), MASK_FAILURE_MARK);
	assert.equal(createDataMasker()(JSON.stringify(nested)), MASK_FAILURE_MARK);
});

test("keeps __proto__ as data without changing the exported object's prototype", () => {
	const output = createDataMasker()(
		JSON.parse('{"__proto__":{"apiKey":"private"},"model":"test"}'),
	) as Record<string, unknown>;
	assert.equal(Object.getPrototypeOf(output), Object.prototype);
	assert.deepEqual(output.__proto__, { apiKey: SECRET_MARK });
});

test("captures exposed thinking and complete tool calls without opaque signatures", () => {
	const output = buildAssistantOutput([
		{
			type: "thinking",
			thinking: "First reasoning",
			thinkingSignature: "opaque-provider-state",
		},
		{ type: "text", text: "Visible answer" },
		{
			type: "toolCall",
			id: "call-1",
			name: "lookup",
			arguments: { query: "test" },
		},
		{ type: "thinking", thinking: "Second reasoning" },
	]);
	assert.deepEqual(output, {
		role: "assistant",
		content: "Visible answer",
		reasoning_content: "First reasoning\nSecond reasoning",
		tool_calls: [
			{
				id: "call-1",
				type: "function",
				function: { name: "lookup", arguments: '{"query":"test"}' },
			},
		],
	});
	assert.ok(!JSON.stringify(output).includes("opaque-provider-state"));
});

test("masks opaque provider reasoning state in native and Pi inputs", () => {
	const mask = createDataMasker();
	assert.deepEqual(
		mask({ type: "thinking", thinking: "visible", signature: "opaque" }),
		{
			type: "thinking",
			thinking: "visible",
			signature: SECRET_MARK,
		},
	);
	assert.deepEqual(mask({ type: "redacted_thinking", data: "opaque" }), {
		type: "redacted_thinking",
		data: SECRET_MARK,
	});
	assert.deepEqual(
		mask({ thoughtSignature: "opaque", encrypted_content: "opaque" }),
		{
			thoughtSignature: SECRET_MARK,
			encrypted_content: SECRET_MARK,
		},
	);
});

test("full assistant output is not truncated at the upstream 20k-character threshold", () => {
	const content = "x".repeat(30000);
	assert.equal(
		buildAssistantOutput([{ type: "text", text: content }]).content,
		content,
	);
});

test("first-token detection includes thinking and tool calls", () => {
	assert.equal(hasAssistantOutput([{ type: "thinking", thinking: "" }]), false);
	assert.equal(
		hasAssistantOutput([{ type: "thinking", thinking: "reasoning" }]),
		true,
	);
	assert.equal(hasAssistantOutput([{ type: "toolCall", id: "call" }]), true);
	assert.equal(hasAssistantOutput([]), false);
});
