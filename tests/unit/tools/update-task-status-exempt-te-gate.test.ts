/**
 * Completion-gate pin for the shared durable test-engineer exemption
 * predicate (isTestEngineerDurablyExempt): routeGateAllowsTask (reached via
 * checkReviewerGate) zeroes test-engineer route completeness only when the
 * durable flag is true AND test_engineer is NOT in required_gates.
 *
 * The flag is recomputed only on coder events while required_gates only
 * grows, so "flag true + test_engineer required" is a reachable state. It
 * must still demand test-engineer route completeness.
 *
 * Env isolation: createIsolatedTestEnv redirects the app-data root the
 * route-receipt MAC secret lives under.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readTaskEvidenceRaw,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement';
import {
	markStageBRouteRequired,
	recordStageBRouteEvidence,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	_internals,
	checkReviewerGate,
} from '../../../src/tools/update-task-status';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SESSION = 'parent-exempt-gate';

let directory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	directory = canonicalMkdtemp('exempt-te-gate-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	startAgentSession(SESSION, 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	removeTreeWithRetry(directory);
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/**
 * Seed a Markdown-only (exempt) coder task whose workflow reached tests_run
 * with reviewer proof. With `testEngineerRequired`, a test_engineer gate is
 * then recorded: required_gates grows to include test_engineer while the
 * durable exempt flag stays true (the reachable F-05 state).
 */
async function seedTask(
	taskId: string,
	testEngineerRequired: boolean,
): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		context: { testEngineerExempt: true },
		expectedGeneration: 0,
		transitionId: `coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${taskId}`,
	});
	await recordGateEvidence(
		directory,
		taskId,
		'reviewer',
		'reviewer-sess',
		false,
		{
			expectedGeneration: 1,
			transitionId: `reviewer:${taskId}`,
			routeComplete: !testEngineerRequired,
		},
	);
	if (testEngineerRequired) {
		await recordGateEvidence(
			directory,
			taskId,
			'test_engineer',
			'te-sess',
			false,
			{
				expectedGeneration: 1,
				transitionId: `te:${taskId}`,
				routeComplete: true,
			},
		);
	}
}

/** A route receipt that still lists one test-engineer slot, with reviewer-only live evidence. */
async function seedRoute(taskId: string): Promise<void> {
	await persistReviewRouteReceipt({
		projectRoot: directory,
		receipt: buildReviewRouteReceipt({
			sessionId: SESSION,
			taskId,
			complexity: 'single',
			semanticRisk: 'Standard complexity: 1 files, 0 functions',
			requiredReviewers: [`${taskId}:reviewer:1`],
			requiredTestEngineers: [`${taskId}:test_engineer:1`],
		}),
	});
	const session = swarmState.agentSessions.get(SESSION);
	if (!session) throw new Error('session missing');
	markStageBRouteRequired(session, taskId);
	recordStageBRouteEvidence(session, taskId, {
		role: 'reviewer',
		identity: `${taskId}:reviewer:1`,
		sessionId: SESSION,
		taskId,
		slotId: `${taskId}:reviewer:1`,
		callId: 'call-reviewer-1',
		childSessionId: 'child-reviewer-1',
		generation: 1,
	});
}

describe('checkReviewerGate — durable test-engineer exemption predicate', () => {
	test('flag true with required_gates [reviewer]: reviewer-only route evidence completes the gate', async () => {
		const taskId = '2.1';
		await seedTask(taskId, false);
		await seedRoute(taskId);

		const result = checkReviewerGate(taskId, directory, false, SESSION);

		expect(result.requiredGates).not.toContain('test_engineer');
		expect(result.blocked).toBe(false);
	});

	test('flag true but test_engineer in required_gates: test-engineer route completeness is still demanded', async () => {
		const taskId = '2.2';
		await seedTask(taskId, true);
		await seedRoute(taskId);

		const result = checkReviewerGate(taskId, directory, false, SESSION);

		// All required proof exists, so the only remaining blocker is the
		// route receipt's test-engineer slot, which the exemption must not
		// zero once test_engineer is a required gate.
		expect(result.requiredGates).toContain('test_engineer');
		expect(result.missingGates).toEqual(['review_route_receipt']);
		expect(result.blocked).toBe(true);
	});

	test('unreadable evidence inside the route gate fails closed (catch must not assume the exemption)', async () => {
		const taskId = '2.3';
		await seedTask(taskId, false);
		await seedRoute(taskId);
		const parsed = readTaskEvidenceRaw(directory, taskId);
		expect(parsed?.test_engineer_exempt).toBe(true);
		// checkReviewerGate reads via the _internals seam (stubbed to the good
		// parse); routeGateAllowsTask reads the file directly and now throws.
		const realRead = _internals.readTaskEvidenceRaw;
		_internals.readTaskEvidenceRaw = () => parsed;
		try {
			fs.writeFileSync(
				path.join(directory, '.swarm', 'evidence', `${taskId}.json`),
				'{corrupt',
			);
			const result = checkReviewerGate(taskId, directory, false, SESSION);
			expect(result.blocked).toBe(true);
			expect(result.missingGates).toEqual(['review_route_receipt']);
		} finally {
			_internals.readTaskEvidenceRaw = realRead;
		}
	});
});
