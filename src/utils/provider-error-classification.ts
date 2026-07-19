/**
 * Issue #1896 (sub-issue 3): single source of truth for provider/model
 * transient-error classification.
 *
 * Previously the same `TRANSIENT_MODEL_ERROR_PATTERN` + transient-status-code set
 * was duplicated across `src/hooks/guardrails/index.ts`,
 * `src/hooks/guardrails/messages-transform.ts`, and `src/full-auto/oversight.ts`,
 * and NONE recognized provider quota / usage-limit exhaustion — so a role whose
 * model hit its quota mid-run failed the stage outright instead of failing over
 * to a configured fallback model.
 *
 * Design (see the plan critic's M1): QUOTA is a SEPARATE pattern and is combined
 * ONLY inside {@link isTransientProviderError}, which is consumed exclusively by
 * the model-DISPATCH classifiers (the failover helper + oversight/reviewer/runner
 * dispatch paths). The narrow {@link TRANSIENT_MODEL_ERROR_PATTERN} (no quota) is
 * what the guardrails tool-OUTPUT classifier keeps using, so a bash
 * `Disk quota exceeded` (EDQUOT) in tool stdout can never be misread as a
 * transient provider error and trigger a bogus model fallback.
 */

/** v6.33: Known HTTP status codes that indicate transient provider errors. */
export const TRANSIENT_STATUS_CODES = new Set([
	408, 429, 500, 502, 503, 504, 529,
]);

/** Extracts a transient HTTP status code from an error message string. */
export function extractStatusCode(errorMsg: string): number | null {
	const match = errorMsg.match(/\b(408|429|500|502|503|504|529)\b/);
	if (match) {
		return parseInt(match[1], 10);
	}
	return null;
}

/**
 * v6.33: Regex for transient model/provider errors that should trigger bounded
 * retry (and, in the dispatch paths, model fallback). Content is UNCHANGED from
 * the historical duplicated definition — quota is intentionally NOT here (see the
 * module doc + {@link QUOTA_ERROR_PATTERN}), so tool-output classifiers that
 * import this keep byte-identical behavior.
 */
export const TRANSIENT_MODEL_ERROR_PATTERN =
	/rate.?limit|429|500|502|503|504|529|timeout|overloaded|model.?not.?found|temporarily.?unavailable|provider[_\s-]?unavailable|server.?error|network.?connection.?lost|connection.?(refused|reset|timeout|lost)|bad.?gateway|gateway.?timeout|internal.?server.?error|service.?unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN/i;

/**
 * Issue #1896: provider quota / usage-limit / billing exhaustion — a class
 * distinct from a transient blip. It is retryable after a wait AND fallback-
 * eligible (a different configured model may have its own quota). Used ONLY on
 * model-DISPATCH error strings via {@link isTransientProviderError}, never on
 * tool stdout, so `Disk quota exceeded` shell output cannot false-trigger it.
 */
export const QUOTA_ERROR_PATTERN =
	/quota|usage.?limit|insufficient.?(?:quota|credits?)|\b402\b|payment.?required|credit.?balance|out of credits|billing.?(?:hard.?)?limit/i;

/**
 * True when a model-DISPATCH error is a transient provider failure OR a
 * quota/rate-limit exhaustion — both are retry + model-fallback eligible.
 * Do NOT use this on arbitrary tool output; use `TRANSIENT_MODEL_ERROR_PATTERN`
 * directly there (quota tokens would false-positive on shell stdout).
 */
export function isTransientProviderError(signal: string): boolean {
	if (!signal) return false;
	if (TRANSIENT_MODEL_ERROR_PATTERN.test(signal)) return true;
	if (QUOTA_ERROR_PATTERN.test(signal)) return true;
	const status = extractStatusCode(signal);
	return status !== null && TRANSIENT_STATUS_CODES.has(status);
}

/**
 * True when the dispatch error specifically indicates quota/usage-limit
 * exhaustion. Used to tag the fallback advisory / telemetry reason as `'quota'`
 * vs a generic transient failure.
 */
export function isQuotaError(signal: string): boolean {
	return signal.length > 0 && QUOTA_ERROR_PATTERN.test(signal);
}
