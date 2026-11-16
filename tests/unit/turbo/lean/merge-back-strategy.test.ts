/**
 * Tests for getMergeStrategy in src/turbo/lean/merge-back.ts
 *
 * Moved verbatim out of merge-back.test.ts (an over-cap legacy file under the
 * FR-006 ratchet) so that file does not grow. getMergeStrategy is a pure
 * config mapping, so these tests need no _internals mocking.
 */

import { describe, expect, test } from 'bun:test';
import type { LeanTurboConfig } from '../../../../src/config/schema';
import { getMergeStrategy } from '../../../../src/turbo/lean/merge-back';

// getMergeStrategy

describe('getMergeStrategy', () => {
	test('returns config.merge_strategy when set to merge', () => {
		const config: LeanTurboConfig = { merge_strategy: 'merge' };
		expect(getMergeStrategy(config)).toBe('merge');
	});

	test('returns config.merge_strategy when set to rebase', () => {
		const config: LeanTurboConfig = { merge_strategy: 'rebase' };
		expect(getMergeStrategy(config)).toBe('rebase');
	});

	test('returns config.merge_strategy when set to cherry-pick', () => {
		const config: LeanTurboConfig = { merge_strategy: 'cherry-pick' };
		expect(getMergeStrategy(config)).toBe('cherry-pick');
	});

	test('returns merge when config.merge_strategy is undefined', () => {
		const config: LeanTurboConfig = {};
		expect(getMergeStrategy(config)).toBe('merge');
	});
});
