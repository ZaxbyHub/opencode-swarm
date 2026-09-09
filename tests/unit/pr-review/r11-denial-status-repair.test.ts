/**
 * Issue #2585 (Roadmap H8) — C8 / AC5 / R11: an ordinary denied action names
 * its ACTUAL cause and the next step; store uncertainty survives every
 * consumer; retry is bounded; `pr_workflow_status` is truthful (current /
 * stale / unknown); repair and abort stay reachable; distinct causes get
 * distinct messages.
 *
 * No mock.module. Seams (`_test_exports` / `_internals`) restored in afterEach.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import { PR_REVIEW_TRIGGER_DEFINITIONS } from '../../../src/background/pr-review-trigger-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	bindPrWorkflowHead,
	enforcePrReviewBaseDimensions,
	_test_exports as gate,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import {
	pr_workflow_status,
	_internals as statusInternals,
} from '../../../src/tools/pr-workflow-status.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import {
	executeWritePrReviewTriggerEval,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

/** persistPrReviewBatch stamps its records with this parent session identity. */
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const OTHER_SESSION_ID = 'ses_r11_child';
const BOUND_HEAD = PR_ARTIFACT_HEAD_SHA;
const BASE_SHA = 'def456';
/** The submit tool's schema requires a hex-64 digest; it is never verified here. */
const SUBMIT_DIGEST = 'f'.repeat(64);
const FIXED_NOW = 1_800_000_000_000;
const ORIGINALS = {
	head: gate.resolveCurrentGitHead,
	headAsync: gate.resolveCurrentGitHeadAsync,
	revision: gate.resolvePrWorkflowRevisionDigest,
	clean: gate.resolveIsWorkingTreeClean,
	cleanAsync: gate.resolveIsWorkingTreeCleanAsync,
	diffStats: gate.resolvePrReviewDiffStats,
	diffStatsAsync: gate.resolvePrReviewDiffStatsAsync,
	sessionOps: gate.getSessionOps,
	writerDigest: writerInternals.resolvePrWorkflowRevisionDigest,
	writerMergeBase: writerInternals.resolveMergeBase,
	statusHead: statusInternals.resolveCurrentGitHeadAsync,
	statusClean: statusInternals.resolveIsWorkingTreeCleanAsync,
};

let directory = '';
let restoreClock: (() => void) | null = null;

function parsed(value: unknown): Record<string, unknown> & {
	success: boolean;
	message?: string;
} {
	return JSON.parse(String(value)) as Record<string, unknown> & {
		success: boolean;
		message?: string;
	};
}

interface StatusShape {
	success: boolean;
	sessionID: string | null;
	git: { head: string | null };
	gate: {
		active: boolean;
		reason?: string;
		prHeadBound?: boolean;
		prHeadSha?: string | null;
	};
	nextStep: string;
	recovery: {
		controllerSessionID: string | null;
		delegationRead: { state: string; reasonCode?: string };
		lastProgress: { revision: number } | null;
		nextStep: string;
	};
}

async function status(sessionID?: string): Promise<StatusShape> {
	return parsed(
		await pr_workflow_status.execute(
			{},
			sessionID ? { directory, sessionID } : { directory },
		),
	) as StatusShape;
}

/** Raw pending base lane owned by SESSION_ID; `torn` adds the broken manifest. */
function writeRawLaneStore(torn: boolean): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		`${JSON.stringify({
			schemaVersion: 1,
			correlationId: OTHER_SESSION_ID,
			jobId: null,
			subagentSessionId: OTHER_SESSION_ID,
			parentSessionId: SESSION_ID,
			callID: 'call_r11',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			status: 'pending',
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW,
			batchId: 'r11-batch',
			laneId: 'r11-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0],
			promptHash: 'r'.repeat(24),
		})}\n`,
		'utf-8',
	);
	if (torn) {
		fs.writeFileSync(
			path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			'{"schemaVersion": 1, "sequence": ',
			'utf-8',
		);
	}
}

async function submitFrom(childSessionId: string) {
	const workflowLane = PR_REVIEW_BASE_DIMENSION_IDS[0]!;
	return parsed(
		await executeSubmitPrReviewResult(
			{
				schemaVersion: 1,
				revisionDigest: SUBMIT_DIGEST,
				result: {
					schemaVersion: 1,
					outcome: 'CLEAN',
					creditedLanes: [workflowLane],
					findings: [],
					cleanAttestations: [
						{
							workflowLane,
							coverageScope: 'the exact reviewed diff for the lane',
							evidence: 'no actionable defect found',
						},
					],
					unresolved: [],
				},
			},
			directory,
			{ sessionID: childSessionId },
		),
	);
}

function triggerRows(evidence: string) {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) => ({
		trigger_id: definition.id,
		result: 'MATCHED',
		evidence: `${evidence} ${definition.id}`,
		source_batch_id: `micro-batch-${Math.floor(index / 8)}`,
		source_lane_id: `lane-${index}`,
	}));
}

