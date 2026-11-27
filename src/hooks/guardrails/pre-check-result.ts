const MAX_PRE_CHECK_RESULT_BYTES = 512_000;

export type PreCheckVerdict =
	| { kind: 'pass' }
	| {
			kind: 'fail';
			code: 'PRE_CHECK_FAILED' | 'PRE_CHECK_INPUT_INVALID';
			/**
			 * 2026-11-27 (task 2.18 retry-circuit wedge): what the failure says
			 * about the CODE under gate. `'infrastructure'` means every failing
			 * gate signal is positively an execution/persistence error (a gate
			 * wrapper error, a scan-process error, an evidence-save throw —
			 * nothing about the coder's content was rejected); `'content'` is
			 * everything else, including every unprovable shape (findings,
			 * fail verdicts, truncation, contradictions). Conservative by
			 * construction: only a positively proven execution-only failure is
			 * infrastructure.
			 */
			cause: 'content' | 'infrastructure';
	  }
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

/**
 * #3092: secretscan diff-scope proof. The batch result carries the exact
 * pre-existing findings (`secretscan_preexisting_findings`); the decoder only
 * disarms its findings-count conditions when that proof multiset-covers the
 * ENTIRE total set (`count === findings.length` and every visible finding is
 * claimed). A forged `passed` without the proof still blocks.
 */
