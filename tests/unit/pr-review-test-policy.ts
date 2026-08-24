import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../src/config/schema.js';

/** Pre-resilience tests intentionally exercise the legacy unstaged contract. */
export const LEGACY_PR_REVIEW_RESILIENCE_POLICY = Object.freeze({
	canary_probe_ms: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.canary_probe_ms,
	correlated_failure_threshold:
		DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.correlated_failure_threshold,
	enabled: false,
	max_retry_attempts_after_initial:
		DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.max_retry_attempts_after_initial,
	status_probe_timeout_ms:
		DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.status_probe_timeout_ms,
});
