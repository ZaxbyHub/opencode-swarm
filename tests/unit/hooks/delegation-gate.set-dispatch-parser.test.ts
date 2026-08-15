/** Structured per-task reviewer and test-engineer verdict parsing. */

import { describe, expect, it } from 'bun:test';
import { _internals } from '../../../src/hooks/delegation-gate';

const { parsePerTaskVerdicts } = _internals;

describe('parsePerTaskVerdicts', () => {
	it('SC-024.1: parses [REVIEWED] verdict line with task- prefix', () => {
		const verdicts = parsePerTaskVerdicts(`
Some review content here.

[REVIEWED] | task-2.1 | APPROVED | No issues found in src/foo.ts
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')).toBe('APPROVED');
	});

	it('SC-024.2: parses [REVIEWED] verdict line with bare task ID', () => {
		const verdicts = parsePerTaskVerdicts(`
[REVIEWED] | 2.2 | REJECTED | Missing null check at line 42
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.2')).toBe('REJECTED');
	});

	it('SC-024.3: parses multiple [REVIEWED] verdict lines from single output', () => {
		const verdicts = parsePerTaskVerdicts(`
[REVIEWED] | task-2.1 | APPROVED | No issues found
[REVIEWED] | task-2.2 | APPROVED | Minor suggestion only
[REVIEWED] | task-2.3 | REJECTED | Critical bug at line 88
`);
		expect(verdicts.size).toBe(3);
		expect(verdicts.get('2.1')).toBe('APPROVED');
		expect(verdicts.get('2.2')).toBe('APPROVED');
		expect(verdicts.get('2.3')).toBe('REJECTED');
	});

	it('SC-024.4: parses [TESTED] verdict lines', () => {
		const verdicts = parsePerTaskVerdicts(`
[TESTED] | task-2.1 | PASS | 10/10 tests passed
[TESTED] | task-2.2 | FAIL | 8/10 tests passed — bar.test.ts missing error path
`);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')).toBe('PASS');
		expect(verdicts.get('2.2')).toBe('FAIL');
	});

	it('SC-024.5: parses [TESTED] with SKIPPED verdict', () => {
		const verdicts = parsePerTaskVerdicts(`
[TESTED] | task-3.1 | SKIPPED | Test file does not exist
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('3.1')).toBe('SKIPPED');
	});

	it('SC-024.6: ignores lines that do not match verdict pattern', () => {
		const verdicts = parsePerTaskVerdicts(`
This is just some review text.
VERDICT: APPROVED
TASK: 2.1
But no structured verdict line here.
[REVIEWED] | task-2.1 | APPROVED | This is valid
Random line without format.
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')).toBe('APPROVED');
	});

	it('SC-024.7: ignores invalid task ID formats', () => {
		const verdicts = parsePerTaskVerdicts(`
[REVIEWED] | task-invalid | APPROVED | Should be ignored
[REVIEWED] | task-2 | APPROVED | Should be ignored (missing patch number)
[REVIEWED] | task-2.1.3.4.5 | APPROVED | Valid (deeper nesting)
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.has('invalid')).toBe(false);
		expect(verdicts.has('2')).toBe(false);
		expect(verdicts.get('2.1.3.4.5')).toBe('APPROVED');
	});

	it('SC-024.8: handles empty output gracefully', () => {
		expect(parsePerTaskVerdicts('').size).toBe(0);
	});

	it('SC-024.9: handles output with no verdict lines', () => {
		expect(
			parsePerTaskVerdicts(
				'Just some regular output without any verdict markers.',
			).size,
		).toBe(0);
	});

	it('SC-024.10: case-insensitive tag matching', () => {
		const verdicts = parsePerTaskVerdicts(`
[reviewed] | task-2.1 | APPROVED | lowercase tag
[Reviewed] | task-2.2 | APPROVED | Mixed case tag
[TESTED] | task-2.3 | PASS | Uppercase tag
[tested] | task-2.4 | PASS | Lowercase tag
`);
		expect(verdicts.size).toBe(4);
		expect(verdicts.get('2.1')).toBe('APPROVED');
		expect(verdicts.get('2.2')).toBe('APPROVED');
		expect(verdicts.get('2.3')).toBe('PASS');
		expect(verdicts.get('2.4')).toBe('PASS');
	});

	it('SC-022.4: complex three-digit task IDs are parsed correctly', () => {
		const verdicts = parsePerTaskVerdicts(`
[REVIEWED] | task-10.1.2 | APPROVED | Valid
[TESTED] | task-10.1.2 | PASS | All tests pass
`);
		expect(verdicts.get('10.1.2')).toBe('PASS');
	});
});
