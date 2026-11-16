import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	admitPrReviewPartialBaseCoverage,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// ACCEPTANCE CHECK AC11 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: when a partial-base-coverage disclosure is already
// admitted and the dimension is RE-RUN, the derived settlement entry changes
// ONLY its lane/batch/terminal-event identity (same dimension, same
// terminalState FAILED, same failureClass). Re-admitting through the same
// public admission API must then:
//   * ACCEPT the second admission (tuple match ignoring
//     batchId/laneId/terminalEventId/safeDetail),
//   * SUPERSEDE the stored entries — both the durable disclosure file and
//     `state.prReviewPartialBaseCoverage` carry the NEW records, and
//   * append a core audit event `pr_review_coverage_disclosure_superseded`
//     to `.swarm/events.jsonl` carrying the superseded and superseding
//     terminal-event/batch/lane identities.
//
// The fixture settles the sixth dimension with a RESOURCE-class failure twice
// (resource is not legacy-auto-retryable, so the AC10 contract-class budget
// refusal never applies to this re-admission).
//
// RED at base: the immutable-disclosure branch compares the exact unresolved
// JSON (including per-entry batchId/laneId/terminalEventId), so the second
// admission throws
// 'BLOCKED: partial base coverage admission differs from the immutable
//  existing disclosure'
// and none of the supersession effects exist. GREEN after the fix: the second
// admission resolves, the new identities are durable, and the audit event is
// in the log.

const RUN_ID = 'ac11-supersession-run';
/** Deterministic, ordering-safe attempt ids: attempt-2 sorts after attempt-1
 * lexicographically, so it wins the latest-typed-failure tie-break even if
 * both terminal claims land in the same millisecond. */
const ATTEMPT_1 = {
	batchId: 'supersede-fail-1',
	laneId: 'supersede-lane-1',
	terminalEventId: 'fixture-terminal-supersede-sub-1',
};
const ATTEMPT_2 = {
	batchId: 'supersede-fail-2',
	laneId: 'supersede-lane-2',
	terminalEventId: 'fixture-terminal-supersede-sub-2',
};

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('ac11-supersession-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

type BaseDimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];

/** Five covered dimensions plus a resource-class FAILED sixth (attempt 1). */
async function establishFivePlusOneResource(): Promise<{
	missingDimension: BaseDimension;
}> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const successfulDimensions = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5);
	const missingDimension = PR_REVIEW_BASE_DIMENSION_IDS.slice(5)[0]!;
	const successfulLanes = successfulDimensions.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		successfulLanes,
		{
			batchId: 'base-successful-five',
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		'base-successful-five',
		'swarm-pr-review:base',
		successfulLanes,
	);
	await settleResourceFailure(missingDimension, ATTEMPT_1);
	return { missingDimension };
}

/** One resource-class terminal lane failure for the dimension (one attempt). */
async function settleResourceFailure(
	dimension: BaseDimension,
	attempt: { batchId: string; laneId: string; terminalEventId: string },
): Promise<void> {
	const lane = { laneId: attempt.laneId, workflowLane: dimension };
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		[lane],
		{
			batchId: attempt.batchId,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	// Explicit subagentSessionId pins the terminal claim's correlation id, so
	// the claim event id is exactly attempt.terminalEventId.
	await persistPrReviewBatch(
		directory,
		attempt.batchId,
		'swarm-pr-review:base',
		[lane],
		{
			status: 'error',
			workflowLaneFailureClass: 'resource',
			subagentSessionId: attempt.terminalEventId.replace(
				'fixture-terminal-',
				'',
			),
		},
	);
}

interface DisclosureRecord {
	runId: string;
	unresolvedDimensions: Array<{
		dimension: string;
		terminalState: string;
		failureClass?: string;
		terminalEventId?: string;
		batchId?: string;
		laneId?: string;
	}>;
}

async function readDisclosureFile(): Promise<DisclosureRecord> {
	return JSON.parse(
		await fs.readFile(
			path.join(
				directory,
				'.swarm',
				'pr-review',
				RUN_ID,
				'coverage-disclosure.json',
			),
			'utf8',
		),
	) as DisclosureRecord;
}

/** Parsed events from the durable log (line 1 is the manifest, no `type`). */
async function readCoreEvents(): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(
		path.join(directory, '.swarm', 'events.jsonl'),
		'utf8',
	);
	return raw
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => typeof event.type === 'string');
}

describe('AC11: tuple-matching re-admission supersedes the disclosure and is audited', () => {
	test('re-run with new lane identity, same (dimension, FAILED, resource) tuple: admission accepts, supersedes, and audits', async () => {
		const { missingDimension } = await establishFivePlusOneResource();
		await admitPrReviewPartialBaseCoverage(
			directory,
			PR_ARTIFACT_SESSION_ID,
			RUN_ID,
			[missingDimension],
		);
		const first = await readDisclosureFile();
		const firstEntry = first.unresolvedDimensions.find(
			(entry) => entry.dimension === missingDimension,
		);
		expect(firstEntry?.terminalState).toBe('FAILED');
		expect(firstEntry?.failureClass).toBe('resource');
		expect(firstEntry?.batchId).toBe(ATTEMPT_1.batchId);
		expect(firstEntry?.laneId).toBe(ATTEMPT_1.laneId);
		expect(firstEntry?.terminalEventId).toBe(ATTEMPT_1.terminalEventId);

		// The re-run: a NEW batch/lane/claim for the SAME dimension, same
		// tuple. At base this second admission throws the immutable-disclosure
		// error (the RED signature); after the fix it accepts.
		await settleResourceFailure(missingDimension, ATTEMPT_2);
		await admitPrReviewPartialBaseCoverage(
			directory,
			PR_ARTIFACT_SESSION_ID,
			RUN_ID,
			[missingDimension],
		);

		// The durable disclosure file carries the NEW attempt-2 identity.
		const second = await readDisclosureFile();
		const superseding = second.unresolvedDimensions.find(
			(entry) => entry.dimension === missingDimension,
		);
		expect(superseding?.terminalState).toBe('FAILED');
		expect(superseding?.failureClass).toBe('resource');
		expect(superseding?.batchId).toBe(ATTEMPT_2.batchId);
		expect(superseding?.laneId).toBe(ATTEMPT_2.laneId);
		expect(superseding?.terminalEventId).toBe(ATTEMPT_2.terminalEventId);

		// The gate state's in-memory record is superseded too.
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const stateEntry =
			state?.prReviewPartialBaseCoverage?.unresolvedDimensions.find(
				(entry) => entry.dimension === missingDimension,
			);
		expect(stateEntry?.batchId).toBe(ATTEMPT_2.batchId);
		expect(stateEntry?.laneId).toBe(ATTEMPT_2.laneId);
		expect(stateEntry?.terminalEventId).toBe(ATTEMPT_2.terminalEventId);

		// The supersession is audited in the durable events log, with both the
		// superseded and the superseding terminal-event identities present.
		const events = await readCoreEvents();
		const supersedeEvent = events.find(
			(event) => event.type === 'pr_review_coverage_disclosure_superseded',
		);
		expect(supersedeEvent).toBeDefined();
		const serialized = JSON.stringify(supersedeEvent);
		expect(serialized).toContain(ATTEMPT_1.terminalEventId);
		expect(serialized).toContain(ATTEMPT_2.terminalEventId);
	});
});
