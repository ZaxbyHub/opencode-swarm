import { describe, expect, test } from 'bun:test';
import type { Evidence } from '../../../src/config/evidence-schema';
import { mergeDurableGateEntriesFromEvidence } from '../../../src/evidence/gate-bridge';

/**
 * Issue #3560 AC7: the evidence-summary bridge must not flatten a durable
 * REJECT to `verdict: 'pass'` — it shares the gate-outcome derivation with
 * the receipt task arm so both surfaces agree.
 */

const STAMP = '2026-11-02T00:00:00.000Z';

function bridgeVerdicts(gates: Record<string, unknown>): Evidence[] {
	return mergeDurableGateEntriesFromEvidence('4.1', [], {
		taskId: '4.1',
		required_gates: [],
		gates,
	} as never);
}

describe('gate-bridge durable verdict fidelity (#3560)', () => {
	test('bridge preserves durable verdict: council REJECT is fail, never pass', () => {
		const entries = bridgeVerdicts({
			council: {
				sessionId: 'swarm-council',
				timestamp: STAMP,
				agent: 'council',
				verdict: 'REJECT',
				vetoedBy: ['critic'],
			},
		});
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.verdict).toBe('fail');
			expect(entry.summary).toContain('derived from durable record: fail');
		}
	});

	test('bridge preserves durable verdict for advisory CONCERNS (warn) and APPROVE (pass)', () => {
		const concerns = bridgeVerdicts({
			council: {
				sessionId: 'swarm-council',
				timestamp: STAMP,
				agent: 'council',
				verdict: 'CONCERNS',
			},
		});
		expect(concerns.every((entry) => entry.verdict === 'warn')).toBe(true);
		const approve = bridgeVerdicts({
			council: {
				sessionId: 'swarm-council',
				timestamp: STAMP,
				agent: 'council',
				verdict: 'APPROVE',
			},
		});
		expect(approve.every((entry) => entry.verdict === 'pass')).toBe(true);
	});

	test('bridge preserves presence-only records as pass (producer-contract honesty)', () => {
		const entries = bridgeVerdicts({
			reviewer: { sessionId: 's', timestamp: STAMP, agent: 'reviewer' },
		});
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.verdict === 'pass')).toBe(true);
	});
});
