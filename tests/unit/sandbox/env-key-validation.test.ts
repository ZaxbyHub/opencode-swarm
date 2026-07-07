/**
 * Direct unit tests for the isValidEnvKey() helper.
 *
 * This helper is the first line of defense against shell injection via env var keys.
 * It is used by all three platform executors before interpolating keys into
 * platform-specific sandbox syntax (--setenv, SBPL, PowerShell $env:).
 *
 * POSIX env var name规则: [a-zA-Z_][a-zA-Z0-9_]*
 */

import { describe, expect, test } from 'bun:test';
import { isValidEnvKey } from '../../../src/sandbox/executor';

describe('isValidEnvKey', () => {
	// -----------------------------------------------------------------------
	// Valid POSIX names: [a-zA-Z_][a-zA-Z0-9_]*
	// -----------------------------------------------------------------------

	test('returns true for single uppercase letter', () => {
		expect(isValidEnvKey('A')).toBe(true);
	});

	test('returns true for single lowercase letter', () => {
		expect(isValidEnvKey('z')).toBe(true);
	});

	test('returns true for underscore only', () => {
		expect(isValidEnvKey('_')).toBe(true);
	});

	test('returns true for single underscore-prefixed name', () => {
		expect(isValidEnvKey('_FOO')).toBe(true);
	});

	test('returns true for letter followed by digits', () => {
		expect(isValidEnvKey('A1')).toBe(true);
		expect(isValidEnvKey('Z9')).toBe(true);
	});

	test('returns true for underscore followed by digits', () => {
		expect(isValidEnvKey('_1')).toBe(true);
		expect(isValidEnvKey('_A2')).toBe(true);
	});

	test('returns true for multi-character valid name', () => {
		expect(isValidEnvKey('MY_VAR')).toBe(true);
		expect(isValidEnvKey('MY_VAR_2')).toBe(true);
		expect(isValidEnvKey('__ASSERTION_COUNT')).toBe(true);
		expect(isValidEnvKey('_underscore')).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Invalid: digit as first character
	// -----------------------------------------------------------------------

	test('returns false for digit as first character', () => {
		expect(isValidEnvKey('1FOO')).toBe(false);
		expect(isValidEnvKey('0')).toBe(false);
		expect(isValidEnvKey('123')).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Invalid: shell metacharacters in key
	// -----------------------------------------------------------------------

	test('returns false for semicolon (command separator)', () => {
		expect(isValidEnvKey('FOO;BAR')).toBe(false);
	});

	test('returns false for equals sign (assignment operator)', () => {
		expect(isValidEnvKey('FOO=BAR')).toBe(false);
	});

	test('returns false for space character', () => {
		expect(isValidEnvKey('FOO BAR')).toBe(false);
	});

	test('returns false for dollar sign (variable expansion)', () => {
		expect(isValidEnvKey('$FOO')).toBe(false);
		expect(isValidEnvKey('FOO$')).toBe(false);
	});

	test('returns false for ampersand (background/AND)', () => {
		expect(isValidEnvKey('FOO&BAR')).toBe(false);
	});

	test('returns false for pipe (pipeline)', () => {
		expect(isValidEnvKey('FOO|BAR')).toBe(false);
	});

	test('returns false for parentheses (subshell)', () => {
		expect(isValidEnvKey('FOO(BAR)')).toBe(false);
		expect(isValidEnvKey('(FOO)')).toBe(false);
	});

	test('returns false for single quote (shell quoting)', () => {
		expect(isValidEnvKey("FOO'BAR")).toBe(false);
	});

	test('returns false for double quote (shell quoting)', () => {
		expect(isValidEnvKey('FOO"BAR')).toBe(false);
	});

	test('returns false for backtick (command substitution)', () => {
		expect(isValidEnvKey('FOO`BAR')).toBe(false);
	});

	test('returns false for colon (path separator on Unix)', () => {
		expect(isValidEnvKey('FOO:BAR')).toBe(false);
	});

	test('returns false for hyphen/minus (often option prefix)', () => {
		expect(isValidEnvKey('FOO-BAR')).toBe(false);
	});

	test('returns false for period (subdomain/current-dir)', () => {
		expect(isValidEnvKey('FOO.BAR')).toBe(false);
	});

	test('returns false for asterisk (glob/wildcard)', () => {
		expect(isValidEnvKey('FOO*')).toBe(false);
	});

	test('returns false for question mark (glob)', () => {
		expect(isValidEnvKey('FOO?')).toBe(false);
	});

	test('returns false for brackets (glob range)', () => {
		expect(isValidEnvKey('FOO[BAR]')).toBe(false);
	});

	test('returns false for less-than/greater-than (redirect)', () => {
		expect(isValidEnvKey('FOO>BAR')).toBe(false);
		expect(isValidEnvKey('FOO<BAR')).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Invalid: empty and edge cases
	// -----------------------------------------------------------------------

	test('returns false for empty string', () => {
		expect(isValidEnvKey('')).toBe(false);
	});

	test('returns false for just digits', () => {
		expect(isValidEnvKey('0')).toBe(false);
		expect(isValidEnvKey('999')).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Security: injection attempts — key with shell command embedded
	// -----------------------------------------------------------------------

	test('returns false for key containing rm -rf injection', () => {
		// This tests that a key like "FOO;rm -rf /" is rejected
		expect(isValidEnvKey('FOO;rm -rf /')).toBe(false);
	});

	test('returns false for key containing command substitution', () => {
		expect(isValidEnvKey('$(whoami)')).toBe(false);
		expect(isValidEnvKey('`whoami`')).toBe(false);
	});

	test('returns false for key containing newlines', () => {
		expect(isValidEnvKey('FOO\nBAR')).toBe(false);
	});
});
