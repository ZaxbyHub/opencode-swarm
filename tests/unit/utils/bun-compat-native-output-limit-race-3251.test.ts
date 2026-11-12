// #3251 — frozen acceptance spec (v2 oracle, plan-critic rounds 1-2).
//
// This spec drives the SHARED probe helper
// (tests/helpers/native-output-limit-probe-3251.ts) that the 2530 suite also
// uses after the fix — it is NOT a duplicated probe, so it cannot pass while
// the production-used probe stays wrong (round-1 challenge 1).
//
// The helper's contract (pinned here):
// - receipt { terminationObserved, terminationObservedLate, attempts, exitCode,
//   signalCode, stdout, stderr };
// - bounded re-observation: on clean exit-0 with no signal it re-spawns, at
//   most 3 attempts total, 20 ms setTimeout backoff, no wall-clock reads;
// - kill-origin discriminator (round-1 challenge 2): a 1000 ms observation
//   deadline armed at spawn, strictly shorter than the 10 000 ms spawn
//   backstop; termination observed only after the deadline reports
//   terminationObservedLate: true (a FAILING receipt — the timeout path can
//   never satisfy the window, so a pass proves the overflow controller killed);
// - per-attempt outputs drained; best-effort kill in finally (invariant 3).
//
// Deterministic seam legs exercise the retry logic with injected per-attempt
// receipts (no real children): clean-0 → killed must report attempts === 2 and
// terminationObserved; clean-0 ×3 must report attempts === 3 and honest
// non-termination. Real-child legs pin the race classes on this host.
import { describe, expect, test } from 'bun:test';
import {
	nativeOutputLimitProbe,
	type ProbeAttempt,
	type ProbeReceipt,
} from '../../helpers/native-output-limit-probe-3251.js';

const LARGE_OUTPUT_BYTES = 128 * 1024;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

describe('bunSpawn native output-limit termination race (#3251 frozen acceptance spec, v2)', () => {
	test('deterministic seam: clean-exit-0 then killed re-observes exactly once', async () => {
		const attempts: ProbeAttempt[] = [];
		const injected = async () => {
			if (attempts.length === 0) {
				attempts.push({
					exitCode: 0,
					signalCode: null,
					laterThanDeadline: false,
				});
				return attempts[0];
			}
			const killed = {
				exitCode: null,
				signalCode: 'SIGKILL' as const,
				laterThanDeadline: false,
			};
			attempts.push(killed);
			return killed;
		};
		const receipt = (await nativeOutputLimitProbe({
			spawnAttempt: injected,
		})) as ProbeReceipt;
		expect(attempts).toHaveLength(2);
		expect(receipt.attempts).toBe(2);
		expect(receipt.terminationObserved).toBe(true);
		expect(receipt.terminationObservedLate).toBe(false);
	});

	test('deterministic seam: three clean-exit-0 attempts report honest non-termination', async () => {
		let calls = 0;
		const injected = async () => {
			calls += 1;
			return { exitCode: 0, signalCode: null, laterThanDeadline: false };
		};
		const receipt = (await nativeOutputLimitProbe({
			spawnAttempt: injected,
		})) as ProbeReceipt;
		expect(calls).toBe(3);
		expect(receipt.attempts).toBe(3);
		expect(receipt.terminationObserved).toBe(false);
		expect(receipt.terminationObservedLate).toBe(false);
	});

	test('deterministic seam: termination only after the observation deadline is late (failing)', async () => {
		const injected = async () => ({
			exitCode: null,
			signalCode: 'SIGKILL' as const,
			laterThanDeadline: true,
		});
		const receipt = (await nativeOutputLimitProbe({
			spawnAttempt: injected,
		})) as ProbeReceipt;
		expect(receipt.attempts).toBe(1);
		expect(receipt.terminationObserved).toBe(true);
		expect(receipt.terminationObservedLate).toBe(true);
	});

	test('injected early-exit-0 overflow child is honestly reported as not terminated', async () => {
		// Real child: oversized payload to stdout ONLY, immediate exit.
		const receipt = (await nativeOutputLimitProbe({
			childEval: `const p = 'O'.repeat(${LARGE_OUTPUT_BYTES * 2}); process.stdout.write(p);`,
		})) as ProbeReceipt;
		expect(receipt.attempts).toBeGreaterThanOrEqual(1);
		expect(receipt.attempts).toBeLessThanOrEqual(3);
		if (receipt.terminationObserved === false) {
			expect(receipt.attempts).toBe(3);
		} else {
			expect(receipt.attempts).toBeLessThanOrEqual(3);
			expect(receipt.terminationObservedLate).toBe(false);
		}
		const errors = [receipt.stdout, receipt.stderr].filter((item) => !item.ok);
		expect(errors.length).toBeGreaterThan(0);
		for (const error of errors) {
			expect(error).toMatchObject({
				name: 'BunCompatOutputLimitError',
				instanceOf: true,
				limit: OUTPUT_LIMIT_BYTES,
			});
			expect(error.captured).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
			expect(error.total).toBeGreaterThan(OUTPUT_LIMIT_BYTES);
		}
	});

	test('hold-open overflow child yields deterministic termination evidence', async () => {
		const receipt = (await nativeOutputLimitProbe({
			childEval: `const p = 'O'.repeat(${LARGE_OUTPUT_BYTES * 2}); process.stdout.write(p); process.stderr.write(p); setInterval(() => {}, 1000);`,
		})) as ProbeReceipt;
		expect(receipt.terminationObserved).toBe(true);
		expect(receipt.terminationObservedLate).toBe(false);
		expect(receipt.attempts).toBe(1);
	});
});
