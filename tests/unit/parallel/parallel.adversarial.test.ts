/**
 * Security Tests: Parallel Module - Test Suite Wrapper
 *
 * This file imports all parallel adversarial test modules.
 * Individual test files can be run separately to avoid session instability.
 *
 * Run individual modules:
 *   bun test tests/unit/parallel/review-router.adversarial.test.ts
 *   bun test tests/unit/parallel/file-locks.adversarial.test.ts
 *
 * Note: `dependency-graph` and `meta-indexer` modules were deleted (#1656):
 * they had zero production importers, were only consumed by their own tests,
 * and parsed plan.json with a private schema (a second plan interpretation
 * that AGENTS.md invariant 5 says should not exist outside the ledger path).
 */

import { describe, expect, it } from 'bun:test';

// Import test modules to register them with the test runner
import './review-router.adversarial.test.js';
import './file-locks.adversarial.test.js';

describe('Parallel Security Tests', () => {
	it('should have loaded all adversarial test modules', () => {
		// Placeholder - actual tests are in imported modules
		expect(true).toBe(true);
	});
});
