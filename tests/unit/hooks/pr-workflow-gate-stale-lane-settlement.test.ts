import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	type BackgroundDelegationRecord,
	DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	completePrWorkflow,
	_test_exports as gateInternals,
	type PrWorkflowGateState,
	settlePresumedStalePrWorkflowLanes,
} from '../../../src/hooks/pr-workflow-gate.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
let restoreClock: () => void = () => {};
const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(() => {
	// Staleness is a pure function of Date.now() - updatedAt; freezing the
	// clock makes every backdated age margin exact (issue #1782 class 1).
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-workflow-stale-lane-');
	gateInternals.resetTrackedStateCache();
	// Both the sync and async Git seams are stubbed: `completePrWorkflow`
	// verifies the bound head through the async pair before it ever reaches the
	// open-lane predicate under test.
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.resolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync =
		originals.resolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.resolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originals.resolveIsWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write a raw gate-state record straight to disk (mirrors the abort suite). */
async function writeRawState(
	sessionID: string,
	partial: Partial<PrWorkflowGateState>,
): Promise<void> {
	const relative = gateInternals.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const base: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	};
	await fs.writeFile(
		absolute,
		JSON.stringify({ ...base, ...partial }, null, 2),
		'utf-8',
	);
}

/** Record one open `swarm-pr-review:base` lane for `parentSessionId`. */
async function recordOpenLane(
	parentSessionId: string,
	laneId: string,
	correlationId: string,
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: `sub-${correlationId}`,
		parentSessionId,
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'b1',
		laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: laneId,
		workspace: {
			directory,
			gitHead: 'abc123',
			dirtyHash: null,
			prHeadSha: 'abc123',
			scope: null,
		},
	});
}

/**
 * Backdate a lane's `updatedAt` past the staleness horizon by appending a
 * replacement snapshot — the store folds last-write-wins per correlationId, so
 * this is the same shape a real record takes when its process stops updating.
 */
function backdateLane(correlationId: string, ageMs: number): void {
	const record = readDelegations(directory).find(
		(candidate) => candidate.correlationId === correlationId,
	) as BackgroundDelegationRecord;
	const storePath = path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE);
	appendFileSync(
		storePath,
		`${JSON.stringify({ ...record, updatedAt: Date.now() - ageMs })}\n`,
		'utf-8',
	);
}

const STALE_AGE_MS = DEFAULT_STALE_DELEGATION_TIMEOUT_MS + 60_000;

describe('settlePresumedStalePrWorkflowLanes — regression: W-4 stuck lanes wedge both abort and completion (R2)', () => {
	test('a lane stale past the horizon is presumed settled, not open', async () => {
		// Previous behaviour: every `pending`/`running` swarm-pr-* record counted
		// as open forever, so a lane whose backing process died without writing a
		// terminal snapshot blocked abort AND completion with no tool-level exit.
		await recordOpenLane('sess-a', 'intent-architecture', 'c1');
		backdateLane('c1', STALE_AGE_MS);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-a',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.openLaneIds).toEqual([]);
		expect(settlement.presumedStaleLaneIds).toEqual(['intent-architecture']);
		expect(settlement.disclosure).toContain('1 lane(s) stale >30min');
		expect(settlement.disclosure).toContain(
			'treated as settled: intent-architecture',
		);
	});

	test('a lane with a fresh updatedAt still blocks (contradiction rule)', async () => {
		await recordOpenLane('sess-b', 'risk-security', 'c2');

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-b',
		);

		expect(settlement.openLanes).toBe(1);
		expect(settlement.openLaneIds).toEqual(['risk-security']);
		expect(settlement.presumedStaleLaneIds).toEqual([]);
		expect(settlement.disclosure).toBeUndefined();
	});

	test('another session’s stale lane is never settled by this session', async () => {
		await recordOpenLane('other-session', 'intent-architecture', 'c3');
		backdateLane('c3', STALE_AGE_MS);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-c',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.presumedStaleLaneIds).toEqual([]);
		expect(
			readDelegations(directory).find((r) => r.correlationId === 'c3')?.status,
		).toBe('pending');
	});

	test('settling durably transitions the record to `stale` and discloses to events.jsonl', async () => {
		await recordOpenLane('sess-d', 'intent-architecture', 'c4');
		backdateLane('c4', STALE_AGE_MS);

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-d');

		expect(
			readDelegations(directory).find((r) => r.correlationId === 'c4')?.status,
		).toBe('stale');
		const events = await fs.readFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		const event = JSON.parse(events.trim().split('\n').pop() as string);
		expect(event).toMatchObject({
			type: 'pr_workflow_lanes_presumed_stale',
			sessionID: 'sess-d',
			presumedStaleLanes: ['intent-architecture'],
		});
	});
});

