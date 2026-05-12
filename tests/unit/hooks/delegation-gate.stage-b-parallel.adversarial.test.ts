/**
 * Adversarial tests for standard config-driven Stage B parallelization.
 *
 * ATTACK VECTORS:
 * 1. Missing standard parallelization config keeps the conservative default.
 * 2. Parallel barrier remains order-independent when enabled.
 * 3. Conditional adversarial test_engineer is a first-class required gate.
 * 4. Stage B completion state remains task- and session-scoped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensureAgentSession,
	hasBothStageBCompletions,
	recordStageBCompletion,
	requireStageBGate,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	checkReviewerGate,
	checkReviewerGateWithScope,
} from '../../../src/tools/update-task-status';

async function createTempPlan(): Promise<string> {
	const tempDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'stage-b-adversarial-')),
	);
	await fs.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
	await fs.writeFile(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Test task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
	return tempDir;
}

async function writeProjectParallelizationConfig(
	tempDir: string,
	enabled: boolean,
): Promise<void> {
	await fs.mkdir(path.join(tempDir, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(
			{
				parallelization: {
					enabled,
					maxConcurrentTasks: 4,
					max_coders: 3,
					max_reviewers: 2,
					evidenceLockTimeoutMs: 60000,
				},
			},
			null,
			2,
		),
	);
}

describe('Stage B config-driven parallel barrier', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await createTempPlan();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		resetSwarmState();
	});

	it('checkReviewerGateWithScope uses the standard runtime config default', async () => {
		const session = ensureAgentSession('scope-default');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		const result = await checkReviewerGateWithScope('1.1', tempDir);

		expect(result.blocked).toBe(false);
	});

	it('blocks with parallel flag disabled until sequential state reaches tests_run', () => {
		const session = ensureAgentSession('flag-disabled');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		swarmState.agentSessions.set('flag-disabled', session);

		const disabledResult = checkReviewerGate('1.1', tempDir, false);
		expect(disabledResult.blocked).toBe(true);

		session.taskWorkflowStates.set('1.1', 'tests_run');
		const sequentialReady = checkReviewerGate('1.1', tempDir, false);
		expect(sequentialReady.blocked).toBe(false);
	});

	it('project config parallelization.enabled=false disables marker-only scoped completion', async () => {
		await writeProjectParallelizationConfig(tempDir, false);
		const session = ensureAgentSession('project-disabled');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		const blocked = await checkReviewerGateWithScope('1.1', tempDir);
		expect(blocked.blocked).toBe(true);

		session.taskWorkflowStates.set('1.1', 'tests_run');
		const allowed = await checkReviewerGateWithScope('1.1', tempDir);
		expect(allowed.blocked).toBe(false);
	});

	it('allows reverse completion order when the parallel barrier is enabled', () => {
		const session = ensureAgentSession('reverse-order');

		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);

		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	it('requires conditional adversarial test_engineer completion when marked required', () => {
		const session = ensureAgentSession('adversarial-required');
		requireStageBGate(session, '1.1', 'adversarial_test_engineer');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);

		recordStageBCompletion(session, '1.1', 'adversarial_test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	it('does not allow an earlier session to pass before a later adversarial requirement is seen', () => {
		const earlySession = ensureAgentSession('early-session');
		earlySession.taskWorkflowStates = new Map([['1.1', 'tests_run']]);
		recordStageBCompletion(earlySession, '1.1', 'reviewer');
		recordStageBCompletion(earlySession, '1.1', 'test_engineer');

		const laterSession = ensureAgentSession('later-session');
		laterSession.taskWorkflowStates = new Map([['1.1', 'reviewer_run']]);
		requireStageBGate(laterSession, '1.1', 'adversarial_test_engineer');

		const blocked = checkReviewerGate('1.1', tempDir, true);

		expect(blocked.blocked).toBe(true);
		expect(blocked.reason).toContain('later-session: reviewer_run');
	});

	it('handles rapid same-task Stage B completion recording idempotently', () => {
		const session = ensureAgentSession('rapid-completion');

		for (let i = 0; i < 50; i++) {
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');
		}

		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
		expect(session.stageBCompletion?.get('1.1')?.size).toBe(2);
	});

	it('keeps interleaved Stage B completions isolated across tasks', () => {
		const session = ensureAgentSession('interleaved-completions');

		for (const [taskId, gate] of [
			['1.1', 'reviewer'],
			['1.2', 'test_engineer'],
			['1.1', 'test_engineer'],
			['1.2', 'reviewer'],
		] as const) {
			recordStageBCompletion(session, taskId, gate);
		}

		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
		expect(hasBothStageBCompletions(session, '1.2')).toBe(true);
		expect(hasBothStageBCompletions(session, '1.3')).toBe(false);
	});

	it('completion state is isolated by task and session', () => {
		const sessionA = ensureAgentSession('session-a');
		const sessionB = ensureAgentSession('session-b');

		recordStageBCompletion(sessionA, '1.1', 'reviewer');
		recordStageBCompletion(sessionA, '1.1', 'test_engineer');
		recordStageBCompletion(sessionB, '1.1', 'reviewer');
		recordStageBCompletion(sessionA, '1.2', 'reviewer');

		expect(hasBothStageBCompletions(sessionA, '1.1')).toBe(true);
		expect(hasBothStageBCompletions(sessionB, '1.1')).toBe(false);
		expect(hasBothStageBCompletions(sessionA, '1.2')).toBe(false);
	});
});
