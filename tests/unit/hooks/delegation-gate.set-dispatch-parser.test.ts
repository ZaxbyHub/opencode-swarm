/** Structured per-task reviewer and test-engineer verdict parsing. */

import { describe, expect, it } from 'bun:test';
import { _internals } from '../../../src/hooks/delegation-gate';

const { parsePerTaskVerdicts } = _internals;

describe('parsePerTaskVerdicts', () => {
	it('SC-024.1: parses [REVIEWED] verdict line with task- prefix', () => {
		const { verdicts } = parsePerTaskVerdicts(`
Some review content here.

[REVIEWED] | task-2.1 | APPROVED | No issues found in src/foo.ts
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.1')?.kind).toBe('REVIEWED');
	});

	it('SC-024.2: parses [REVIEWED] verdict line with bare task ID', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | 2.2 | REJECTED | Missing null check at line 42
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.2')?.verdict).toBe('REJECTED');
		expect(verdicts.get('2.2')?.kind).toBe('REVIEWED');
	});

	it('SC-024.3: parses multiple [REVIEWED] verdict lines from single output', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | task-2.1 | APPROVED | No issues found
[REVIEWED] | task-2.2 | APPROVED | Minor suggestion only
[REVIEWED] | task-2.3 | REJECTED | Critical bug at line 88
`);
		expect(verdicts.size).toBe(3);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.2')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.3')?.verdict).toBe('REJECTED');
	});

	it('SC-024.4: parses [TESTED] verdict lines', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[TESTED] | task-2.1 | PASS | 10/10 tests passed
[TESTED] | task-2.2 | FAIL | 8/10 tests passed — bar.test.ts missing error path
`);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')?.verdict).toBe('PASS');
		expect(verdicts.get('2.1')?.kind).toBe('TESTED');
		expect(verdicts.get('2.2')?.verdict).toBe('FAIL');
		expect(verdicts.get('2.2')?.kind).toBe('TESTED');
	});

	it('SC-024.5: parses [TESTED] with SKIPPED verdict', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[TESTED] | task-3.1 | SKIPPED | Test file does not exist
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('3.1')?.verdict).toBe('SKIPPED');
		expect(verdicts.get('3.1')?.kind).toBe('TESTED');
	});

	it('SC-024.6: ignores lines that do not match verdict pattern', () => {
		const { verdicts } = parsePerTaskVerdicts(`
This is just some review text.
VERDICT: APPROVED
TASK: 2.1
But no structured verdict line here.
[REVIEWED] | task-2.1 | APPROVED | This is valid
Random line without format.
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
	});

	it('SC-024.7: ignores invalid task ID formats', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | task-invalid | APPROVED | Should be ignored
[REVIEWED] | task-2 | APPROVED | Should be ignored (missing patch number)
[REVIEWED] | task-2.1.3.4.5 | APPROVED | Valid (deeper nesting)
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.has('invalid')).toBe(false);
		expect(verdicts.has('2')).toBe(false);
		expect(verdicts.get('2.1.3.4.5')?.verdict).toBe('APPROVED');
	});

	it('SC-024.8: handles empty output gracefully', () => {
		const { verdicts, errors } = parsePerTaskVerdicts('');
		expect(verdicts.size).toBe(0);
		expect(errors.length).toBe(0);
	});

	it('SC-024.9: handles output with no verdict lines', () => {
		const { verdicts } = parsePerTaskVerdicts(
			'Just some regular output without any verdict markers.',
		);
		expect(verdicts.size).toBe(0);
	});

	it('SC-024.10: case-insensitive tag matching', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[reviewed] | task-2.1 | APPROVED | lowercase tag
[Reviewed] | task-2.2 | APPROVED | Mixed case tag
[TESTED] | task-2.3 | PASS | Uppercase tag
[tested] | task-2.4 | PASS | Lowercase tag
`);
		expect(verdicts.size).toBe(4);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.2')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.3')?.verdict).toBe('PASS');
		expect(verdicts.get('2.4')?.verdict).toBe('PASS');
	});

	it('SC-022.4: mixed REVIEWED and TESTED for same taskId produces conflict error', () => {
		const { verdicts, errors } = parsePerTaskVerdicts(`
[REVIEWED] | task-10.1.2 | APPROVED | Valid
[TESTED] | task-10.1.2 | PASS | All tests pass
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('10.1.2')?.verdict).toBe('APPROVED');
		expect(verdicts.get('10.1.2')?.kind).toBe('REVIEWED');
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('STAGE_B_VERDICT_CONFLICT');
		expect(errors[0]).toContain('10.1.2');
	});

	it('SC-024.11: optional trailing pipe — verdict without trailing details', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | task-2.1 | APPROVED
[TESTED] | task-2.2 | PASS
`);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.2')?.verdict).toBe('PASS');
	});

	it('SC-024.12: optional trailing pipe — mixed with and without details', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | task-2.1 | APPROVED | Full details here
[REVIEWED] | task-2.2 | REJECTED
`);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.2')?.verdict).toBe('REJECTED');
	});

	it('SC-024.13: CRLF line endings are handled', () => {
		const { verdicts } = parsePerTaskVerdicts(
			'[REVIEWED] | task-2.1 | APPROVED | ok\r\n[TESTED] | task-2.2 | PASS | ok\r\n',
		);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.2')?.verdict).toBe('PASS');
	});

	it('SC-024.14: mixed LF and CRLF in same output', () => {
		const { verdicts } = parsePerTaskVerdicts(
			'[REVIEWED] | task-2.1 | APPROVED\r\nSome text\n[TESTED] | task-2.2 | PASS\n',
		);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(verdicts.get('2.2')?.verdict).toBe('PASS');
	});

	it('SC-024.15: identical duplicate verdicts are idempotent (no error)', () => {
		const { verdicts, errors } = parsePerTaskVerdicts(`
[REVIEWED] | task-2.1 | APPROVED | First mention
[REVIEWED] | task-2.1 | APPROVED | Second mention
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(errors.length).toBe(0);
	});

	it('SC-024.16: conflicting verdict values produce VERDICT_CONFLICT error', () => {
		const { verdicts, errors } = parsePerTaskVerdicts(`
[REVIEWED] | task-2.1 | APPROVED | First
[REVIEWED] | task-2.1 | REJECTED | Second
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('STAGE_B_VERDICT_CONFLICT');
		expect(errors[0]).toContain('2.1');
		expect(errors[0]).toContain('REVIEWED/APPROVED');
		expect(errors[0]).toContain('REVIEWED/REJECTED');
	});

	it('SC-024.17: CONCERNS verdict is parsed for REVIEWED', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | task-4.1 | CONCERNS | Minor issues noted
`);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('4.1')?.verdict).toBe('CONCERNS');
		expect(verdicts.get('4.1')?.kind).toBe('REVIEWED');
	});

	it('SC-024.18: verdict kind is correctly tracked for all entries', () => {
		const { verdicts } = parsePerTaskVerdicts(`
[REVIEWED] | task-1.1 | APPROVED | ok
[TESTED] | task-1.2 | PASS | ok
[REVIEWED] | task-1.3 | REJECTED | bad
[TESTED] | task-1.4 | FAIL | broken
`);
		expect(verdicts.get('1.1')?.kind).toBe('REVIEWED');
		expect(verdicts.get('1.2')?.kind).toBe('TESTED');
		expect(verdicts.get('1.3')?.kind).toBe('REVIEWED');
		expect(verdicts.get('1.4')?.kind).toBe('TESTED');
	});

	it('SC-024.19: trailing whitespace after optional pipe does not break parsing', () => {
		const { verdicts } = parsePerTaskVerdicts(
			'[REVIEWED] | task-2.1 | APPROVED |   \n',
		);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')?.verdict).toBe('APPROVED');
	});

	it('SC-024.20: errors array is empty when no conflicts exist', () => {
		const { errors } = parsePerTaskVerdicts(`
[REVIEWED] | task-1.1 | APPROVED | ok
[TESTED] | task-1.2 | PASS | ok
`);
		expect(errors).toEqual([]);
	});
});
