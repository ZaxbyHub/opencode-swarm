import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	assertPrFeedbackGatePhaseSettled,
	declarePrFeedbackInventory,
	_test_exports as gateInternals,
	MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS,
	type PrWorkflowGateState,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'feedback-amendment';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';

let directory = '';
const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolvePrWorkflowRevisionDigest:
		gateInternals.resolvePrWorkflowRevisionDigest,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	resolveCurrentUpstreamPushTarget:
		gateInternals.resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamPushTargetAsync:
		gateInternals.resolveCurrentUpstreamPushTargetAsync,
	resolveRemoteRefsContainingHead:
		gateInternals.resolveRemoteRefsContainingHead,
	resolveRemoteRefsContainingHeadAsync:
		gateInternals.resolveRemoteRefsContainingHeadAsync,
};

const UPSTREAM = {
	remoteName: 'origin',
	remoteBranchRef: 'refs/heads/pr-branch',
	remoteTrackingRef: 'refs/remotes/origin/pr-branch',
};

beforeEach(() => {
	directory = canonicalMkdtemp('pr-gate-amendment-');
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	// PR_FEEDBACK head binding asserts an exact tracking checkout; a matching
	// upstream short-circuits it (same shape as the stage-a-retention suite).
	gateInternals.resolveCurrentUpstreamPushTarget = () => UPSTREAM;
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async () => UPSTREAM;
	gateInternals.resolveRemoteRefsContainingHead = () => [
		UPSTREAM.remoteTrackingRef,
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async () => [
		UPSTREAM.remoteTrackingRef,
	];
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, originals);
	await fs.rm(directory, { recursive: true, force: true });
});

async function activateFeedback(sessionID = SESSION_ID): Promise<void> {
	await activatePrWorkflow(directory, sessionID, 'PR_FEEDBACK');
}

/** Write a raw PR_FEEDBACK gate-state record straight to disk. */
async function writeRawState(
	sessionID: string,
	partial: Partial<PrWorkflowGateState>,
): Promise<void> {
	const absolute = path.join(
		directory,
		'.swarm',
		gateInternals.workflowGateStateRelativePath(sessionID),
	);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const base: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		mode: 'PR_FEEDBACK',
		activatedAt: '2026-08-19T00:00:00.000Z',
		updatedAt: '2026-08-19T00:00:00.000Z',
		prHeadSha: HEAD_SHA,
	};
	await fs.writeFile(
		absolute,
		JSON.stringify({ ...base, ...partial }, null, 2),
		'utf-8',
	);
}

