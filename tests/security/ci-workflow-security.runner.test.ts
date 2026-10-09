import { describe, expect, test } from 'bun:test';
import { runWorkflowSecurityChecks } from './ci-workflow-security.test.cjs';

/**
 * Real bun:test wrapper for the adversarial ci.yml security suite
 * (PR #3163 feedback FB-001).
 *
 * The suite lives in tests/security/ci-workflow-security.test.cjs, which
 * previously self-executed via `require.main === module` and
 * process.exit(0)-terminated the shared `bun test` run on CI's bun (1.4.x,
 * where require.main === module is true for .cjs files), masking every other
 * failure. Its standalone path is now gated behind
 * RUN_CI_WORKFLOW_SECURITY=1; this file is what keeps the checks enforced
 * during `bun test` — the verdict is asserted as a real test, so a ci.yml
 * security regression fails the CI Test step instead of silently passing.
 */

describe('ci-workflow-security runner (PR #3163 FB-001)', () => {
	test('adversarial security suite for .github/workflows/ci.yml passes', () => {
		const results = runWorkflowSecurityChecks();
		expect(results.verdict).toBe('PASS');
		expect(results.failedTests).toBe(0);
	});

	test('runner exercises the full suite (7 checks, not a stub)', () => {
		const results = runWorkflowSecurityChecks();
		expect(results.totalTests).toBe(7);
		expect(results.passedTests).toBe(results.totalTests);
	});
});