function everySecretFindingIsPreexisting(
	result: Record<string, unknown>,
	batchResult: Record<string, unknown>,
): boolean {
	if (
		!Array.isArray(result.findings) ||
		!Array.isArray(batchResult.secretscan_preexisting_findings)
	) {
		return false;
	}
	const count = result.count;
	if (
		typeof count !== 'number' ||
		!Number.isSafeInteger(count) ||
		count !== result.findings.length
	) {
		// A total-set mismatch can never be proven pre-existing.
		return false;
	}
	const secretFindingKey = (finding: unknown): string | null => {
		if (!isRecord(finding)) return null;
		const { path, line, type } = finding;
		if (
			typeof path !== 'string' ||
			path.length === 0 ||
			typeof line !== 'number' ||
			!Number.isSafeInteger(line) ||
			// #3092 review PRR-021: mirror the producer classifier — it forces
			// non-positive lines NEW unconditionally, so they can never be
			// honestly claimed pre-existing.
			line < 1 ||
			typeof type !== 'string'
		) {
			return null;
		}
		return JSON.stringify([path, line, type]);
	};
	const remainingPreexisting =
		batchResult.secretscan_preexisting_findings.map(secretFindingKey);
	if (remainingPreexisting.some((key) => key === null)) return false;
	for (const finding of result.findings) {
		const key = secretFindingKey(finding);
		if (key === null) return false;
		const index = remainingPreexisting.indexOf(key);
		if (index < 0) return false;
		remainingPreexisting.splice(index, 1);
	}
	// #3092 review PRR-021: a superset proof claims findings that are not in
	// the total set — the honest producer emits exactly the pre-existing
	// subset, so leftovers mean the proof does not match the scan.
	if (remainingPreexisting.length !== 0) return false;
	return true;
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
			!Array.isArray(result.incomplete_paths) ||
			// #3092 review PRR-012: the truncation arm below is strict
			// `=== true`, so a forged non-boolean truncated value ("true", 1)
			// must not silently disable it — treat a present-but-non-boolean
			// flag as malformed and keep blocking.
			(result.truncated !== undefined && typeof result.truncated !== 'boolean')
		) {
			return true;
		}
		// #2918 vacuous coverage — decoder parity with the tool-side gate.
		// Normative predicate (this site adds stricter integer-format guards; semantically
		// equivalent on producer-emitted integers at every enforcing site;
		// files_scanned === 0 && policy_skipped_files >= requested_files &&
		// requested_files > 0 && count === 0 && findings empty &&
		// incomplete_files === 0 && incomplete_paths empty. A record MISSING
		// policy_skipped_files/requested_files is non-vacuous (predicate false,
		// previous fail-closed behavior) and never invalid.
		const vacuousCoverage =
			result.files_scanned === 0 &&
			typeof result.policy_skipped_files === 'number' &&
			Number.isSafeInteger(result.policy_skipped_files) &&
			result.policy_skipped_files >= 0 &&
			typeof result.requested_files === 'number' &&
			Number.isSafeInteger(result.requested_files) &&
			result.requested_files > 0 &&
			result.policy_skipped_files >= result.requested_files &&
			result.count === 0 &&
			result.findings.length === 0 &&
			result.incomplete_files === 0 &&
			result.incomplete_paths.length === 0;
		// #3092 diff-scope parity with the tool-side gate. The batch-carried
		// pre-existing proof disarms ONLY the findings-count conditions:
		// truncation, incomplete coverage, and zero-coverage-without-vacuous-
		// proof keep blocking regardless of the proof — the decoder is the
		// contradiction boundary for a forged `passed`. (The former explicit
		// count !== findings.length clause was removed as logically dead in
		// review: a mismatch makes everySecretFindingIsPreexisting false, so
		// the count/findings arms above already fire.)
		const preexistingProof = everySecretFindingIsPreexisting(
			result,
			batchResult,
		);
		return (
			(result.count > 0 && !preexistingProof) ||
			(result.findings.length > 0 && !preexistingProof) ||
			result.truncated === true ||
			result.incomplete_files > 0 ||
			result.incomplete_paths.length > 0 ||
			(result.files_scanned === 0 && !vacuousCoverage)
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
 * 2026-11-27 (task 2.18 retry-circuit wedge): classify what a FAILING batch
 * says about the code under gate. Only `secretscan` and `sast_scan` can fail
 * the batch (lint and quality_budget are informational in the producer), so
 * the classifier walks exactly the two hard gates.
 *
 * A gate's failure is INFRASTRUCTURE only when it is positively an
 * execution/persistence error and positively nothing else:
 *  - a wrapper-level `error` string (scan tool missing, process failure,
 *    evidence-save throw — the 2.18 shape: "Failed to persist sast evidence:
 *    Evidence bundle size ... exceeds maximum ...") with no findings in the
 *    result, or
 *  - a result-level `error` string with zero findings and a non-degraded
 *    failure kind (the producer marks execution failures with BOTH a fail
 *    verdict and an error — the verdict alone is ambiguous and never proves
 *    content).
 * Everything else — findings, an error-free fail verdict, baseline mismatch,
 * truncation, the compact-omitted shape, contradictory shapes (failed with
 * neither an error nor content) — is CONTENT (or unprovable, which counts as
 * content). The batch is infrastructure iff at least one gate contributed an
 * infrastructure failure and NO gate contributed a content failure.
 */
function classifyPreCheckFailureCause(
	parsed: Record<string, unknown>,
): 'content' | 'infrastructure' {
	let sawInfrastructureSignal = false;
	for (const key of HARD_GATE_KEYS) {
		const toolResult = parsed[key];
		if (!isRecord(toolResult)) return 'content';
		const result = toolResult.result;
		const resultRecord = isRecord(result)
			? (result as Record<string, unknown>)
			: null;
		const wrapperError =
			typeof toolResult.error === 'string' &&
			toolResult.error !== COMPACT_OUTPUT_OMITTED_MESSAGE
				? toolResult.error
				: null;
		const resultError =
			resultRecord !== null &&
			typeof resultRecord.error === 'string' &&
			resultRecord.error !== COMPACT_OUTPUT_OMITTED_MESSAGE
				? resultRecord.error
				: null;
		if (!hardGateExplicitlyFailed(key, toolResult, parsed)) continue;
		// Truncated/omitted shapes are unprovable — never infrastructure.
		if (
			toolResult.result_omitted !== undefined ||
			toolResult.error === COMPACT_OUTPUT_OMITTED_MESSAGE
		) {
			return 'content';
		}
		// Content payload: findings on the code under gate, a fail verdict the
		// ERROR did not drive (the producer marks execution failures with
		// verdict 'fail' AND an error — a verdict alone is ambiguous), or a
		// baseline mismatch (always definitive).
		const findingsPresent =
			resultRecord !== null &&
			((Array.isArray(resultRecord.findings) &&
				resultRecord.findings.length > 0) ||
				(typeof resultRecord.count === 'number' && resultRecord.count > 0));
		const verdictFailWithoutError =
			resultRecord !== null &&
			resultRecord.verdict === 'fail' &&
			wrapperError === null &&
			resultError === null;
		const baselineUsed = resultRecord?.baseline_used === true;
		if (findingsPresent || verdictFailWithoutError || baselineUsed) {
			return 'content';
		}
		// The designed semgrep degradation shape (process exit, zero findings)
		// never fails the batch on its own; a FAILED batch carrying it without
		// the sast_degraded flag is contradictory — unprovable, therefore
		// content.
		if (
			key === 'sast_scan' &&
			resultRecord?.failure_kind === 'semgrep_process_exit'
		) {
			return 'content';
		}
		if (wrapperError !== null || resultError !== null) {
			sawInfrastructureSignal = true;
			continue;
		}
		// Failed with neither an execution error nor a content payload —
		// contradictory shape (e.g. ran:false with no error). Unprovable,
		// therefore content.
		return 'content';
	}
	return sawInfrastructureSignal ? 'infrastructure' : 'content';
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
			? {
					kind: 'fail',
					code: 'PRE_CHECK_INPUT_INVALID',
					// A malformed batch INPUT (no files, oversize input, bad
					// directory) rejected the CALL, not the coder's content —
					// every gate in this shape carries only the input error.
					cause: 'infrastructure',
				}
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
		: {
				kind: 'fail',
				code: 'PRE_CHECK_FAILED',
				cause: classifyPreCheckFailureCause(parsed),
			};
}

export const _internals = {
	MAX_PRE_CHECK_RESULT_BYTES,
};