describe('abortPrWorkflow — regression: abort must always be reachable when lanes are merely stale (R2/W-4)', () => {
	test('abort SUCCEEDS with disclosure when the only open lane is stale', async () => {
		// Previous behaviour: `BLOCKED: PR_REVIEW abort refused while 1 PR workflow
		// lane(s) are still in flight` — the same predicate blocked the escape
		// hatch that exists to resolve the wedge, leaving no tool-level exit.
		await activatePrWorkflow(directory, 'stale-abort', 'PR_REVIEW');
		await recordOpenLane('stale-abort', 'intent-architecture', 'c5');
		backdateLane('c5', STALE_AGE_MS);

		const summary = await abortPrWorkflow(directory, 'stale-abort', {
			kind: 'recovery',
			reason: 'lane process died without a terminal snapshot',
		});

		expect(summary.openLanes).toBe(0);
		expect(summary.presumedStaleLanes).toEqual(['intent-architecture']);
		expect(summary.presumedStaleDisclosure).toContain(
			'treated as settled: intent-architecture',
		);
	});

	test('abort still refuses while a lane has a fresh updatedAt', async () => {
		await activatePrWorkflow(directory, 'fresh-abort', 'PR_REVIEW');
		await recordOpenLane('fresh-abort', 'intent-architecture', 'c6');

		await expect(
			abortPrWorkflow(directory, 'fresh-abort', {
				kind: 'recovery',
				reason: 'x',
			}),
		).rejects.toThrow(/in flight.*intent-architecture/i);
	});

	test('the abort audit event records the presumed-stale settlement', async () => {
		await activatePrWorkflow(directory, 'stale-audit', 'PR_REVIEW');
		await recordOpenLane('stale-audit', 'risk-security', 'c7');
		backdateLane('c7', STALE_AGE_MS);

		await abortPrWorkflow(directory, 'stale-audit', {
			kind: 'recovery',
			reason: 'stale lane settlement audit',
		});

		const events = await fs.readFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		const abortEvent = events
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.find((event) => event.type === 'pr_workflow_aborted');
		expect(abortEvent).toMatchObject({
			openLanes: 0,
			presumedStaleLanes: ['risk-security'],
		});
	});

	test('the abort tool response surfaces the presumed-stale disclosure', async () => {
		const { executeAbortPrWorkflow } = await import(
			'../../../src/tools/abort-pr-workflow.js'
		);
		await activatePrWorkflow(directory, 'stale-tool', 'PR_REVIEW');
		await recordOpenLane('stale-tool', 'intent-architecture', 'c8');
		backdateLane('c8', STALE_AGE_MS);

		const parsed = JSON.parse(
			await executeAbortPrWorkflow(
				{ kind: 'recovery', reason: 'stale lane' },
				directory,
				{ sessionID: 'stale-tool' },
			),
		);

		expect(parsed.success).toBe(true);
		expect(parsed.presumed_stale_lanes).toEqual(['intent-architecture']);
		expect(parsed.presumed_stale_disclosure).toContain('treated as settled');
	});
});

describe('completePrWorkflow — regression: stale lanes must not block completion (R2/W-4)', () => {
	test('completion passes the open-lane predicate when the only lane is stale', async () => {
		// Previous behaviour: `BLOCKED: PR_REVIEW completion has 1 unsettled PR
		// workflow lane(s)` at pr-workflow-gate.ts:5187 and the identical block at
		// :4484 (assertPrReviewTerminalReady). Completion legitimately fails later
		// on real coverage; what must NOT survive is the unsettled-lane refusal.
		await writeRawState('stale-complete', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 2,
		});
		await recordOpenLane('stale-complete', 'intent-architecture', 'c9');
		backdateLane('c9', STALE_AGE_MS);

		const error = await completePrWorkflow(
			directory,
			'stale-complete',
			'PR_REVIEW',
			'abc123',
		).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);

		expect(error).not.toBeNull();
		expect(error).not.toMatch(/unsettled PR workflow lane/i);
		expect(
			readDelegations(directory).find((r) => r.correlationId === 'c9')?.status,
		).toBe('stale');
	});

	test('completion still refuses while a lane has a fresh updatedAt', async () => {
		await writeRawState('fresh-complete', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 2,
		});
		await recordOpenLane('fresh-complete', 'intent-architecture', 'c10');

		await expect(
			completePrWorkflow(directory, 'fresh-complete', 'PR_REVIEW', 'abc123'),
		).rejects.toThrow(/completion has 1 unsettled PR workflow lane/i);
	});

	test('the completion tool response surfaces the presumed-stale disclosure', async () => {
		const { executeCompletePrWorkflow } = await import(
			'../../../src/tools/complete-pr-workflow.js'
		);
		await writeRawState('stale-complete-tool', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 2,
		});
		await recordOpenLane('stale-complete-tool', 'intent-architecture', 'c11');
		backdateLane('c11', STALE_AGE_MS);

		const parsed = JSON.parse(
			await executeCompletePrWorkflow(
				{ mode: 'PR_REVIEW', pr_head_sha: 'abc123' },
				directory,
				{ sessionID: 'stale-complete-tool' },
			),
		);

		// Completion itself fails later on real coverage; the disclosure must be
		// present regardless so the operator sees what was NOT re-verified.
		expect(parsed.presumed_stale_lanes).toEqual(['intent-architecture']);
		expect(parsed.presumed_stale_disclosure).toContain('treated as settled');
	});
});
