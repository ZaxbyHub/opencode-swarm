import { describe, expect, test } from 'bun:test';
import type { Evidence } from '../../../src/config/evidence-schema';
import { mergeDurableGateEntriesFromEvidence } from '../../../src/evidence/gate-bridge';

/**
 * Issue #3560 AC7 (#3561 FB-004/PRR-004, critic-escalated over the reviewer's
 * "accept"): the evidence-summary bridge must REPORT THE RECORDED VERDICT of
 * a durable gate record — a council REJECT is reported as REJECT (verdict
 * 'rejected' + the recorded token in the summary/metadata), never collapsed to
 * a generic 'fail' (indistinguishable from a malformed verdict) and never to
 * a synthesized 'pass'. Each leg first proves the derivation produced a
 * non-empty expected entry set (#3561 FB-006/PRR-007: `.every()` on an empty
 * array is vacuously true; a warn-drop mutation survived without the guard).
 */

const STAMP = '2026-11-02T00:00:00.000Z';

function bridgeVerdicts(gates: Record<string, unknown>): Evidence[] {
	return mergeDurableGateEntriesFromEvidence('4.1', [], {
		taskId: '4.1',
		required_gates: [],
		gates,
	} as never);
}

function councilEntry(verdict: unknown): Record<string, unknown> {
	return {
		sessionId: 'swarm-council',
		timestamp: STAMP,
		agent: 'architect', // production COUNCIL_AGENT_ID
		verdict,
	};
}

describe('gate-bridge durable verdict fidelity (#3560)', () => {
	test('bridge preserves durable verdict: council REJECT reports REJECT, never pass or generic fail', () => {
		const entries = bridgeVerdicts({ council: councilEntry('REJECT') });
		// FB-006 non-emptiness guard BEFORE any .every().
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			// AC7 literal: the recorded verdict is reported, not collapsed.
			expect(entry.verdict).toBe('rejected');
			expect(entry.summary).toContain('REJECT');
			expect(
				(entry.metadata as { durable_verdict?: unknown }).durable_verdict,
			).toBe('REJECT');
		}
	});

	test('bridge preserves durable verdict for advisory CONCERNS (warn) and APPROVE (approved) with non-empty guards', () => {
		const concerns = bridgeVerdicts({ council: councilEntry('CONCERNS') });
		expect(concerns.length).toBeGreaterThan(0); // FB-006: pins warn-drop
		expect(concerns.every((entry) => entry.verdict === 'warn')).toBe(true);
		expect(
			concerns.every((entry) => (entry.summary as string).includes('CONCERNS')),
		).toBe(true);
		const approve = bridgeVerdicts({ council: councilEntry('APPROVE') });
		expect(approve.length).toBeGreaterThan(0); // FB-006: pins drop
		expect(approve.every((entry) => entry.verdict === 'approved')).toBe(true);
	});

	test('bridge reports a malformed verdict as fail (distinguishable from a REJECT)', () => {
		const malformed = bridgeVerdicts({ council: councilEntry(42) });
		expect(malformed.length).toBeGreaterThan(0);
		for (const entry of malformed) {
			// #3561 FB-001: non-string verdict is error → 'fail', and the
			// REJECT leg proves 'rejected' — the two surfaces are distinct.
			expect(entry.verdict).toBe('fail');
		}
	});

	test('bridge preserves presence-only records as pass (producer-contract honesty)', () => {
		const entries = bridgeVerdicts({
			reviewer: { sessionId: 's', timestamp: STAMP, agent: 'reviewer' },
		});
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.verdict === 'pass')).toBe(true);
	});
});
