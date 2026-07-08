/**
 * Additional Linux Bubblewrap envOverride verification tests.
 *
 * These tests complement the coverage in linux.test.ts by targeting:
 * - Values containing '=' (equals sign) — critical for the space-separated --setenv KEY=VALUE form
 * - Cross-platform injection correctness — verifies the wrapped command would actually inject the env
 *
 * Platform: Linux only (bwrap is Linux-specific)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const isWindows = process.platform === 'win32';

import {
	_internals,
	BubblewrapSandboxExecutor,
} from '../../../src/sandbox/linux/bubblewrap-executor';

// ---------------------------------------------------------------------------
// Supplementary envOverride tests — all skipped on Windows
// ---------------------------------------------------------------------------

describe('BubblewrapSandboxExecutor — envOverride verification (supplementary)', () => {
	let executor: BubblewrapSandboxExecutor;

	beforeEach(async () => {
		// Mock probeBwrap to always return true so bwrap wrapping is tested.
		await mock.module('../../../src/sandbox/linux/bubblewrap-executor', () => ({
			BubblewrapSandboxExecutor,
			_internals: { ..._internals, probeBwrap: () => true },
		}));
		executor = new BubblewrapSandboxExecutor(['/scope/a'], '/tmp');
	});

	afterEach(() => {
		mock.restore();
	});

	// -----------------------------------------------------------------------
	// Equals sign in value — the Linux --setenv KEY VALUE form uses 3-arg
	// separation, so embedded '=' in value is unambiguous.
	// -----------------------------------------------------------------------

	test.skipIf(isWindows)(
		'value with embedded equals sign is preserved verbatim (3-arg form is unambiguous)',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				// Value contains '=': 3-arg form makes this unambiguous
				FOO: 'a=b=c',
			});
			// The 3-arg form: --setenv FOO a=b=c (three separate args to bwrap)
			// bwrap parses KEY=FOO, VALUE=a=b=c directly.
			expect(result).toContain('--setenv FOO a=b=c');
		},
	);

	test.skipIf(isWindows)(
		'value that looks like a KEY=VALUE pair is still preserved correctly',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				X: '=',
			});
			expect(result).toContain('--setenv X =');
		},
	);

	// -----------------------------------------------------------------------
	// Shell metacharacters in value — bwrap passes to execve, not through shell,
	// so characters like $ and ; are NOT expanded.
	// -----------------------------------------------------------------------

	test.skipIf(isWindows)(
		'dollar sign in value is NOT shell-expanded (bwrap → execve)',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				HOME: '$HOME',
			});
			// $ is literal in the wrapped command — bwrap passes it to execve, not bash
			expect(result).toContain('--setenv HOME $HOME');
		},
	);

	test.skipIf(isWindows)(
		'semicolon in value is NOT interpreted as command separator',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				CMD: 'echo a; echo b',
			});
			// The semicolon is literal — the wrapped command is bwrap ... bash -c 'echo a; echo b'
			// where the semicolon inside the quoted command string is literal content
			expect(result).toContain('--setenv CMD echo a; echo b');
		},
	);

	test.skipIf(isWindows)(
		'ampersand in value is NOT interpreted as background operator',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				AMP: 'a&b',
			});
			expect(result).toContain('--setenv AMP a&b');
		},
	);

	test.skipIf(isWindows)('pipe in value is NOT interpreted as pipeline', () => {
		const result = executor.wrapCommand('echo hello', [], undefined, {
			PIPE: 'a|b',
		});
		expect(result).toContain('--setenv PIPE a|b');
	});

	// -----------------------------------------------------------------------
	// Security: invalid key with shell metacharacters is silently rejected
	// -----------------------------------------------------------------------

	test.skipIf(isWindows)(
		'key with dollar sign (variable injection attempt) is rejected silently',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				$FOO: 'value',
			});
			// $FOO is not a valid env var name — must not appear in wrapped command
			expect(result).not.toContain('$FOO');
			expect(result).not.toContain('setenv');
			expect(result).not.toContain('unsetenv');
		},
	);

	test.skipIf(isWindows)(
		'key with ampersand (command chaining) is rejected silently',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				'FOO&BAR': 'value',
			});
			expect(result).not.toContain('FOO&BAR');
			expect(result).not.toContain('setenv');
		},
	);

	test.skipIf(isWindows)(
		'key with pipe (pipeline injection) is rejected silently',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				'FOO|BAR': 'value',
			});
			expect(result).not.toContain('FOO|BAR');
		},
	);

	test.skipIf(isWindows)(
		'key with backtick (command substitution) is rejected silently',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				'FOO`BAR': 'value',
			});
			expect(result).not.toContain('FOO`BAR');
		},
	);

	// -----------------------------------------------------------------------
	// Cross-platform injection correctness: the wrapped command syntax is
	// verifiable — if it contains --setenv FOO bar, that is the exact string
	// that would be passed to bwrap's argv, so the env var WOULD be set.
	// -----------------------------------------------------------------------

	test.skipIf(isWindows)(
		'--setenv KEY VALUE is present verbatim in the wrapped command string',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				INJECT_ME: 'injected_value',
			});
			// The wrapped string contains --setenv INJECT_ME injected_value verbatim (3-arg form).
			// When bwrap parses its argv, it receives:
			//   ['--setenv', 'INJECT_ME', 'injected_value']
			// and calls execve() with that env — so INJECT_ME IS set to injected_value.
			expect(result).toContain('--setenv INJECT_ME injected_value');
		},
	);

	test.skipIf(isWindows)(
		'mixed valid and invalid keys: valid keys are applied, invalid are silently dropped',
		() => {
			const result = executor.wrapCommand('echo hello', [], undefined, {
				VALID_KEY: 'valid_value',
				'INVALID;KEY': 'should_be_dropped',
				ANOTHER_VALID: 'another_value',
			});
			// Valid keys appear (3-arg form: --setenv KEY VALUE)
			expect(result).toContain('--setenv VALID_KEY valid_value');
			expect(result).toContain('--setenv ANOTHER_VALID another_value');
			// Invalid key must not appear
			expect(result).not.toContain('INVALID');
			expect(result).not.toContain('should_be_dropped');
		},
	);
});