describe('declarePrFeedbackInventory — regression: inventory immutability was a whole-workflow trap (R3/W-2)', () => {
	test('an identical re-declaration is still idempotent', async () => {
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-2'], {
			prHeadSha: HEAD_SHA,
		});
		const state = await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2'],
			{ prHeadSha: HEAD_SHA },
		);
		expect(state.prFeedbackInventory).toEqual(['FB-1', 'FB-2']);
		expect(state.prFeedbackInventoryAmendments).toBeUndefined();
	});

	test('the same set in a different caller order is idempotent, not an amendment', async () => {
		// `normalizeInventoryIds` canonicalises by sorting, so "reorder" is not
		// expressible at this boundary — which is exactly why the acceptance rule
		// is set-superset rather than the plan's literal array-prefix.
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-2', 'FB-1'], {
			prHeadSha: HEAD_SHA,
		});
		const state = await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2'],
			{ prHeadSha: HEAD_SHA },
		);
		expect(state.prFeedbackInventory).toEqual(['FB-1', 'FB-2']);
		expect(state.prFeedbackInventoryAmendments).toBeUndefined();
	});

	test('appending a newly-discovered item is ACCEPTED and audited', async () => {
		// Previous behaviour: `BLOCKED: PR_FEEDBACK inventory is immutable after
		// declaration` for ANY different array. A finding discovered after the
		// first declaration could only be handled by abort + full restart, which
		// also discarded every completed verification for correctly-declared items.
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-3'], {
			prHeadSha: HEAD_SHA,
		});

		const state = await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2', 'FB-3'],
			{ prHeadSha: HEAD_SHA },
		);

		expect(state.prFeedbackInventory).toEqual(['FB-1', 'FB-2', 'FB-3']);
		expect(state.prFeedbackInventoryAmendments).toHaveLength(1);
		expect(state.prFeedbackInventoryAmendments?.[0]).toMatchObject({
			entry: 'FB-2',
			batch: 1,
		});
		expect(typeof state.prFeedbackInventoryAmendments?.[0].amendedAt).toBe(
			'string',
		);
		// Durable, not just in-memory.
		const persisted = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(persisted?.prFeedbackInventoryAmendments).toHaveLength(1);
	});

	test('REMOVING an existing entry still hard-fails', async () => {
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-2'], {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1'], {
				prHeadSha: HEAD_SHA,
			}),
		).rejects.toThrow(/append-only.*FB-2/is);
	});

	test('MUTATING an existing entry still hard-fails', async () => {
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-2'], {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			declarePrFeedbackInventory(
				directory,
				SESSION_ID,
				['FB-1', 'FB-2-typo-fixed'],
				{ prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(/append-only.*FB-2/is);
	});

	test('a second amendment gets its own batch number', async () => {
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1'], {
			prHeadSha: HEAD_SHA,
		});
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-2'], {
			prHeadSha: HEAD_SHA,
		});
		const state = await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2', 'FB-3'],
			{ prHeadSha: HEAD_SHA },
		);
		expect(state.prFeedbackInventoryAmendments?.map((a) => a.batch)).toEqual([
			1, 2,
		]);
		expect(state.prFeedbackInventoryAmendments?.map((a) => a.entry)).toEqual([
			'FB-2',
			'FB-3',
		]);
	});

	test('two entries appended in one call share one batch number', async () => {
		await activateFeedback();
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1'], {
			prHeadSha: HEAD_SHA,
		});
		const state = await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2', 'FB-3'],
			{ prHeadSha: HEAD_SHA },
		);
		expect(state.prFeedbackInventoryAmendments?.map((a) => a.batch)).toEqual([
			1, 1,
		]);
	});

	test('the amendment ledger is bounded and fails closed at the cap', async () => {
		// The ledger is an integrity audit trail, not a reclaimable cache: it is
		// never pruned, so growth must be refused rather than compacted.
		const inventory = ['FB-000'];
		const amendments = Array.from(
			{ length: MAX_PR_FEEDBACK_INVENTORY_AMENDMENTS },
			(_unused, index) => ({
				entry: `FB-${String(index + 1).padStart(3, '0')}`,
				amendedAt: '2026-08-19T00:00:00.000Z',
				batch: index + 1,
			}),
		);
		await writeRawState('cap-session', {
			prFeedbackInventory: [
				...inventory,
				...amendments.map((amendment) => amendment.entry),
			].sort(),
			prFeedbackInventoryAmendments: amendments,
		});
		await expect(
			declarePrFeedbackInventory(
				directory,
				'cap-session',
				[
					...inventory,
					...amendments.map((amendment) => amendment.entry),
					'FB-OVERFLOW',
				],
				{ prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(/amendment limit reached/i);
	});

	test('an amendment disarms publication', async () => {
		// The armed record attests coverage of the PRE-amendment inventory; adding
		// an item invalidates exactly that attestation. Disarming here mirrors the
		// unconditional disarm `recordPrFeedbackStageA` already performs.
		await writeRawState('armed-amend', {
			prFeedbackInventory: ['FB-1'],
			prFeedbackReadyToPublish: {
				revisionDigest: REVISION,
				localHead: 'def456',
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/fix/x',
				remoteRef: 'refs/remotes/origin/fix/x',
				validatedAt: '2026-08-19T00:00:00.000Z',
			} as PrWorkflowGateState['prFeedbackReadyToPublish'],
		});

		const state = await declarePrFeedbackInventory(
			directory,
			'armed-amend',
			['FB-1', 'FB-2'],
			{ prHeadSha: HEAD_SHA },
		);

		expect(state.prFeedbackReadyToPublish).toBeUndefined();
		expect(
			(await readPrWorkflowGateState(directory, 'armed-amend'))
				?.prFeedbackReadyToPublish,
		).toBeUndefined();
	});
});

describe('assertPrFeedbackGatePhaseSettled — regression: an appended item must not reach publication unverdicted (R3/W-2)', () => {
	// `PrFeedbackStageARecordSchema` requires >= 2 check receipts; the content is
	// irrelevant to this guard, which fires before any receipt is inspected.
	const STAGE_A = {
		revisionDigest: REVISION,
		checks: [
			{
				category: 'diff-check',
				command: ['git', 'diff', '--check'],
				durationMs: 1,
			},
			{ category: 'build', command: ['bun', 'run', 'build'], durationMs: 1 },
		],
		applicableCategories: ['build'],
		applicableObligations: [],
		validatedAt: '2026-08-19T00:00:00.000Z',
	};

	test('a gate batch recorded BEFORE the amendment no longer settles the phase', async () => {
		// `stageARetainsGateBatches` compares only digest/categories/obligations —
		// never the item list — so an append plus a same-revision Stage A
		// re-record RETAINS batches whose `itemIds` predate the growth, and
		// `successfulObligationsFromExactBatch` is then fed the stale, shorter
		// list. Without this guard the appended item reaches publication with
		// zero Stage-B verdict.
		await writeRawState('stale-batch', {
			prFeedbackInventory: ['FB-1', 'FB-2', 'FB-3'],
			prFeedbackInventoryAmendments: [
				{ entry: 'FB-3', amendedAt: '2026-08-19T00:00:00.000Z', batch: 1 },
			],
			prFeedbackStageA: {
				...STAGE_A,
				feedbackItemIds: ['FB-1', 'FB-2', 'FB-3'],
			} as PrWorkflowGateState['prFeedbackStageA'],
			prFeedbackGateBatches: [
				{
					batchId: 'gate-1',
					phase: 'stage-b-reviewer',
					laneId: 'stage-b-reviewer',
					// Pre-amendment ownership.
					itemIds: ['FB-1', 'FB-2'],
					revisionDigest: REVISION,
					validatedAt: '2026-08-19T00:00:00.000Z',
				},
			] as PrWorkflowGateState['prFeedbackGateBatches'],
		});

		await expect(
			assertPrFeedbackGatePhaseSettled(
				directory,
				'stale-batch',
				'stage-b-reviewer',
			),
		).rejects.toThrow(/stale inventory|amended after this batch/i);
	});

	test('a gate batch owning the full amended inventory clears this guard', async () => {
		await writeRawState('fresh-batch', {
			prFeedbackInventory: ['FB-1', 'FB-2', 'FB-3'],
			prFeedbackStageA: {
				...STAGE_A,
				feedbackItemIds: ['FB-1', 'FB-2', 'FB-3'],
			} as PrWorkflowGateState['prFeedbackStageA'],
			prFeedbackGateBatches: [
				{
					batchId: 'gate-2',
					phase: 'stage-b-reviewer',
					laneId: 'stage-b-reviewer',
					itemIds: ['FB-1', 'FB-2', 'FB-3'],
					revisionDigest: REVISION,
					validatedAt: '2026-08-19T00:00:00.000Z',
				},
			] as PrWorkflowGateState['prFeedbackGateBatches'],
		});

		const error = await assertPrFeedbackGatePhaseSettled(
			directory,
			'fresh-batch',
			'stage-b-reviewer',
		).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);

		// It still fails on the real per-item verdict requirement (no delegation
		// records exist in this fixture) — what must NOT survive is the
		// stale-inventory refusal, and the state must have been READABLE for that
		// distinction to mean anything.
		expect(error).not.toBeNull();
		expect(error).not.toMatch(/stale inventory|amended after this batch/i);
		expect(error).not.toMatch(/is invalid/i);
		expect(error).toMatch(/complete, non-degraded positive verdict row/i);
	});
});

