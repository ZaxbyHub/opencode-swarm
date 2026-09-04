/**
 * No-active-plan status composition (#2493 review PC-1 regression pin).
 *
 * The inline decision-drift branch used to EARLY-RETURN before the
 * delegation-ledger health block, silently suppressing the ledger incident
 * (a #2034/#1659 visibility guarantee) whenever both signals coexisted with
 * no active plan. The tail is now extracted as
 * `_internals.renderNoActivePlanStatusTail` and this file pins that all
 * three signals compose and none suppresses another.
 */
import { describe, expect, test } from 'bun:test';
import {
	_internals,
	type StatusData,
} from '../../../src/services/status-service';

function fakeStatusData(overrides: Partial<StatusData> = {}): StatusData {
	return {
		hasPlan: false,
		...overrides,
	} as unknown as StatusData;
}

const drift = { staleCount: 2, contradictionCount: 1 };

const ledgerIncident = {
	ledger: {
		bytes: 1024,
		limitBytes: 1024 * 1024,
		pressurePct: 1,
		band: 'ok',
	},
	counts: {
		activeOwners: 0,
		pendingAdvisories: 2,
		lateTerminals: 0,
		orphanWorktreeOwners: 0,
	},
} as unknown as NonNullable<StatusData['delegationLedgerHealth']>;

describe('no-active-plan status tail composition (#2493 review PC-1)', () => {
	test('decision drift does NOT suppress the delegation-ledger health block', () => {
		const out = _internals.renderNoActivePlanStatusTail(
			fakeStatusData({
				decisionDrift: drift,
				delegationLedgerHealth: ledgerIncident,
			}),
		);
		expect(out).toContain('No active swarm plan found.');
		expect(out).toContain('**Background Delegations**:');
		expect(out).toContain('pending advisories');
		expect(out).toContain('**Decision drift detected**');
	});

	test('decision drift renders standalone when the ledger is clean', () => {
		const out = _internals.renderNoActivePlanStatusTail(
			fakeStatusData({ decisionDrift: drift }),
		);
		expect(out).toContain('**Decision drift detected**');
		expect(out).not.toContain('**Background Delegations**');
	});

	test('a ledger incident renders standalone when there is no drift', () => {
		const out = _internals.renderNoActivePlanStatusTail(
			fakeStatusData({ delegationLedgerHealth: ledgerIncident }),
		);
		expect(out).toContain('**Background Delegations**:');
		expect(out).not.toContain('**Decision drift detected**');
	});

	test('a clean repo renders the bare message (byte-identical pin)', () => {
		const out = _internals.renderNoActivePlanStatusTail(fakeStatusData());
		expect(out).toBe('No active swarm plan found.');
	});

	test('spec drift still composes decision drift (pre-existing pin)', () => {
		const out = _internals.renderNoActivePlanStatusTail(
			fakeStatusData({
				specStale: true,
				decisionDrift: drift,
			}),
		);
		expect(out).toContain('**Spec drift detected**');
		expect(out).toContain('**Decision drift detected**');
	});
});