async function runTriggerEval(runId: string, evidence: string) {
	return parsed(
		await executeWritePrReviewTriggerEval(
			{
				run_id: runId,
				pr_head_sha: BOUND_HEAD,
				base_ref: 'origin/main',
				base_sha: BASE_SHA,
				rows: triggerRows(evidence),
			},
			directory,
			{ sessionID: SESSION_ID },
		),
	);
}

/** Bound gate with settled base coverage and a frozen ledger: reaches the digest step. */
async function establishGateAtDigestStep(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: BOUND_HEAD,
	});
	const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, lanes, {
		batchId: 'r11-base',
		prHeadSha: BOUND_HEAD,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistPrReviewBatch(
		directory,
		'r11-base',
		'swarm-pr-review:base',
		lanes,
	);
	await bindPrReviewTriggerLedger(
		directory,
		SESSION_ID,
		PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => ({
			trigger_id: definition.id,
			result: 'MATCHED',
			evidence: `mandatory review focus for ${definition.id}`,
		})),
	);
}

beforeEach(async () => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = canonicalMkdtemp('pr-review-r11-denial-');
	await initializeGitRepository(directory);
	gate.resetTrackedStateCache();
	gate.resolveCurrentGitHead = () => BOUND_HEAD;
	gate.resolveCurrentGitHeadAsync = async () =>
		gate.resolveCurrentGitHead(directory);
	gate.resolvePrWorkflowRevisionDigest = () => PR_ARTIFACT_REVISION_DIGEST;
	gate.resolveIsWorkingTreeClean = () => true;
	gate.resolveIsWorkingTreeCleanAsync = async () => true;
	gate.resolvePrReviewDiffStats = () => ({
		changedLines: 40,
		changedFiles: 4,
		hasSubmoduleChange: false,
	});
	gate.resolvePrReviewDiffStatsAsync = async (...args) =>
		gate.resolvePrReviewDiffStats(...args);
	gate.getSessionOps = () => null;
	writerInternals.resolveMergeBase = () => BASE_SHA;
	statusInternals.resolveCurrentGitHeadAsync = async () => BOUND_HEAD;
	statusInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	gate.resetTrackedStateCache();
	gate.resolveCurrentGitHead = ORIGINALS.head;
	gate.resolveCurrentGitHeadAsync = ORIGINALS.headAsync;
	gate.resolvePrWorkflowRevisionDigest = ORIGINALS.revision;
	gate.resolveIsWorkingTreeClean = ORIGINALS.clean;
	gate.resolveIsWorkingTreeCleanAsync = ORIGINALS.cleanAsync;
	gate.resolvePrReviewDiffStats = ORIGINALS.diffStats;
	gate.resolvePrReviewDiffStatsAsync = ORIGINALS.diffStatsAsync;
	gate.getSessionOps = ORIGINALS.sessionOps;
	writerInternals.resolvePrWorkflowRevisionDigest = ORIGINALS.writerDigest;
	writerInternals.resolveMergeBase = ORIGINALS.writerMergeBase;
	statusInternals.resolveCurrentGitHeadAsync = ORIGINALS.statusHead;
	statusInternals.resolveIsWorkingTreeCleanAsync = ORIGINALS.statusClean;
	closeAllProjectDbs();
	await fs.promises.rm(directory, { recursive: true, force: true });
	restoreClock?.();
});

describe('R11 head rebind refusal — names both SHAs, never rebinds silently, abort reachable', () => {
	test('a moved checkout cannot rebind the active workflow: the refusal names the bound AND received heads', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		gate.resolveCurrentGitHead = () => 'c'.repeat(40);
		let rebindRefusal = '';
		try {
			await bindPrWorkflowHead(directory, SESSION_ID, 'c'.repeat(40));
		} catch (error) {
			rebindRefusal = (error as Error).message;
		}
		expect(rebindRefusal).toMatch(
			/active PR_REVIEW workflow is bound to PR head "abc123"; received "c{40}"/,
		);
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prHeadSha).toBe(BOUND_HEAD);
	});

	test('distinct category: binding a head the checkout is NOT on names the mismatch and its own remediation', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		let mismatchRefusal = '';
		try {
			await bindPrWorkflowHead(directory, SESSION_ID, 'c'.repeat(40));
		} catch (error) {
			mismatchRefusal = (error as Error).message;
		}
		expect(mismatchRefusal).toMatch(
			/current checkout HEAD "abc123" does not match PR head "c{40}"/,
		);
		// The next step is executable: a bare, standalone switch command.
		expect(mismatchRefusal).toContain(`git switch --detach ${'c'.repeat(40)}`);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();
	});

	test('repair stays reachable: a recovery abort clears the refused workflow', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		const abort = parsed(
			await executeAbortPrWorkflow(
				{
					mode: 'PR_REVIEW',
					kind: 'recovery',
					reason: 'rebind refused; abandoning this run for a fresh checkout',
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(abort).toMatchObject({
			success: true,
			mode: 'PR_REVIEW',
			gate_cleared: true,
		});
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});
});

