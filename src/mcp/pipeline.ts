/**
 * Response pipeline for the read-only MCP verification surface (#2499).
 *
 * Every tool response leaving the MCP server passes through
 * `applyResponsePipeline`: secrets are redacted FIRST (redacting before
 * bounding matters — truncating first can split a secret pattern in half and
 * defeat redaction), then the serialized payload is bounded so a large
 * corpus can never produce an unbounded MCP response.
 */

import { redactSecrets } from '../memory/redaction.js';

/** Frozen acceptance cap (repro/check-mcp-bounded-output.sh, C8): the
 * JSON-serialized pipeline output may never exceed this many characters. */
export const MCP_MAX_RESPONSE_CHARS = 65_536;

const TRUNCATION_NOTE = '\n[swarm-mcp: response truncated to bound]';

function redactStringsDeep(value: unknown, depth = 0): unknown {
	if (depth > 32 || value === null || value === undefined) {
		return value;
	}
	if (typeof value === 'string') {
		return redactSecrets(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactStringsDeep(item, depth + 1));
	}
	if (value instanceof Map) {
		const next = new Map();
		for (const [k, v] of value) {
			next.set(redactStringsDeep(k, depth + 1), redactStringsDeep(v, depth + 1));
		}
		return next;
	}
	if (value instanceof Set) {
		const next = new Set();
		for (const item of value) next.add(redactStringsDeep(item, depth + 1));
		return next;
	}
	if (typeof value === 'object') {
		// Dates and other non-plain objects pass through untouched; only plain
		// record shapes are walked.
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			return value;
		}
		const next: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			next[k] = redactStringsDeep(v, depth + 1);
		}
		return next;
	}
	return value;
}

function serializeBounded(value: unknown): string {
	const json = JSON.stringify(value, null, 2) ?? 'null';
	if (json.length <= MCP_MAX_RESPONSE_CHARS) {
		return json;
	}
	// Deterministic bound: keep the head of the serialized form and append the
	// truncation marker inside the cap.
	const keep = Math.max(0, MCP_MAX_RESPONSE_CHARS - TRUNCATION_NOTE.length);
	return `${json.slice(0, keep)}${TRUNCATION_NOTE}`;
}

export interface ResponsePipelineResult {
	/** The redacted (still structured) payload. */
	redacted: unknown;
	/** The bounded serialized form actually sent to the client. */
	serialized: string;
	truncated: boolean;
}

/**
 * Redact every string in the payload (top-level and nested, including MCP
 * `content` arrays), then bound the serialized output to
 * {@link MCP_MAX_RESPONSE_CHARS} characters.
 */
export function applyResponsePipeline(payload: unknown): ResponsePipelineResult {
	const redacted = redactStringsDeep(payload);
	const serialized = serializeBounded(redacted);
	return {
		redacted,
		serialized,
		truncated: serialized.includes(TRUNCATION_NOTE),
	};
}