describe('amendment disclosure surfaces (R3/W-2)', () => {
	test('pr_workflow_status reports the amendment ledger', async () => {
		const { _internals: statusInternals, pr_workflow_status } = await import(
			'../../../src/tools/pr-workflow-status.js'
		);
		const saved = {
			runGitCapture: statusInternals.runGitCapture,
			resolveCurrentGitHeadAsync: statusInternals.resolveCurrentGitHeadAsync,
			resolveIsWorkingTreeCleanAsync:
				statusInternals.resolveIsWorkingTreeCleanAsync,
			classifyGitState: statusInternals.classifyGitState,
		};
		statusInternals.runGitCapture = async () => null;
		statusInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
		statusInternals.resolveIsWorkingTreeCleanAsync = async () => true;
		statusInternals.classifyGitState = async () => ({
			kind: 'clean',
			code: 'CLEAN',
			retryable: true,
			requiredAction: 'No checkout recovery is required.',
			evidence: {
				worktreeRoot: directory,
				gitDir: `${directory}/.git`,
				operations: [],
				unmergedCodes: [],
				paths: [],
				trackedCount: 0,
				untrackedCount: 0,
				pathsTruncated: false,
			},
		});
		try {
			await activateFeedback('status-amend');
			await declarePrFeedbackInventory(directory, 'status-amend', ['FB-1'], {
				prHeadSha: HEAD_SHA,
			});
			await declarePrFeedbackInventory(
				directory,
				'status-amend',
				['FB-1', 'FB-2'],
				{ prHeadSha: HEAD_SHA },
			);
			const raw = await (
				pr_workflow_status as unknown as {
					execute: (args: unknown, ctx: unknown) => Promise<unknown>;
				}
			).execute({}, { directory, sessionID: 'status-amend' });
			const parsed = JSON.parse(
				typeof raw === 'string' ? raw : (raw as { output: string }).output,
			);
			expect(parsed.gate.inventoryAmendments).toEqual([
				{
					entry: 'FB-2',
					amendedAt: expect.any(String),
					batch: 1,
				},
			]);
		} finally {
			Object.assign(statusInternals, saved);
		}
	});

	test('the completion tool response lists the amendments', async () => {
		const { executeCompletePrWorkflow } = await import(
			'../../../src/tools/complete-pr-workflow.js'
		);
		await activateFeedback('complete-amend');
		await declarePrFeedbackInventory(directory, 'complete-amend', ['FB-1'], {
			prHeadSha: HEAD_SHA,
		});
		await declarePrFeedbackInventory(
			directory,
			'complete-amend',
			['FB-1', 'FB-2'],
			{ prHeadSha: HEAD_SHA },
		);

		const parsed = JSON.parse(
			await executeCompletePrWorkflow(
				{ mode: 'PR_FEEDBACK', pr_head_sha: HEAD_SHA },
				directory,
				{ sessionID: 'complete-amend' },
			),
		);

		// Completion fails on real coverage; the amendment disclosure must be on
		// the response either way so the operator can see what changed.
		expect(parsed.inventory_amendments).toEqual([
			{ entry: 'FB-2', amendedAt: expect.any(String), batch: 1 },
		]);
	});
});
