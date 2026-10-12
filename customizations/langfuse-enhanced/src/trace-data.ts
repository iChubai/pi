export const SECRET_MARK = "[redacted-secret]";
export const PII_MARK = "[redacted-pii]";
export const MASK_FAILURE_MARK = "[redaction-failed]";

const secretField =
	/(?:^|_)(?:api_?key|public_?key|secret_?key|secret|password|passwd|passphrase|authorization|proxy_authorization|access_?token|refresh_?token|id_?token|session_?token|token|cookie|set_cookie|private_?key|credentials?|client_secret|(?:thinking|thought|reasoning)_signature|encrypted_content|密钥|密码|口令|令牌|凭证|公钥|私钥)$/i;
const piiField =
	/(?:^|_)(?:email|email_address|phone|phone_number|mobile|ssn|social_security_number|first_name|last_name|full_name|street_address|postal_address|address|date_of_birth|dob|ip_address|姓名|手机号|手机号码|电话号码|联系电话|邮箱|电子邮箱|身份证|身份证号|身份证号码|住址|家庭地址|出生日期|生日)$/i;
const schemaTypes = new Set([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
const schemaValueFields = new Set([
	"default",
	"example",
	"examples",
	"enum",
	"const",
]);
const schemaKeywords = new Set([
	"$schema",
	"$id",
	"$ref",
	"$defs",
	"definitions",
	"type",
	"title",
	"description",
	"properties",
	"patternProperties",
	"additionalProperties",
	"required",
	"items",
	"prefixItems",
	"additionalItems",
	"contains",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"nullable",
	"enum",
	"const",
	"default",
	"example",
	"examples",
	"format",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"dependentRequired",
	"dependentSchemas",
	"deprecated",
	"readOnly",
	"writeOnly",
	"contentEncoding",
	"contentMediaType",
	"discriminator",
]);

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaObject(value: unknown): value is Record<string, unknown> {
	if (
		!record(value) ||
		!Object.keys(value).every(
			(key) => schemaKeywords.has(key) || key.startsWith("x-"),
		)
	)
		return false;
	if (
		"type" in value &&
		!(typeof value.type === "string" && schemaTypes.has(value.type)) &&
		!Array.isArray(value.type)
	)
		return false;
	if (
		"properties" in value &&
		(!record(value.properties) ||
			!Object.values(value.properties).every(
				(field) => typeof field === "boolean" || record(field),
			))
	)
		return false;
	return true;
}

function fieldName(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.\s-]+/g, "_");
}

