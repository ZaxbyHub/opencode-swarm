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

const HARD_GATE_KEYS = ['secretscan', 'sast_scan'] as const;
const COMPACT_OUTPUT_OMITTED_MESSAGE =
	'Detailed tool result omitted because the batch output exceeded its byte limit';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteDuration(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sastFindingKey(value: unknown): string | null {
	if (!isRecord(value) || !isRecord(value.location)) return null;
	const { rule_id, severity, message, location } = value;
	if (
		typeof rule_id !== 'string' ||
		typeof severity !== 'string' ||
		typeof message !== 'string' ||
		typeof location.file !== 'string' ||
		typeof location.line !== 'number' ||
		!Number.isSafeInteger(location.line) ||
		location.line < 1 ||
		!['critical', 'high', 'medium', 'low'].includes(severity) ||
		(location.column !== undefined &&
			(typeof location.column !== 'number' ||
				!Number.isSafeInteger(location.column) ||
				location.column < 1))
	) {
		return null;
	}
	return JSON.stringify([
		rule_id,
		severity,
		message,
		location.file,
		location.line,
		location.column ?? null,
	]);
}

function everyGateFindingIsPreexisting(
	result: Record<string, unknown>,
	batchResult: Record<string, unknown>,
): boolean {
	if (
		!Array.isArray(result.findings) ||
		!Array.isArray(batchResult.sast_preexisting_findings)
	) {
		return false;
	}
	const findingKeys = result.findings.map(sastFindingKey);
	if (findingKeys.some((key) => key === null)) return false;
	const gateFindingKeys = result.findings
		.filter(
			(finding) =>
				isRecord(finding) &&
				(finding.severity === 'high' || finding.severity === 'critical'),
		)
		.map(sastFindingKey);
	if (gateFindingKeys.length === 0) return false;
	const remainingPreexisting =
		batchResult.sast_preexisting_findings.map(sastFindingKey);
	if (remainingPreexisting.some((key) => key === null)) return false;
	for (const gateFindingKey of gateFindingKeys) {
		const index = remainingPreexisting.indexOf(gateFindingKey);
		if (index < 0) return false;
		remainingPreexisting.splice(index, 1);
	}
	return true;
}

function isIntentionalSastSkip(
	toolResult: Record<string, unknown>,
	batchResult: Record<string, unknown>,
): boolean {
	return (
		batchResult.sast_skipped === true &&
		toolResult.ran === false &&
		toolResult.duration_ms === 0 &&
		toolResult.passed === undefined &&
		toolResult.result === undefined &&
		toolResult.error === undefined &&
		toolResult.result_omitted === undefined
	);
}

function isExpectedSastDegradation(
	toolResult: Record<string, unknown>,
	batchResult: Record<string, unknown>,
): boolean {
	if (batchResult.sast_degraded !== true || toolResult.ran !== true) {
		return false;
	}
	if (
		batchResult.output_truncated === true &&
		toolResult.result_omitted === true &&
		toolResult.passed === undefined &&
		toolResult.result === undefined &&
		toolResult.error === undefined
	) {
		return true;
	}
	if (
		toolResult.passed !== undefined ||
		toolResult.error !== undefined ||
		toolResult.result_omitted !== undefined
	) {
		return false;
	}
	const result = toolResult.result;
	return (
		isRecord(result) &&
		result.verdict === 'fail' &&
		typeof result.error === 'string' &&
		result.failure_kind === 'semgrep_process_exit' &&
		Array.isArray(result.findings) &&
		result.findings.length === 0 &&
		result.baseline_used !== true
	);
}

function hardGateExplicitlyFailed(
	key: (typeof HARD_GATE_KEYS)[number],
	toolResult: Record<string, unknown>,
	batchResult: Record<string, unknown>,
): boolean {
	if (key === 'sast_scan' && isIntentionalSastSkip(toolResult, batchResult)) {
		return false;
	}
	if (toolResult.ran === false || toolResult.passed === false) return true;
	if (
		typeof toolResult.error === 'string' &&
		toolResult.error !== COMPACT_OUTPUT_OMITTED_MESSAGE
	) {
		return true;
	}

	const result = toolResult.result;
	if (!isRecord(result)) {
		return !(
			result === undefined &&
			batchResult.output_truncated === true &&
			toolResult.result_omitted === true &&
			toolResult.error === undefined
		);
	}
	if (toolResult.result_omitted !== undefined) return true;
	if (
		key === 'sast_scan' &&
		isExpectedSastDegradation(toolResult, batchResult)
	) {
		return false;
	}
	if (result.passed === false || typeof result.error === 'string') return true;

	if (key === 'secretscan') {
		if (
			typeof result.count !== 'number' ||
			!Number.isSafeInteger(result.count) ||
			result.count < 0 ||
			!Array.isArray(result.findings) ||
			typeof result.files_scanned !== 'number' ||
			!Number.isSafeInteger(result.files_scanned) ||
			result.files_scanned < 0 ||
			typeof result.incomplete_files !== 'number' ||
			!Number.isSafeInteger(result.incomplete_files) ||
			result.incomplete_files < 0 ||
			!Array.isArray(result.incomplete_paths)
		) {
			return true;
		}
		return (
			result.count > 0 ||
			result.findings.length > 0 ||
			result.incomplete_files > 0 ||
			result.incomplete_paths.length > 0 ||
			result.files_scanned === 0
		);
	}

	if (result.verdict === 'pass') return false;
	if (result.verdict !== 'fail') return true;
	// A legacy SAST failure may aggregate to pass only when the producer also
	// supplies the changed-line classification evidence proving every gate-level
	// finding pre-existing. Baseline failures are always definitive.
	return (
		result.baseline_used === true ||
		!everyGateFindingIsPreexisting(result, batchResult)
	);
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
	if (
		parsed.output_truncated !== undefined &&
		typeof parsed.output_truncated !== 'boolean'
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
	if (
		(parsed.sast_skipped !== undefined &&
			typeof parsed.sast_skipped !== 'boolean') ||
		(parsed.sast_degraded !== undefined &&
			typeof parsed.sast_degraded !== 'boolean')
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}

	const ranStates: boolean[] = [];
	for (const key of TOOL_KEYS) {
		const toolResult = parsed[key];
		if (
			!isRecord(toolResult) ||
			typeof toolResult.ran !== 'boolean' ||
			!isFiniteDuration(toolResult.duration_ms) ||
			(toolResult.error !== undefined &&
				typeof toolResult.error !== 'string') ||
			(toolResult.result_omitted !== undefined &&
				typeof toolResult.result_omitted !== 'boolean') ||
			(toolResult.result_omitted === true &&
				(toolResult.result !== undefined || toolResult.error !== undefined))
		) {
			return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
		}
		ranStates.push(toolResult.ran);
	}

	const allSkipped = ranStates.every((ran) => ran === false);
	const anyRan = ranStates.some((ran) => ran === true);
	const batchStatus = parsed.batch_status;
	if (
		parsed.sast_skipped === true &&
		!isIntentionalSastSkip(parsed.sast_scan as Record<string, unknown>, parsed)
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
	if (
		parsed.sast_degraded === true &&
		!isExpectedSastDegradation(
			parsed.sast_scan as Record<string, unknown>,
			parsed,
		)
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}
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

	// F-001 prior bug: the aggregate boolean was trusted even when a hard gate
	// carried an explicit failure. Reject only definitive contradictions so
	// legacy SAST passes based on pre-existing-line classification remain valid.
	if (
		parsed.gates_passed &&
		HARD_GATE_KEYS.some((key) =>
			hardGateExplicitlyFailed(
				key,
				parsed[key] as Record<string, unknown>,
				parsed,
			),
		)
	) {
		return { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };
	}

	return parsed.gates_passed
		? { kind: 'pass' }
		: { kind: 'fail', code: 'PRE_CHECK_FAILED' };
}

export const _internals = {
	MAX_PRE_CHECK_RESULT_BYTES,
};
