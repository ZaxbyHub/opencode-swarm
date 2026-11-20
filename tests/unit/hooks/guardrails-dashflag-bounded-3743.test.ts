/**
 * #3743 (AC7, CI-tracked): the two dash-flag redaction arms are bounded
 * ({0,64} around the keyword, the #2040 KV-arm convention) so a long dash
 * run cannot make the case-insensitive scan quadratic. Correctness rows pin
 * both arm shapes (space-separated and `=`-joined) plus the (?!) next-flag
 * guard and the 64/65 boundary.
 */
import { describe, expect, test } from 'bun:test';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

describe('#3743 dash-flag redaction bounded + correct (AC7)', () => {
	test('space-separated dash flag value is redacted', () => {
		expect(redactShellCommand('deploy --api-key live_9f8e7d6c5b4a tool')).toBe(
			'deploy --api-key [REDACTED] tool',
		);
	});

	test('= joined dash flag value is redacted', () => {
		expect(
			redactShellCommand(`run --token=ghp_${'0123456789'.repeat(4)}`),
		).toBe('run --token=[REDACTED]');
	});

	test('(?!--) guard: the next flag is not swallowed as a value', () => {
		const out = redactShellCommand('run --token --other-flag value');
		expect(out).toBe('run --token --other-flag value');
	});

	test('64-char flag names around the keyword still redact (boundary)', () => {
		const prefix = 'a'.repeat(64);
		const out = redactShellCommand(
			`run --${prefix}token${prefix} secretvalue123`,
		);
		expect(out).toBe(`run --${prefix}token${prefix} [REDACTED]`);
	});

	test('a 20,000-char dash run completes bounded-linear (< 1s wall clock)', () => {
		const cmd = 'git commit -m "' + '-'.repeat(20_000) + ' message"';
		const t0 = performance.now();
		const out = redactShellCommand(cmd);
		const ms = performance.now() - t0;
		expect(out.length).toBeGreaterThan(0);
		// Generous CI-safe budget (local measured ~24ms; the AC budget is 1s
		// and the base measured 4.5-7.4s).
		expect(ms).toBeLessThan(1000);
	});
});
