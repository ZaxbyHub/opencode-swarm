/**
 * Issue #2078 — pure-function unit tests for scripts/check-test-file-cap.ts.
 *
 * Direct-import tests of the exported pure functions (MAX_LINES,
 * resolveEnforce, normalizedLineCount, splitNulList, evaluateCap). No
 * spawning, no git, no filesystem — all I/O for evaluateCap is injected.
 * The end-to-end (real git repo) behavior is covered by
 * tests/unit/scripts/check-test-file-cap.test.ts; this file is Tier 0
 * (`_test_exports`-style direct import) coverage of the decision table.
 */

import { describe, expect, test } from 'bun:test';
import {
	type CapEvaluationInput,
	evaluateCap,
	MAX_LINES,
	normalizedLineCount,
	resolveEnforce,
	splitNulList,
} from '../../../scripts/check-test-file-cap';

describe('check-test-file-cap — MAX_LINES', () => {
	test('is 500 (single source of truth for FR-006)', () => {
		expect(MAX_LINES).toBe(500);
	});
});

describe('check-test-file-cap — resolveEnforce', () => {
	test('undefined -> true (default enforce)', () => {
		expect(resolveEnforce(undefined)).toBe(true);
	});

	test.each([
		'0',
		'false',
		'no',
		'off',
		'FALSE',
		'Off',
	])('%p -> false (soft-warn)', (raw) => {
		expect(resolveEnforce(raw)).toBe(false);
	});

	test.each([
		'',
		'1',
		'true',
		'yes',
		'anything',
		// Bash-parity: the original compared the RAW value, so a padded value
		// is not one of the soft-warn tokens and must still enforce. Trimming
		// here would silently disable the gate (issue #2078 review finding 1).
		' off ',
		' 0 ',
	])('%p -> true (enforce)', (raw) => {
		expect(resolveEnforce(raw)).toBe(true);
	});
});

describe('check-test-file-cap — normalizedLineCount (wc -l semantics)', () => {
	test('empty string -> 0', () => {
		expect(normalizedLineCount('')).toBe(0);
	});

	test('"a\\n" -> 1', () => {
		expect(normalizedLineCount('a\n')).toBe(1);
	});

	test('"a\\nb" (no trailing newline) -> 1, not 2', () => {
		expect(normalizedLineCount('a\nb')).toBe(1);
	});

	test('"a\\nb\\n" -> 2', () => {
		expect(normalizedLineCount('a\nb\n')).toBe(2);
	});
});

describe('check-test-file-cap — splitNulList', () => {
	test('empty string -> []', () => {
		expect(splitNulList('')).toEqual([]);
	});

	test('"a\\0b\\0" -> ["a", "b"]', () => {
		expect(splitNulList('a\0b\0')).toEqual(['a', 'b']);
	});
});