export function createDataMasker(
	options: {
		secrets?: readonly string[];
		env?: Record<string, string | undefined>;
		maskPii?: boolean;
		mediaEnabled?: boolean;
	} = {},
): (value: unknown) => unknown {
	const maskPii = options.maskPii ?? true;
	const mediaEnabled = options.mediaEnabled ?? true;
	const literals = new Set(options.secrets?.filter(Boolean) ?? []);
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (
			value &&
			value.length >= 8 &&
			/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i.test(name)
		) {
			literals.add(value);
		}
	}
	const escaped = [...literals]
		.sort((a, b) => b.length - a.length)
		.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const literalPattern = escaped.length
		? new RegExp(escaped.join("|"), "g")
		: undefined;

	const maskText = (text: string, ancestors: readonly object[]): string => {
		const media = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]*)$/i.exec(text);
		if (media) {
			if (!mediaEnabled) return "[media upload disabled]";
			if (
				/^text\//i.test(media[1]) ||
				/^application\/(?:json|xml|yaml|[\w.+-]+\+json)$/i.test(media[1])
			) {
				const decoded = Buffer.from(media[2], "base64").toString("utf8");
				return `data:${media[1]};base64,${Buffer.from(maskText(decoded, ancestors)).toString("base64")}`;
			}
			return text;
		}
		// Serialized tool arguments and file contents must receive field-based masking too.
		if (/^\s*[[{]/.test(text)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				// Plain text that happens to start with a bracket still needs text masking.
			}
			if (parsed !== null && typeof parsed === "object")
				return JSON.stringify(walk(parsed, ancestors));
		}
		let result = literalPattern
			? text.replace(literalPattern, SECRET_MARK)
			: text;
		result = result
			.replace(
				/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
				SECRET_MARK,
			)
			.replace(/\b[sp]k-lf-[\w-]+\b/g, SECRET_MARK)
			.replace(
				/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
				SECRET_MARK,
			)
			.replace(
				/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
				SECRET_MARK,
			)
			.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, SECRET_MARK)
			.replace(
				/\b((?:proxy-)?authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s"'<>]+/gi,
				`$1${SECRET_MARK}`,
			)
			.replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${SECRET_MARK}`)
			.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${SECRET_MARK}@`);
		result = result.replace(
			/["']?\b([A-Za-z_][A-Za-z0-9_.-]{0,96})["']?(\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;{}[\]"'\r\n]+)/g,
			(match, name: string, separator: string) => {
				const key = fieldName(name);
				if (secretField.test(key)) return `${name}${separator}${SECRET_MARK}`;
				if (maskPii && piiField.test(key))
					return `${name}${separator}${PII_MARK}`;
				return match;
			},
		);
		result = result.replace(
			/["']?(密钥|密码|口令|令牌|凭证|公钥|私钥|姓名|手机号|手机号码|电话号码|联系电话|邮箱|电子邮箱|身份证号(?:码)?|身份证|住址|家庭地址|出生日期|生日)["']?(\s*[:：=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;，；。{}[\]"'\r\n]+)/g,
			(match, name: string, separator: string) =>
				secretField.test(name)
					? `${name}${separator}${SECRET_MARK}`
					: maskPii
						? `${name}${separator}${PII_MARK}`
						: match,
		);
		if (maskPii) {
			result = result
				.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, PII_MARK)
				.replace(/\+[1-9]\d{0,2}(?:[ ().-]*\d){7,14}\b/g, PII_MARK)
				.replace(/\(\d{3}\)[ .-]*\d{3}[ .-]\d{4}\b/g, PII_MARK)
				.replace(/\b\d{3}-\d{2}-\d{4}\b/g, PII_MARK)
				.replace(/(?<![A-Za-z0-9_])1[3-9]\d{9}(?![A-Za-z0-9_])/g, PII_MARK)
				.replace(
					/(?<![A-Za-z0-9_])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![A-Za-z0-9_])/g,
					PII_MARK,
				)
				.replace(
					/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
					PII_MARK,
				);
		}
		return result;
	};

	const walk = (
		value: unknown,
		ancestors: readonly object[],
		inSchema = false,
		schemaSecret = false,
		schemaPii = false,
	): unknown => {
		if (typeof value === "string") return maskText(value, ancestors);
		if (value === null || typeof value !== "object") {
			return typeof value === "bigint" ? value.toString() : value;
		}
		if (ancestors.includes(value)) return "[circular-ref]";
		if (ancestors.length > 256)
			throw new Error("Redaction depth limit exceeded");
		const chain = [...ancestors, value];
		if (Array.isArray(value))
			return value.map((item) =>
				walk(item, chain, inSchema, schemaSecret, schemaPii),
			);
		if (value instanceof Date) return value.toISOString();
		const fields: Record<string, unknown> = {};
		const object = value as Record<string, unknown>;
		const schema = schemaObject(object);
		const mediaType =
			typeof object.mimeType === "string" ? object.mimeType : object.media_type;
		for (const [key, field] of Object.entries(object)) {
			const normalized = fieldName(key);
			const schemaDefinition =
				inSchema && (typeof field === "boolean" || schemaObject(field));
			let next: unknown;
			if (
				(object.type === "thinking" && key === "signature") ||
				(object.type === "redacted_thinking" && key === "data") ||
				(!schemaDefinition && secretField.test(normalized)) ||
				(schemaSecret && schemaValueFields.has(key))
			) {
				next =
					schemaSecret && schemaValueFields.has(key) && Array.isArray(field)
						? field.map(() => SECRET_MARK)
						: SECRET_MARK;
			} else if (
				maskPii &&
				((!schemaDefinition && piiField.test(normalized)) ||
					(schemaPii && schemaValueFields.has(key)))
			) {
				next =
					schemaPii && schemaValueFields.has(key) && Array.isArray(field)
						? field.map(() => PII_MARK)
						: PII_MARK;
			} else if (
				key === "data" &&
				typeof field === "string" &&
				typeof mediaType === "string" &&
				/^(image|audio)\//.test(mediaType)
			) {
				next = mediaEnabled
					? field.startsWith("data:") || field.startsWith("@@@langfuseMedia:")
						? maskText(field, chain)
						: `data:${mediaType};base64,${field}`
					: "[media upload disabled]";
			} else {
				next = walk(
					field,
					chain,
					schema &&
						[
							"properties",
							"patternProperties",
							"$defs",
							"definitions",
						].includes(key),
					schemaSecret || (schemaDefinition && secretField.test(normalized)),
					schemaPii || (schemaDefinition && piiField.test(normalized)),
				);
			}
			// Dictionary keys can contain email addresses or literal credentials too.
			const maskedKey = maskText(key, chain);
			let exportKey = maskedKey;
			let collision = 1;
			while (Object.hasOwn(fields, exportKey))
				exportKey = `${maskedKey} (${collision++})`;
			Object.defineProperty(fields, exportKey, {
				value: next,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return fields;
	};
	return (value) => {
		try {
			return walk(value, []);
		} catch {
			// A redaction failure must never fall back to exporting the original payload.
			return MASK_FAILURE_MARK;
		}
	};
}

export function containsInlineMedia(value: unknown): boolean {
	if (typeof value === "string") return /data:[^;,]+;base64,/.test(value);
	return (
		value !== null &&
		typeof value === "object" &&
		Object.values(value).some(containsInlineMedia)
	);
}

export function buildAssistantOutput(
	content: unknown,
): Record<string, unknown> {
	const output: Record<string, unknown> = { role: "assistant" };
	if (typeof content === "string") return { ...output, content };
	if (!Array.isArray(content)) return output;
	const texts: string[] = [];
	const thinking: string[] = [];
	const toolCalls: Record<string, unknown>[] = [];
	for (const part of content) {
		if (!record(part)) continue;
		if (part.type === "text" && typeof part.text === "string")
			texts.push(part.text);
		if (part.type === "thinking" && typeof part.thinking === "string")
			thinking.push(part.thinking);
		if (part.type === "toolCall" && typeof part.name === "string") {
			toolCalls.push({
				id: part.id,
				type: "function",
				function: {
					name: part.name,
					arguments: JSON.stringify(part.arguments ?? {}),
				},
			});
		}
	}
	if (texts.length) output.content = texts.join("");
	if (thinking.length) output.reasoning_content = thinking.join("\n");
	if (toolCalls.length) output.tool_calls = toolCalls;
	return output;
}

export function hasAssistantOutput(content: unknown): boolean {
	return typeof content === "string"
		? content.length > 0
		: Array.isArray(content) &&
				content.some(
					(part) =>
						record(part) &&
						((part.type === "text" &&
							typeof part.text === "string" &&
							part.text.length > 0) ||
							(part.type === "thinking" &&
								typeof part.thinking === "string" &&
								part.thinking.length > 0) ||
							part.type === "toolCall"),
				);
}
