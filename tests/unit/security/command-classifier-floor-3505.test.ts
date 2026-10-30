/**
 * Preserving floor for the `windows-recursive-delete` classifier rule
 * (issue #3505, AC4): every true cmd.exe switch spelling keeps a destructive
 * segment with that ruleId. Green at base and required to stay green after
 * the token-aware rewrite of the rule.
 *
 * Grammar rows at the end are destructive at BOTH base and head: a glued
 * switch token (`rd zzz/s` — the operand starts with the `/s` switch) is a
 * tree delete in cmd, and single quotes are not quotes for cmd.exe, so
 * `rd 'zzz/s'` still carries the switch. Quoted-"/s" rows are deliberately
 * absent from this floor — they intentionally flip per the widening
 * disclosed in #3505's Out-of-scope note (pinned in
 * command-classifier.test.ts instead).
 */

import { describe, expect, test } from 'bun:test';
import { classifyCommand } from '../../../src/security/command-classifier.js';

describe('windows-recursive-delete true-positive floor (#3505 AC4)', () => {
	test.each([
		'rmdir /s build',
		'rmdir /S build',
		'rmdir /s /q build',
		'rmdir /s/q build',
		'rmdir /sq build',
		'rmdir /qs build',
		'rd.exe /s dir',
		'rmdir /q x',
		'rd zzz/s',
		"rd 'zzz/s'",
	])('%s stays destructive via windows-recursive-delete', (command) => {
		const result = classifyCommand(command);
		expect(result.aggregate).toBe('destructive');
		expect(
			result.segments.some(
				(entry) =>
					entry.category === 'destructive' &&
					entry.ruleId === 'windows-recursive-delete',
			),
		).toBe(true);
	});
});

describe('multiline boundary: the rule never scans past a line break (plan-critic R2-3)', () => {
	test("rmdir on one line does not inherit a later line's /s token", () => {
		const result = classifyCommand('rmdir harmless\n/s');
		expect(
			result.segments.some((s) => s.ruleId === 'windows-recursive-delete'),
		).toBe(false);
	});

	test('own-verb control: rd /s on the second line still fires', () => {
		const result = classifyCommand('rmdir harmless\nrd /s dir');
		expect(
			result.segments.some((s) => s.ruleId === 'windows-recursive-delete'),
		).toBe(true);
	});
});