describe('check-test-file-cap — evaluateCap decision table', () => {
	function makeInput(
		overrides: Partial<CapEvaluationInput>,
	): CapEvaluationInput {
		return {
			changedFiles: [],
			addedFiles: [],
			currentLineCount: () => null,
			baseLineCount: () => 0,
			enforce: true,
			...overrides,
		};
	}

	test('non-.test.ts changed file over cap is ignored', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['src/big-thing.ts'],
				addedFiles: ['src/big-thing.ts'],
				currentLineCount: () => 900,
				baseLineCount: () => 0,
			}),
		);
		expect(result.newFileViolations).toBe(0);
		expect(result.ratchetViolations).toBe(0);
		expect(result.exitCode).toBe(0);
		expect(result.messages.join('\n')).not.toInclude('src/big-thing.ts');
	});

	test('added .test.ts over cap -> new-file violation, exit 1', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/foo.test.ts'],
				addedFiles: ['tests/foo.test.ts'],
				currentLineCount: () => 600,
			}),
		);
		expect(result.newFileViolations).toBe(1);
		expect(result.ratchetViolations).toBe(0);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toInclude('ERROR (new file)');
	});

	test('added .test.ts at exactly 500 lines passes (boundary)', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/foo.test.ts'],
				addedFiles: ['tests/foo.test.ts'],
				currentLineCount: () => 500,
			}),
		);
		expect(result.newFileViolations).toBe(0);
		expect(result.exitCode).toBe(0);
	});

	test('added .test.ts at 501 lines fails (one over boundary)', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/foo.test.ts'],
				addedFiles: ['tests/foo.test.ts'],
				currentLineCount: () => 501,
			}),
		);
		expect(result.newFileViolations).toBe(1);
		expect(result.exitCode).toBe(1);
	});

	test('modified over-cap file that grew -> ratchet violation', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/big.test.ts'],
				addedFiles: [],
				currentLineCount: () => 4050,
				baseLineCount: () => 4000,
			}),
		);
		expect(result.ratchetViolations).toBe(1);
		expect(result.newFileViolations).toBe(0);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toInclude('ERROR (ratchet)');
	});

	test('modified over-cap file that shrank -> pass', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/big.test.ts'],
				addedFiles: [],
				currentLineCount: () => 3990,
				baseLineCount: () => 4000,
			}),
		);
		expect(result.ratchetViolations).toBe(0);
		expect(result.exitCode).toBe(0);
	});

	test('modified over-cap file unchanged in size -> pass', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/big.test.ts'],
				addedFiles: [],
				currentLineCount: () => 4000,
				baseLineCount: () => 4000,
			}),
		);
		expect(result.ratchetViolations).toBe(0);
		expect(result.exitCode).toBe(0);
	});

	test('modified over-cap file with baseLineCount 0 -> "new path" counted as new-file violation', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/renamed.test.ts'],
				addedFiles: [],
				currentLineCount: () => 600,
				baseLineCount: () => 0,
			}),
		);
		expect(result.newFileViolations).toBe(1);
		expect(result.ratchetViolations).toBe(0);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toInclude('ERROR (new path)');
	});

	test('currentLineCount returning null (deleted file still listed) is ignored, no crash', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/deleted.test.ts'],
				addedFiles: [],
				currentLineCount: () => null,
				baseLineCount: () => 4000,
			}),
		);
		expect(result.newFileViolations).toBe(0);
		expect(result.ratchetViolations).toBe(0);
		expect(result.exitCode).toBe(0);
	});

	test('enforce:false with a violation soft-warns: exit 0, message includes soft-warn', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/foo.test.ts'],
				addedFiles: ['tests/foo.test.ts'],
				currentLineCount: () => 600,
				enforce: false,
			}),
		);
		expect(result.violations).toBe(1);
		expect(result.exitCode).toBe(0);
		expect(result.messages.join('\n')).toInclude('soft-warn');
	});

	test('empty changedFiles -> exit 0 and "All test-file-cap checks passed."', () => {
		const result = evaluateCap(makeInput({ changedFiles: [] }));
		expect(result.exitCode).toBe(0);
		expect(result.violations).toBe(0);
		expect(result.messages.join('\n')).toInclude(
			'All test-file-cap checks passed.',
		);
	});

	test('a changed file listed twice: summary counters match single-violation message count', () => {
		const result = evaluateCap(
			makeInput({
				changedFiles: ['tests/foo.test.ts', 'tests/foo.test.ts'],
				addedFiles: ['tests/foo.test.ts'],
				currentLineCount: () => 600,
			}),
		);
		// The loop iterates changedFiles verbatim, so a duplicate entry is
		// evaluated twice — the counters must reflect exactly that, proving
		// evaluateCap does not silently dedupe (which would hide a real
		// double-counting bug in either direction).
		expect(result.newFileViolations).toBe(2);
		expect(result.exitCode).toBe(1);
		const errorLines = result.messages.filter((m) =>
			m.startsWith('ERROR (new file)'),
		);
		expect(errorLines.length).toBe(2);
	});
});
