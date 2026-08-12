const MAX_PRE_CHECK_RESULT_BYTES = 512_000;

export type PreCheckVerdict =
	| { kind: 'pass' }
	| { kind: 'fail'; code: 'PRE_CHECK_FAILED' | 'PRE_CHECK_INPUT_INVALID' }
	| { kind: 'skip' }
	| { kind: 'invalid'; code: 'PRE_CHECK_RESULT_INVALID' };

const TOOL_KEYS = [
	'lint',
	'secretscan',
	'sast_scan',
	'quality_budget',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteDuration(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Decode the public pre_check_batch result without treating nested text as
 * control data. Unknown, oversized, truncated, or contradictory shapes are
 * non-passing and receive one bounded diagnostic code.
 */
export function decodePreCheckResult(output: unknown): PreCheckVerdict {
	if (
		typeof output !== 'string' ||
		Buffer.byteLength(output, 'utf8') > MAX_PRE_CHECK_RESULT_BYTES
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
	if (!isRecord(parsed) || typeof parsed.gates_passed !== 'boolean') {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
	if (!isFiniteDuration(parsed.total_duration_ms)) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}

	const ranStates: boolean[] = [];
	for (const key of TOOL_KEYS) {
		const toolResult = parsed[key];
		if (
			!isRecord(toolResult) ||
			typeof toolResult.ran !== 'boolean' ||
			!isFiniteDuration(toolResult.duration_ms) ||
			(toolResult.error !== undefined && typeof toolResult.error !== 'string')
		) {
			return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
		}
		ranStates.push(toolResult.ran);
	}

	const allSkipped = ranStates.every((ran) => ran === false);
	const anyRan = ranStates.some((ran) => ran === true);
	const batchStatus = parsed.batch_status;
	if (
		batchStatus !== undefined &&
		batchStatus !== 'completed' &&
		batchStatus !== 'skipped' &&
		batchStatus !== 'invalid'
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}

	if (batchStatus === 'skipped') {
		return allSkipped && parsed.gates_passed === false
			? { kind: 'skip' }
			: { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
	if (batchStatus === 'invalid') {
		return allSkipped && parsed.gates_passed === false
			? { kind: 'fail', code: 'PRE_CHECK_INPUT_INVALID' }
			: { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
	if (batchStatus === 'completed' && !anyRan) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}

	// Old valid producers had no batch_status. Preserve their explicit
	// all-tools-skipped result as neutral/unknown rather than manufacturing a
	// pass or failure from nested text.
	if (batchStatus === undefined && allSkipped) return { kind: 'skip' };

	return parsed.gates_passed
		? { kind: 'pass' }
		: { kind: 'fail', code: 'PRE_CHECK_FAILED' };
}

export const _internals = {
	MAX_PRE_CHECK_RESULT_BYTES,
};
