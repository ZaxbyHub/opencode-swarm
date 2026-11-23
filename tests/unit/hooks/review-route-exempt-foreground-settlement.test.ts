/**
 * Foreground (toolAfter) settlement site of the durable test-engineer
 * exemption. The dispatch-time route receipt lists a test-engineer slot (a
 * pre-fix allocation, or a fail-open complexity fallback); at settlement the
 * reviewer-only completion must be accepted ONLY when the durable evidence is
 * exempt per the shared predicate (flag true AND test_engineer not in
 * required_gates). Twin of the background site pinned in
 * tests/unit/background/stage-b-doc-only.test.ts.
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (never the developer's real app-data).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { readReviewRouteReceipt } from '../../../src/review/routing-enforcement';
import {
	advanceTaskState,
	getStageBRouteEvidence,
	getTaskState,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import { ensureSessionDrained } from './_session-rehydration-drain';

const SESSION = 'sess-exempt-fg';
const TASK = '1.1';

const config = (): PluginConfig =>
	({ hooks: { delegation_gate: true } }) as unknown as PluginConfig;

const reviewerArgs = {
	subagent_type: 'reviewer',
	prompt: `TASK: ${TASK} review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
};
const reviewed = `[REVIEWED] | task-${TASK} | APPROVED | foreground exempt fixture`;

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
const dirs: string[] = [];

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	for (const dir of dirs.splice(0)) {
		closeAllProjectDbs();
		removeTreeWithRetry(dir);
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/** Non-exempt task at pre_check_passed (the dispatch will list a TE slot). */
async function fixture(): Promise<string> {
	const dir = canonicalMkdtemp('route-exempt-fg-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'foreground exempt settlement',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: TASK,
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Exercise the gate',
							depends: [],
							files_touched: ['src/foo.ts'],
						},
					],
				},
			],
		}),
	);
	await ensureSessionDrained(SESSION, dir);
	await transitionTaskWorkflowEvidence(dir, TASK, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${TASK}`,
	});
	await transitionTaskWorkflowEvidence(dir, TASK, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${TASK}`,
	});
	const session = swarmState.agentSessions.get(SESSION)!;
	advanceTaskState(session, TASK, 'coder_delegated');
	advanceTaskState(session, TASK, 'pre_check_passed');
	recordModifiedFilesForTask(session, TASK, ['src/foo.ts'], dir);
	return dir;
}

/** Rewrite durable evidence AFTER dispatch so the receipt keeps its TE slot. */
function setDurableExemption(dir: string, requiredGates: string[]): void {
	const file = path.join(dir, '.swarm', 'evidence', `${TASK}.json`);
	const evidence = JSON.parse(fs.readFileSync(file, 'utf-8'));
	evidence.test_engineer_exempt = true;
	evidence.required_gates = requiredGates;
	fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
}

/** Dispatch the reviewer through the given hook (one instance, as in production). */
async function dispatch(
	hook: ReturnType<typeof createDelegationGateHook>,
	dir: string,
	callID: string,
): Promise<void> {
	await hook.toolBefore(
		{ tool: 'Task', sessionID: SESSION, callID },
		{ args: reviewerArgs },
	);
	const receipt = await readReviewRouteReceipt({
		projectRoot: dir,
		sessionId: SESSION,
		taskId: TASK,
	});
	// The pre-fix shape this site exists for: the receipt lists a TE slot.
	expect(receipt?.kind).toBe('review_route_receipt');
	if (receipt?.kind === 'review_route_receipt') {
		expect(receipt.required.testEngineers).toBe(1);
	}
	await hook.taskMetadata({
		callID,
		parentSessionID: SESSION,
		childSessionID: `child-${callID}`,
	});
}

describe('foreground settlement — durable test-engineer exemption', () => {
	it('exempt evidence + TE-listing receipt: the reviewer-only completion is accepted and the task advances to tests_run', async () => {
		const dir = await fixture();
		const hook = createDelegationGateHook(config(), dir);
		await dispatch(hook, dir, 'call-fg-exempt');
		setDurableExemption(dir, ['reviewer']);
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: SESSION,
				callID: 'call-fg-exempt',
				args: reviewerArgs,
			},
			{ text: reviewed },
		);

		const session = swarmState.agentSessions.get(SESSION)!;
		expect(getTaskState(session, TASK)).toBe('tests_run');
		expect(getStageBRouteEvidence(session, TASK).length).toBe(1);
		const evidence = await readTaskEvidence(dir, TASK);
		expect(evidence?.workflow.state).toBe('tests_run');
	});

	it('flag true but test_engineer in required_gates: the reviewer-only completion is NOT accepted as complete', async () => {
		const dir = await fixture();
		const hook = createDelegationGateHook(config(), dir);
		await dispatch(hook, dir, 'call-fg-te-required');
		setDurableExemption(dir, ['reviewer', 'test_engineer']);
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: SESSION,
				callID: 'call-fg-te-required',
				args: reviewerArgs,
			},
			{ text: reviewed },
		);

		const session = swarmState.agentSessions.get(SESSION)!;
		expect(getTaskState(session, TASK)).not.toBe('tests_run');
		const evidence = await readTaskEvidence(dir, TASK);
		expect(evidence?.workflow.state).not.toBe('tests_run');
	});
});
