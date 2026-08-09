import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	DEFAULT_TOTAL_WAKE_CEILINGS,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-ceiling-validation-');
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Drive wakes on a tier-S session until suspended, or up to `maxWakes`
 * (whichever first), asserting revision advances every time so only the
 * total-wake ceiling (never the consecutive-unproductive one) can trip.
 * Returns the number of wakes actually driven and the final budget.
 */
async function driveUntilSuspendedOrMax(
	gate: ReturnType<typeof createPrWorkflowResponseGate>,
	sessionID: string,
	tier: 'S' | 'M' | 'L',
	maxWakes: number,
): Promise<{ wakes: number; suspended: boolean }> {
	const idle = idleEventFor(sessionID);
	for (let i = 0; i < maxWakes; i++) {
		await writeStateWithRevision(directory, sessionID, i + 1, tier);
		await gate.event(idle);
		const budget = gate._inspectWakeBudget(sessionID);
		if (budget?.suspended) return { wakes: i + 1, suspended: true };
	}
	return { wakes: maxWakes, suspended: false };
}

/**
 * Regression: F-008. A caller-supplied `totalWakeCeiling` that is not a
 * finite positive integer silently disables or inverts the brake:
 * `Infinity`/`NaN` make the ceiling comparison never true (brake never
 * fires — an unbounded loop), and `0`/negative values make it true on the
 * very first wake (a session suspends before doing any work). The fix
 * validates every resolved value (both the uniform-scalar shape and each
 * per-tier record value) and falls back to `DEFAULT_TOTAL_WAKE_CEILINGS` for
 * that specific value when invalid.
 */
describe('resolveTotalWakeCeiling — regression: invalid totalWakeCeiling falls back to the tier default (F-008)', () => {
	const invalidValues: Array<[string, number]> = [
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
		['NaN', Number.NaN],
		['0', 0],
		['negative integer', -5],
		['non-integer', 3.5],
	];

	for (const [label, value] of invalidValues) {
		test(`scalar totalWakeCeiling=${label} falls back to the tier-S default (12)`, async () => {
			const promptAsync = mock(async () => ({}));
			const gate = createPrWorkflowResponseGate({
				directory,
				client: { session: { prompt: promptAsync, promptAsync } },
				maxConsecutiveUnproductiveWakes: 999_999,
				wakeCooldownMs: 0,
				totalWakeCeiling: value,
			});

			// A non-fallback (invalid) ceiling would never suspend
			// (Infinity/NaN) or suspend instantly (0/negative). The default
			// tier-S ceiling is 12: drive exactly 12 wakes and require
			// suspension at wake 12 (not before, not never).
			const result = await driveUntilSuspendedOrMax(
				gate,
				`scalar-${label.replace(/[^a-z0-9]/gi, '')}`,
				'S',
				DEFAULT_TOTAL_WAKE_CEILINGS.S,
			);
			expect(result.suspended).toBe(true);
			expect(result.wakes).toBe(DEFAULT_TOTAL_WAKE_CEILINGS.S);
		});

		test(`per-tier totalWakeCeiling.S=${label} falls back to the tier-S default (12)`, async () => {
			const promptAsync = mock(async () => ({}));
			const gate = createPrWorkflowResponseGate({
				directory,
				client: { session: { prompt: promptAsync, promptAsync } },
				maxConsecutiveUnproductiveWakes: 999_999,
				wakeCooldownMs: 0,
				totalWakeCeiling: { S: value },
			});

			const result = await driveUntilSuspendedOrMax(
				gate,
				`per-tier-${label.replace(/[^a-z0-9]/gi, '')}`,
				'S',
				DEFAULT_TOTAL_WAKE_CEILINGS.S,
			);
			expect(result.suspended).toBe(true);
			expect(result.wakes).toBe(DEFAULT_TOTAL_WAKE_CEILINGS.S);
		});
	}

	test('a per-tier record with ONE invalid tier still honours the other VALID tiers (fallback is per-value, not whole-record)', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999_999,
			wakeCooldownMs: 0,
			// S is invalid (must fall back to default 12); M is a valid,
			// deliberately non-default override (7) that must be HONOURED —
			// proving one bad tier entry does not disable validation for the
			// rest of the record.
			totalWakeCeiling: { S: 0, M: 7 },
		});

		const sResult = await driveUntilSuspendedOrMax(
			gate,
			'mixed-tier-s',
			'S',
			DEFAULT_TOTAL_WAKE_CEILINGS.S,
		);
		expect(sResult.suspended).toBe(true);
		expect(sResult.wakes).toBe(DEFAULT_TOTAL_WAKE_CEILINGS.S);

		const mResult = await driveUntilSuspendedOrMax(
			gate,
			'mixed-tier-m',
			'M',
			20,
		);
		expect(mResult.suspended).toBe(true);
		expect(mResult.wakes).toBe(7);
	});

	test('positive regression: a valid scalar override IS honoured (not silently replaced by the default)', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999_999,
			wakeCooldownMs: 0,
			totalWakeCeiling: 4, // valid, and deliberately different from every default
		});

		const result = await driveUntilSuspendedOrMax(
			gate,
			'valid-override',
			'L',
			20,
		);
		expect(result.suspended).toBe(true);
		expect(result.wakes).toBe(4);
	});
});
