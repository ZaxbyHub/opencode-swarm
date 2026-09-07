/**
 * macOS sandbox-exec envOverride verification tests (issue #2590 contract).
 *
 * Env overrides are applied at the COMMAND level — the inner shell unsets and
 * exports inside the wrapped `bash -c` payload before the user command runs.
 * SBPL has no setenv/unsetenv operations (the profile parser rejects them as
 * unbound variables, exit 65), so the profile itself must stay free of env
 * directives; the emission that used to live in `buildSandboxProfile` made the
 * whole executor silently unavailable on every macOS host (#2590).
 *
 * These tests complement the coverage in macos.test.ts / macos-env-hardening.test.ts:
 * - values containing '=' preserved verbatim
 * - values containing single quotes shell-escaped
 * - invalid keys dropped from the wrapped output
 * - env ops ordered before the user command
 * - no-override payloads carry no env ops
 *
 * Seam-driven (same pattern as macos-env-hardening.test.ts):
 * process.platform is overridden to 'darwin' and _internals.probeSandboxExec is
 * mocked, so the real executor logic is exercised on ANY host — no real
 * sandbox-exec binary required.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	MacOSSandboxExecutor,
} from '../../../src/sandbox/macos/sandbox-exec-executor';

const originalPlatform = process.platform;
const originalProbeSandboxExec = _internals.probeSandboxExec;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
}

beforeEach(() => {
	setPlatform('darwin');
	_internals.probeSandboxExec = mock(() => true);
	_internals.resetProbeMemo();
});

afterEach(() => {
	restorePlatform();
	_internals.probeSandboxExec = originalProbeSandboxExec;
	_internals.resetProbeMemo();
});

describe('MacOSSandboxExecutor — envOverride verification (command-level, #2590)', () => {
	// -----------------------------------------------------------------------
	// Equals sign in value — preserved verbatim by the single-quoted shell form
	// -----------------------------------------------------------------------

	test('value with embedded equals sign is preserved verbatim in the wrapped command', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			FOO: 'a=b=c',
		});
		expect(result).toContain('export FOO=');
		expect(result).toContain('a=b=c');
	});

	test('value that is just an equals sign is preserved verbatim', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			X: '=',
		});
		expect(result).toContain('export X=');
		// The value's surrounding single quotes are escaped for the outer
		// bash -c context ('\'' each), so the assignment reads
		// export X='\''='\'' — the lone = survives verbatim between quotes.
		expect(result).toContain("'='");
	});

	// -----------------------------------------------------------------------
	// Security: key with shell/SBPL metacharacters is rejected
	// -----------------------------------------------------------------------

	test('key with dollar sign (variable injection) is rejected silently', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			$FOO: 'value',
		});
		// $FOO is not a valid env var name — must not appear anywhere in the
		// wrapped command, and the profile must never carry env primitives.
		expect(result).not.toContain('$FOO');
		expect(result).not.toContain('(setenv');
		expect(result).not.toContain('(unsetenv');
	});

	test('key with parens (shell/SBPL syntax injection) is rejected silently', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			'FOO(BAR)': 'value',
		});
		expect(result).not.toContain('FOO(BAR)');
		expect(result).not.toContain('(setenv');
	});

	// -----------------------------------------------------------------------
	// Command-level application correctness
	// -----------------------------------------------------------------------

	test('env ops precede the user command in the wrapped payload', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			INJECT_ME: 'injected_value',
		});
		const exportIdx = result.indexOf('export INJECT_ME=');
		const cmdIdx = result.indexOf('echo hello');
		expect(exportIdx).toBeGreaterThanOrEqual(0);
		expect(cmdIdx).toBeGreaterThan(exportIdx);
		expect(result).toContain('injected_value');
	});

	test('null value unsets the key before the user command', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			REMOVE_ME: null,
		});
		const unsetIdx = result.indexOf('unset REMOVE_ME');
		const cmdIdx = result.indexOf('echo hello');
		expect(unsetIdx).toBeGreaterThanOrEqual(0);
		expect(cmdIdx).toBeGreaterThan(unsetIdx);
	});

	test('value containing a single quote is shell-escaped (payload stays parseable)', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			SET_ME: "it's a = test",
		});
		// shellEscape turns the apostrophe into '\'' so the outer
		// single-quoted bash -c payload still parses; the value characters
		// survive verbatim around the escape.
		expect(result).toContain('export SET_ME=');
		expect(result).toContain('a = test');
		// The raw unescaped apostrophe must never terminate the outer quoting:
		// every single quote after SET_ME= must be part of an escape sequence.
		const after = result.slice(result.indexOf('export SET_ME='));
		expect(after).toContain("'\\''");
	});

	test('mixed valid and invalid keys: valid keys applied, invalid silently dropped', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, {
			VALID_KEY: 'valid_value',
			'INVALID;KEY': 'should_be_dropped',
			ANOTHER_VALID: 'another_value',
		});
		expect(result).toContain('export VALID_KEY=');
		expect(result).toContain('valid_value');
		expect(result).toContain('export ANOTHER_VALID=');
		expect(result).toContain('another_value');
		expect(result).not.toContain('INVALID');
		expect(result).not.toContain('should_be_dropped');
	});

	test('no-override wrap output carries no env ops and no profile env directives', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const result = executor.wrapCommand('echo hello', [], undefined, undefined);
		expect(result).not.toContain('unset ');
		expect(result).not.toContain('export ');
		expect(result).toContain('sandbox-exec');
	});
});
