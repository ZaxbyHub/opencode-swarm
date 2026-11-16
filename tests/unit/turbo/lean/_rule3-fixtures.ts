/**
 * Shared fixtures for the Rule-3 wiring suites (issue #2962, PR #3506
 * feedback round FR-006 split). Underscore-prefixed: not a test file.
 */
import type { EpicRecordV1 } from '../../../../src/epic/lifecycle';
import { computePlanKey } from '../../../../src/epic/plan-key';
import { _internals as uc } from '../../../../src/turbo/lean/upstream-committed';

export const SESSION_ID = 'sess-rule3-wiring';
export const PLAN_KEY = computePlanKey('test-identity-hash', null);
export const OTHER_PLAN_KEY = computePlanKey('other-identity-hash', null);

/** Minimal EpicRecordV1 stand-in with the fields the helper consumes. */
export function openEpicRecord(baseCommit: string | null): EpicRecordV1 {
	return {
		schema: 'epic-record-v1',
		epicKey: 'epic-test',
		token: 'tok',
		planId: 'plan-test',
		planIdentityHash: 'test-identity-hash',
		planEpoch: null,
		planKey: PLAN_KEY,
		ledgerRootDigest: null,
		status: 'open',
		startedAt: '2026-01-01T00:00:00.000Z',
		startedBySession: SESSION_ID,
		forced: false,
		structureHashAtStart: 'x',
		config: {} as EpicRecordV1['config'],
		git: { baseCommit, originalBranch: 'main' } as EpicRecordV1['git'],
		sizing: {} as EpicRecordV1['sizing'],
		priorDigest: null,
		closing: null,
		waves: [],
		activeWaveSeq: null,
		tasks: {},
		phases: {},
	};
}

/** Seam the module's Epic reads to the given record (null = Epic closed). */
export function seamEpicOpen(
	record: EpicRecordV1 | null = openEpicRecord(null),
): void {
	uc.isEpicOpenForProject = () => record !== null;
	uc.getOpenEpic = () => record;
}