describe('R11 trigger-eval digest failure — enumerated causes + bounded retry ladder', () => {
	test('the resolution retry is bounded: measured attempts equal the disclosed figure, and the failure names causes + recovery', async () => {
		await establishGateAtDigestStep();
		let digestCalls = 0;
		writerInternals.resolvePrWorkflowRevisionDigest = () => {
			digestCalls += 1;
			return null;
		};

		const result = await runTriggerEval(
			'r11-digest-run',
			'mandatory review focus for',
		);

		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(digestCalls).toBe(2);
		expect(message).toContain('after 2 attempts');
		expect(message).toContain('timed out');
		expect(message).toContain('failed to spawn');
		expect(message).toContain('working tree could not be read');
		expect(message).toContain('unsafe revision token');
		expect(message).toContain('retryable as-is');
		expect(message).toContain('abort_pr_workflow');
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'pr-review', 'r11-digest-run'),
			),
		).toBe(false);
	});
});

describe('R11 unreadable store — typed uncertainty, never a misleading found-0', () => {
	test('submit_pr_review_result rejects with the typed unreadable reason', async () => {
		writeRawLaneStore(true);
		const result = await submitFrom(OTHER_SESSION_ID);
		expect(result.success).toBe(false);
		expect(result.status).toBe('rejected');
		expect(String(result.reason)).toMatch(/unreadable after 2 attempts/i);
		expect(String(result.reason)).not.toMatch(/found 0/);
	});

	test('distinct category: a READABLE store with no such child says found 0 truthfully', async () => {
		writeRawLaneStore(false);
		const result = await submitFrom('ses_r11_someone_else');
		expect(result.success).toBe(false);
		expect(result.status).toBe('rejected');
		expect(String(result.reason)).toBe(
			'expected one exact child delegation, found 0',
		);
	});
});

describe('R11 pr_workflow_status — truthful current / stale / unknown', () => {
	test('current: an active bound gate reports the bound head and a healthy store', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		const result = await status(SESSION_ID);
		expect(result.gate).toMatchObject({
			active: true,
			prHeadBound: true,
			prHeadSha: BOUND_HEAD,
		});
		expect(result.git.head).toBe(BOUND_HEAD);
		expect(result.recovery.controllerSessionID).toBe(SESSION_ID);
		expect(result.recovery.delegationRead.state).toBe('ok');
		expect(result.recovery.lastProgress?.revision).toBeGreaterThanOrEqual(1);
		expect(result.nextStep).toMatch(/gate active and head bound/);
	});

	test('stale: a gate bound to a head the checkout has left reports BOTH heads, not "current"', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		statusInternals.resolveCurrentGitHeadAsync = async () => 'c'.repeat(40);
		const result = await status(SESSION_ID);
		expect(result.gate.active).toBe(true);
		expect(result.gate.prHeadSha).toBe(BOUND_HEAD);
		expect(result.git.head).toBe('c'.repeat(40));
		expect(result.git.head === result.gate.prHeadSha).toBe(false);
	});

	test('unknown: an unreadable store is typed uncertain with a repair next step, and the read-only tool never throws', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		writeRawLaneStore(true);
		const result = await status(SESSION_ID);
		expect(result.success).toBe(true);
		expect(result.recovery.delegationRead.state).toBe('uncertain');
		expect(result.recovery.delegationRead.reasonCode).toBeTruthy();
		expect(result.recovery.nextStep).toMatch(
			/^Delegation store read is uncertain: repair the store/,
		);
		expect(result.recovery.nextStep).toContain('abort via abort_pr_workflow');
	});

	test('no session context is its own typed reason, not an error', async () => {
		const result = await status(undefined);
		expect(result.success).toBe(true);
		expect(result.sessionID).toBeNull();
		expect(result.gate).toEqual({
			active: false,
			reason: 'no-session-context',
		});
	});
});

describe('R11 distinct failure categories produce distinct messages', () => {
	test('the ordinary denial messages never share a text', async () => {
		const movedHead = 'c'.repeat(40);
		const messages: string[] = [];

		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		gate.resolveCurrentGitHead = () => movedHead;
		try {
			await bindPrWorkflowHead(directory, SESSION_ID, movedHead);
			throw new Error('expected the rebind to be refused');
		} catch (error) {
			if ((error as Error).message.startsWith('expected')) throw error;
			messages.push(`rebind: ${(error as Error).message}`);
		}
		gate.resolveCurrentGitHead = () => BOUND_HEAD;

		await establishGateAtDigestStep();
		writerInternals.resolvePrWorkflowRevisionDigest = () => null;
		messages.push(
			`digest: ${(await runTriggerEval('r11-distinct-run', 'focus')).message}`,
		);

		writeRawLaneStore(true);
		messages.push(`unreadable: ${(await submitFrom(OTHER_SESSION_ID)).reason}`);
		messages.push(
			`found0: ${(await submitFrom('ses_r11_someone_else')).reason}`,
		);
		messages.push(
			`no-gate: ${
				parsed(
					await executeCompletePrWorkflow(
						{
							mode: 'PR_REVIEW',
							pr_head_sha: BOUND_HEAD,
							report_verdict: 'INCOMPLETE',
						},
						directory,
						{ sessionID: 'ses_r11_never_activated' },
					),
				).message
			}`,
		);

		expect(messages).toHaveLength(5);
		expect(new Set(messages).size).toBe(5);
	});
});
