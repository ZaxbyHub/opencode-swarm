import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../src/config/schema.js';

/** Pre-resilience tests intentionally exercise the legacy unstaged contract. */
export const LEGACY_PR_REVIEW_RESILIENCE_POLICY = Object.freeze({
	...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
	enabled: false,
});
