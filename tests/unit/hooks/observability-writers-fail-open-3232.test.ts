/**
 * Issue #3232 defect-class guardrail (trace
 * 3231-3232-observability-append-integrity, Phase 4.2 Class A): every
 * observability writer on the PR-workflow gate state is documented
 * fail-open / best-effort — "any error drops the append silently". This
 * suite pins that contract for ALL FOUR writers under the one failure mode
 * whose protective `try` placement historically escaped the boundary: the
 * session-state mutation LOCK cannot be acquired (live owner holds it for
 * the full 50 x 10 ms budget, so `withSessionStateMutation` throws BLOCKED
 * before the callback runs).
 *
 * `appendPrWorkflowSkillContractAdvisories` was the defect (#3232 — its
 * `try` sat inside the callback); the three rejection/marker writers were
 * already correct and are pinned here against future drift.
 *
 * Every leg asserts BOTH halves: the call resolves without throwing AND the
 * durable state is untouched (revision, append generation, and the writer's
 * own observability field).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordPendingDelegationDetailed } from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	appendPrWorkflowSkillContractAdvisories,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recordPrFeedbackBaseMismatch,
	recordPrReviewSubmitRejection,
	recordPrReviewVerdictRejection,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-11-06T00:00:00.000Z';
/** Inert planted-lock timestamp (liveness reclamation is pid-keyed). */
const PLANTED_LOCK_CREATED_AT_MS = 1_762_387_200_000;

const tempDirs: string[] = [];

function freshProject(prefix: string, mode: 'PR_REVIEW' | 'PR_FEEDBACK') {
	const directory = canonicalMkdtemp(`sw3232fo-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	const stateFile = join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(`${prefix}-session`)}.json`,
	);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 3,
			sessionID: `${prefix}-session`,
			mode,
			activatedAt: NOW,
			updatedAt: NOW,
		}),
		'utf8',
	);
	return directory;
}

/** Plant a live-owner mutation lock so acquire exhausts 50 x 10 ms. */
function plantLiveLock(directory: string, session: string): void {
	writeFileSync(
		join(
			directory,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(session)}.lock`,
		),
		JSON.stringify({
			ownerToken: `live-owner-${session}`,
			pid: process.pid,
			createdAtMs: PLANTED_LOCK_CREATED_AT_MS,
		}),
		'utf8',
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows: the SQLite WAL may briefly hold the temp dir; best-effort.
		}
	}
});

test('fail-open under lock exhaustion: skill-contract advisory append (the #3232 defect)', async () => {
	const directory = freshProject('advisory', 'PR_REVIEW');
	const session = 'advisory-session';
	await readPrWorkflowGateState(directory, session);
	plantLiveLock(directory, session);
	await expect(
		appendPrWorkflowSkillContractAdvisories(directory, session, [
			'class-guardrail advisory',
		]),
	).resolves.toBeUndefined();
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.revision).toBe(3);
	expect(after?.observabilityRevision).toBeUndefined();
	expect(after?.skillContractAdvisories ?? []).not.toContain(
		'class-guardrail advisory',
	);
});

test('fail-open under lock exhaustion: PR_FEEDBACK base-mismatch marker writer', async () => {
	const directory = freshProject('basemismatch', 'PR_FEEDBACK');
	const session = 'basemismatch-session';
	await readPrWorkflowGateState(directory, session);
	plantLiveLock(directory, session);
	await expect(
		recordPrFeedbackBaseMismatch(
			directory,
			session,
			`${'b'.repeat(40)}`,
			`${'c'.repeat(40)}`,
		),
	).resolves.toBeUndefined();
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.revision).toBe(3);
	expect(after?.observabilityRevision).toBeUndefined();
	expect(after?.prFeedbackStageABaseMismatch).toBeUndefined();
});

test('fail-open under lock exhaustion: submit-rejection journal writer', async () => {
	const directory = freshProject('submitrej', 'PR_REVIEW');
	const session = 'submitrej-session';
	await readPrWorkflowGateState(directory, session);
	// The submit journal resolves the PARENT gate session from the pending
	// delegation ledger (seeding pattern: collect-lanes-submit-rejection-
	// visibility-2859.test.ts); without a record the writer returns before
	// ever taking the lock and the leg would be vacuous.
	const outcome = await recordPendingDelegationDetailed(directory, {
		correlationId: 'child-3232',
		jobId: null,
		subagentSessionId: 'child-3232',
		parentSessionId: session,
		callID: 'call-3232-fo',
		normalizedAgent: 'swarm_explorer',
		swarmPrefixedAgent: 'swarm_explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-3232-fo',
		laneId: 'lane-3232-fo',
		mode: 'swarm-pr-review:base',
		workflowLane: 'correctness-state',
		prReviewLegacyTranscriptCompatibility: false,
		promptHash: null,
		workspace: {
			directory,
			gitHead: 'head-3232',
			dirtyHash: null,
			prHeadSha: 'head-3232',
			scope: 'complete PR diff base...head',
		},
	});
	expect(outcome.status).toBe('recorded');
	plantLiveLock(directory, session);
	await expect(
		recordPrReviewSubmitRejection(directory, 'child-3232', 'rejection message'),
	).resolves.toBeUndefined();
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.revision).toBe(3);
	expect(after?.observabilityRevision).toBeUndefined();
	expect(
		(after?.prReviewSubmitRejections ?? []).some(
			(entry) => entry.childSessionId === 'child-3232',
		),
	).toBe(false);
});

test('fail-open under lock exhaustion: verdict-rejection journal writer', async () => {
	const directory = freshProject('verdictrej', 'PR_REVIEW');
	const session = 'verdictrej-session';
	await readPrWorkflowGateState(directory, session);
	plantLiveLock(directory, session);
	await expect(
		recordPrReviewVerdictRejection(directory, session, 'verdict rejection', {
			laneId: 'lane-3232',
		}),
	).resolves.toBeUndefined();
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.revision).toBe(3);
	expect(after?.observabilityRevision).toBeUndefined();
	expect(
		(after?.prReviewVerdictRejections ?? []).some(
			(entry) => entry.message === 'verdict rejection',
		),
	).toBe(false);
});
