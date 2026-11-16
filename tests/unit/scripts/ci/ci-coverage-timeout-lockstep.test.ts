/**
 * #3263 lockstep pin: the receipt-footer aggregate-bounds test carries an
 * EXPLICIT per-test timeout that overrides the coverage gate's CLI
 * `--timeout` budget (scripts/ci/run-coverage-gate.sh). While the two values
 * differed (30 s cap vs 60 s gate budget), the per-test value silently won
 * and the marginal corpus hard-failed coverage shards nine times in Oct 2026.
 * These tests fail CI if either side is removed or the literals diverge,
 * keeping the raise honest without a hand-maintained comment.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');

const GATE_PATH = join('scripts', 'ci', 'run-coverage-gate.sh');
const FOOTER_TEST_PATH = join(
	'tests',
	'unit',
	'tools',
	'dispatch-lanes-pr-review-receipt-footer.test.ts',
);

function read(relative: string): string {
	return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

function gatePerTestTimeout(): number | null {
	const match = read(GATE_PATH).match(
		/bun test[^\n]*--timeout (\d+) "\$test_file"/,
	);
	return match ? Number(match[1]) : null;
}

function footerPerTestTimeouts(): number[] {
	return [...read(FOOTER_TEST_PATH).matchAll(/\}, (\d+)_000\);/g)].map(
		(match) => Number(match[1]) * 1000,
	);
}

describe('coverage timeout lockstep (#3263)', () => {
	test('the coverage gate runs each file with an explicit per-test budget', () => {
		expect(gatePerTestTimeout()).toBe(60_000);
	});

	test('the receipt-footer explicit caps equal the coverage gate budget', () => {
		const gateTimeout = gatePerTestTimeout();
		expect(gateTimeout).not.toBeNull();
		const caps = footerPerTestTimeouts();
		// The heavy aggregate-bounds test must carry an explicit per-test cap...
		expect(caps.length).toBeGreaterThan(0);
		// ...and that cap must match the gate budget, so neither side can drift
		// back to a silent override (the nine-detection failure mode).
		for (const cap of caps) {
			expect(cap).toBe(gateTimeout);
		}
	});
});
