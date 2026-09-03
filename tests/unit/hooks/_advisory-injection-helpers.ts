import type { GuardrailsConfig } from '../../../src/config/schema';

/**
 * Shared guardrails config fixture for the advisory-injection suites
 * (extracted so the FR-006-capped entry suite stays at its baseline size).
 */
export const defaultConfig: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	idle_timeout_minutes: 60,
	qa_gates: {
		required_tools: [
			'diff',
			'syntax_check',
			'placeholder_scan',
			'lint',
			'pre_check_batch',
		],
		require_reviewer_test_engineer: true,
	},
};
