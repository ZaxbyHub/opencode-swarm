export const DEFAULT_BOUNDS = {
	testTimeoutMs: 120_000,
	perItemTimeoutMs: 180_000,
	suiteTimeoutMs: 900_000,
	maxOutputBytes: 65_536,
} as const;

export const DEFAULT_TEST_TIMEOUT_MS = DEFAULT_BOUNDS.testTimeoutMs;
export const DEFAULT_PER_ITEM_TIMEOUT_MS = DEFAULT_BOUNDS.perItemTimeoutMs;
export const DEFAULT_SUITE_TIMEOUT_MS = DEFAULT_BOUNDS.suiteTimeoutMs;
export const DEFAULT_MAX_OUTPUT_BYTES = DEFAULT_BOUNDS.maxOutputBytes;
export const MAX_REPORT_BYTES = 1_048_576;
export const MAX_VALIDATION_ATTEMPT_HISTORY = 3;
