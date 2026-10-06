/**
 * Test helpers for the Epic v2 lifecycle (`src/epic/lifecycle.ts`).
 *
 * `openEpicForTest` writes a REAL lifecycle row + sentinel through the
 * production `createEpicRecord` (CAS + lifecycle lock), bound to the plan
 * currently on disk (`.swarm/plan.json` identity + ledger root digest), so
 * every production probe (`isEpicOpenForProject`, `getOpenEpic`) sees an
 * open epic exactly as after `/swarm epic start`. It skips start's
 * preconditions on purpose — tests of those use `startEpic` itself.
 *
 * `stubEpicRecord` builds a record for `_internals` DI doubles;
 * `issuedWaveForTest` an issued (active) wave with the given frozen scopes —
 * pass it as `{ waves: [wave], activeWaveSeq: wave.seq }`.
 */

import {
	computeEpicKey,
	createEpicRecord,
	type EpicRecordV1,
	type EpicWaveRecord,
	readCurrentPlanIdentity,
	readLedgerRootDigest,
} from '../../src/epic/lifecycle.js';
import { evaluateEpicSizing } from '../../src/epic/sizing.js';

export function stubEpicRecord(
	overrides: Partial<EpicRecordV1> = {},
): EpicRecordV1 {
	const planId = overrides.planId ?? 'test-swarm-Test_Plan';
	const planKey = overrides.planKey ?? '0123456789abcdef';
	return {
		schema: 'epic-record-v1',
		epicKey: computeEpicKey(planId, planKey),
		token: 'test-token',
		planId,
		planIdentityHash: 'identity-hash',
		planEpoch: null,
		planKey,
		ledgerRootDigest: null,
		status: 'open',
		startedAt: '2026-01-01T00:00:00.000Z',
		startedBySession: 'ses_test',
		forced: false,
		structureHashAtStart: 'structure-hash',
		config: {
			commitPolicy: 'current-branch',
			isolation: 'worktree',
			maxParallel: 4,
		},
		git: {
			isRepo: true,
			baseCommit: null,
			originalBranch: 'main',
			epicBranch: null,
		},
		sizing: evaluateEpicSizing({
			pendingTasks: 6,
			scopedTasks: 6,
			serialSteps: 2,
		}),
		priorDigest: null,
		closing: null,
		waves: [],
		activeWaveSeq: null,
		tasks: {},
		phases: {},
		...overrides,
	};
}

/**
 * Open an epic bound to the plan on disk. Throws when no plan is on disk or
 * an epic row already exists.
 */
export function openEpicForTest(
	directory: string,
	overrides: Partial<EpicRecordV1> = {},
): EpicRecordV1 {
	const identity = readCurrentPlanIdentity(directory);
	if (!identity) {
		throw new Error(
			`openEpicForTest: no readable .swarm/plan.json in ${directory}`,
		);
	}
	const record = stubEpicRecord({
		planId: identity.planId,
		planIdentityHash: identity.planIdentityHash,
		ledgerRootDigest: readLedgerRootDigest(directory),
		...overrides,
	});
	if (!overrides.epicKey) {
		record.epicKey = computeEpicKey(record.planId, record.planKey);
	}
	const created = createEpicRecord(directory, record);
	if (created.outcome !== 'created') {
		throw new Error(
			`openEpicForTest: epic row already exists (${created.existingKeys.join(', ')})`,
		);
	}
	return created.record;
}

/**
 * A `getOpenEpic` double for planner tests: an open epic whose wave width
 * (64) never caps the planner's own `max_parallel_coders`.
 */
export function wideOpenEpic(): EpicRecordV1 {
	return stubEpicRecord({
		config: {
			commitPolicy: 'current-branch',
			isolation: 'worktree',
			maxParallel: 64,
		},
	});
}

/** An issued wave whose frozen scopes are `files` (task id → files). */
export function issuedWaveForTest(
	files: Record<string, string[]>,
	overrides: Partial<EpicWaveRecord> = {},
): EpicWaveRecord {
	return {
		seq: 1,
		phase: 1,
		kind: 'parallel',
		taskIds: Object.keys(files),
		files,
		cochange: null,
		baseHead: null,
		issuedAt: '2026-01-01T00:00:00.000Z',
		status: 'issued',
		...overrides,
	};
}
