import { expect, test, describe } from 'bun:test';
import { _internals } from '../../../src/hooks/delegation-gate';

describe('extractTaskFileDirectives', () => {
	test('extracts exact path', () => {
		const args = { prompt: 'FILE: src/foo.ts' };
		const result = _internals.extractTaskFileDirectives(args);
		expect(result.present).toBe(true);
		expect(result.files).toEqual(['src/foo.ts']);
	});

	test('strips trailing parenthetical annotations (issue)', () => {
		const args = { prompt: 'FILE: tests/unit/connection_limit_test.cpp (or another appropriately named test file in tests/unit/)' };
		const result = _internals.extractTaskFileDirectives(args);
		expect(result.present).toBe(true);
		expect(result.files).toEqual(['tests/unit/connection_limit_test.cpp']);
	});

	test('ignores parentheticals in the middle of paths if that were to happen, but strips at the end', () => {
		const args = { prompt: 'FILE: src/weird (dir)/file.ts (some comment)' };
		const result = _internals.extractTaskFileDirectives(args);
		expect(result.present).toBe(true);
		expect(result.files).toEqual(['src/weird (dir)/file.ts']);
	});
});
