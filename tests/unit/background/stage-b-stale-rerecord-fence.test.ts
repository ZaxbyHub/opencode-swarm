/**
 * PR 3919 closeout fence: the background completion's re-record of its
 * captured route binding must never clobber a NEWER settlement that landed
 * while collectReviewerReceiptFromTranscript awaited.
 *
 * The ingestion sequence (src/background/stage-b-gates.ts) is: reserve the
 * route slot → durable recordGateEvidence → settle the reservation →
 * `await collectReviewerReceiptFromTranscript(...)` → applyStageBStateCompletion,
 * which re-records the binding captured in `preparedRoute`. A concurrent
 * settlement of the same gate cycle (fresh re-dispatch, same identity, newer
 * call/child/generation) can replace the slot's live binding during that
 * await; the stale re-record then overwrote it (same-identity replacement),
 * destroying the newer settlement's live evidence.
 *
 * Determinism note (per the writing-tests skill): the regression drives the
 * designated `_test_exports.applyStageBStateCompletion` seam with the exact
 * post-await state — the stale `preparedRoute` computed before the interleave,
 * and the newer settlement already settled into the live array. The await's
 * only observable effect on this function is that preparedRoute is stale
 * relative to live, so no timing injection is needed; the untested branch is
 * the microtask interleaving itself, which cannot be scheduled deterministically
 * without counting internal awaits.
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (never the developer's real app-data).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _test_exports } from '../../../src/background/stage-b-gates';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import type { ReviewRouteEvidence } from '../../../src/review/routing-enforcement';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import {
	getSettledStageBRouteEvidence,
	getStageBRouteEvidence,
	getTaskState,
	recordStageBRouteEvidence,
	reserveStageBRouteEvidence,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { ensureSessionDrained } from '../hooks/_session-rehydration-drain';

const SESSION = 'parent-fence';
const TASK = '1.20';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

const reviewerBinding = (
	callId: string,
	childSessionId: string,
	generation: number,
): ReviewRouteEvidence => ({
	role: 'reviewer',
	identity: `${TASK}:reviewer:1`,
	sessionId: SESSION,
	taskId: TASK,
	slotId: `${TASK}:reviewer:1`,
	callId,
	childSessionId,
	generation,
});

let testDirectory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

describe('background Stage-B stale re-record fence (PR 3919 closeout)', () => {
	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		testDirectory = canonicalMkdtemp('stage-b-rerecord-fence-');
		git(testDirectory, ['init']);
		git(testDirectory, ['config', 'user.email', 'tests@example.com']);
		git(testDirectory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(testDirectory, 'AGENTS.md'), '# docs rule\n');
		git(testDirectory, ['add', 'AGENTS.md']);
		git(testDirectory, ['commit', '-m', 'test: seed repository']);
		// Durable exempt workflow at reviewer_run (the unwedging scenario the
		// re-dispatch path exists for), plus the fresh exemption-aware receipt
		// the re-dispatch's dispatch time persists.
		await ensureSessionDrained(SESSION, testDirectory);
		await transitionTaskWorkflowEvidence(testDirectory, TASK, {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { testEngineerExempt: true },
			expectedGeneration: 0,
			transitionId: `fence-coder:${TASK}`,
		});
		await transitionTaskWorkflowEvidence(testDirectory, TASK, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `fence-stage-a:${TASK}`,
		});
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: SESSION,
				taskId: TASK,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: [`${TASK}:reviewer:1`],
				requiredTestEngineers: [],
			}),
		});
		const session = swarmState.agentSessions.get(SESSION)!;
		session.taskWorkflowStates?.set(TASK, 'reviewer_run');
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(testDirectory, { recursive: true, force: true });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	test('a newer settlement that lands during the reviewer-receipt await survives the stale re-record', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		// The in-flight dispatch A: reserved before the await and settled
		// after its durable write (exactly what the ingestion leaves behind).
		const bindingA = reviewerBinding('call-a', 'child-a', 1);
		recordStageBRouteEvidence(session, TASK, bindingA);
		// preparedRoute is computed BEFORE the await (live still holds A).
		const preparedRoute = _test_exports.resolveBackgroundStageBRoute({
			directory: testDirectory,
			taskId: TASK,
			parentSessionId: SESSION,
			role: 'reviewer',
			callId: 'call-a',
			childSessionId: 'child-a',
			generation: 1,
			session,
		});
		expect(preparedRoute.binding).toMatchObject({ callId: 'call-a' });

		// The interleave: a NEWER settlement of the same gate cycle replaces
		// the slot's live binding while dispatch A's completion awaits the
		// reviewer receipt collection.
		const bindingB = reviewerBinding('call-b', 'child-b', 2);
		recordStageBRouteEvidence(session, TASK, bindingB);

		_test_exports.applyStageBStateCompletion(
			TASK,
			'reviewer',
			SESSION,
			true,
			testDirectory,
			'call-a',
			'child-a',
			1,
			preparedRoute,
		);

		// The newer settlement owns the slot: the stale captured binding (A)
		// must NOT overwrite it. Prior behavior: live collapsed to bindingA.
		const live = getStageBRouteEvidence(session, TASK);
		expect(live).toHaveLength(1);
		expect(live[0]).toEqual(bindingB);
		// The completion still records and advances on the LIVE evidence —
		// the fence skips only the stale write, not the settlement.
		expect(getTaskState(session, TASK)).toBe('tests_run');
	});

	test('a pending sibling reservation cannot satisfy the advancement barrier', async () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const evidencePath = path.join(
			testDirectory,
			'.swarm',
			'evidence',
			`${TASK}.json`,
		);
		const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
		evidence.test_engineer_exempt = false;
		fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: SESSION,
				taskId: TASK,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: [`${TASK}:reviewer:1`],
				requiredTestEngineers: [`${TASK}:test_engineer:1`],
			}),
		});
		const bindingA = reviewerBinding('call-a', 'child-a', 1);
		recordStageBRouteEvidence(session, TASK, bindingA);
		const preparedRoute = _test_exports.resolveBackgroundStageBRoute({
			directory: testDirectory,
			taskId: TASK,
			parentSessionId: SESSION,
			role: 'reviewer',
			callId: 'call-a',
			childSessionId: 'child-a',
			generation: 1,
			session,
		});
		const pendingB = reserveStageBRouteEvidence(session, TASK, {
			role: 'test_engineer',
			identity: `${TASK}:test_engineer:1`,
			sessionId: SESSION,
			taskId: TASK,
			slotId: `${TASK}:test_engineer:1`,
			callId: 'call-b',
			childSessionId: 'child-b',
			generation: 1,
		});
		expect(pendingB).not.toBeNull();

		_test_exports.applyStageBStateCompletion(
			TASK,
			'reviewer',
			SESSION,
			false,
			testDirectory,
			'call-a',
			'child-a',
			1,
			preparedRoute,
		);

		expect(getSettledStageBRouteEvidence(session, TASK)).toEqual([bindingA]);
		expect(getTaskState(session, TASK)).toBe('reviewer_run');
		pendingB?.();
		expect(getTaskState(session, TASK)).toBe('reviewer_run');
	});

	test('control: without an interleave the re-record still lands (exact-tuple match)', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const bindingA = reviewerBinding('call-a', 'child-a', 1);
		recordStageBRouteEvidence(session, TASK, bindingA);
		const preparedRoute = _test_exports.resolveBackgroundStageBRoute({
			directory: testDirectory,
			taskId: TASK,
			parentSessionId: SESSION,
			role: 'reviewer',
			callId: 'call-a',
			childSessionId: 'child-a',
			generation: 1,
			session,
		});

		_test_exports.applyStageBStateCompletion(
			TASK,
			'reviewer',
			SESSION,
			true,
			testDirectory,
			'call-a',
			'child-a',
			1,
			preparedRoute,
		);

		const live = getStageBRouteEvidence(session, TASK);
		expect(live).toHaveLength(1);
		expect(live[0]).toEqual(bindingA);
		expect(getTaskState(session, TASK)).toBe('tests_run');
	});
});
