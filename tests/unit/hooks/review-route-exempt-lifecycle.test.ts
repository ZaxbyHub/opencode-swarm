/**
 * End-to-end lifecycle pins for the durable test-engineer exemption through
 * the real delegation-gate hook:
 *  - B: a zero-TE receipt allocated while exempt, then required_gates grows
 *    (a designer gate), must NOT let a reviewer-only settlement advance to
 *    tests_run; a reviewer re-dispatch rebuilds the receipt WITH a TE slot and
 *    the test engineer can then bind, settle and complete the task.
 *  - G: a pre-fix wedge (receipt lists a TE slot, durable reviewer_run, flag
 *    true) is unwedged by a reviewer re-dispatch.
 *  - H: a fail-open router-error receipt (no changed files) with the flag
 *    true but test_engineer required must not advance on reviewer-only.
 *
 * Env isolation: createIsolatedTestEnv redirects the app-data root the
 * route-receipt MAC secret lives under.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
	readReviewRouteReceipt,
} from '../../../src/review/routing-enforcement';
import {
	advanceTaskState,
	getTaskState,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import { ensureSessionDrained } from './_session-rehydration-drain';

const SESSION = 'sess-exempt-life';
const TASK = '1.1';
type Hook = ReturnType<typeof createDelegationGateHook>;

const config = (): PluginConfig =>
	({ hooks: { delegation_gate: true } }) as unknown as PluginConfig;
const argsFor = (agent: 'reviewer' | 'test_engineer') => ({
	subagent_type: agent,
	prompt: `TASK: ${TASK} ${agent} the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
});
const TEXT = {
	reviewer: `[REVIEWED] | task-${TASK} | APPROVED | lifecycle fixture`,
	test_engineer: `[TESTED] | task-${TASK} | PASS | lifecycle fixture`,
};

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

async function fixture(o: {
	exempt: boolean;
	recordFiles?: boolean;
}): Promise<string> {
	const dir = canonicalMkdtemp('route-exempt-life-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'exempt lifecycle',
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
		...(o.exempt ? { context: { testEngineerExempt: true } } : {}),
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
	if (o.recordFiles !== false) {
		recordModifiedFilesForTask(session, TASK, ['src/foo.ts'], dir);
	}
	return dir;
}

function editEvidence(dir: string, edit: (e: Record<string, unknown>) => void) {
	const file = path.join(dir, '.swarm', 'evidence', `${TASK}.json`);
	const evidence = JSON.parse(fs.readFileSync(file, 'utf-8'));
	edit(evidence);
	fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
}

async function dispatch(
	hook: Hook,
	dir: string,
	agent: 'reviewer' | 'test_engineer',
	callID: string,
): Promise<void> {
	await hook.toolBefore(
		{ tool: 'Task', sessionID: SESSION, callID },
		{ args: argsFor(agent) },
	);
	await hook.taskMetadata({
		callID,
		parentSessionID: SESSION,
		childSessionID: `child-${callID}`,
	});
}

const settle = (
	hook: Hook,
	agent: 'reviewer' | 'test_engineer',
	callID: string,
) =>
	hook.toolAfter(
		{
			tool: 'tool.execute.Task',
			sessionID: SESSION,
			callID,
			args: argsFor(agent),
		},
		{ text: TEXT[agent] },
	);

const state = () => getTaskState(swarmState.agentSessions.get(SESSION)!, TASK);

async function teSlots(dir: string): Promise<number | undefined> {
	const receipt = await readReviewRouteReceipt({
		projectRoot: dir,
		sessionId: SESSION,
		taskId: TASK,
	});
	return receipt?.kind === 'review_route_receipt'
		? receipt.required.testEngineers
		: undefined;
}

describe('exempt lifecycle through the delegation-gate hook', () => {
	it('B: zero-TE receipt + required_gates growth: reviewer-only is not accepted; re-dispatch gets a TE slot and the TE completes the task', async () => {
		const dir = await fixture({ exempt: true });
		const hook = createDelegationGateHook(config(), dir);
		await dispatch(hook, dir, 'reviewer', 'call-b1');
		expect(await teSlots(dir)).toBe(0);

		// A later designer gate grows required_gates to include test_engineer
		// while the exemption flag stays true.
		await recordGateEvidence(dir, TASK, 'designer', 'designer-sess', false, {
			expectedGeneration: 1,
			transitionId: 'designer:1.1',
		});
		const grown = await readTaskEvidence(dir, TASK);
		expect(grown?.test_engineer_exempt).toBe(true);
		expect(grown?.required_gates).toContain('test_engineer');

		await settle(hook, 'reviewer', 'call-b1');
		expect(state()).not.toBe('tests_run');
		expect(state()).toBe('reviewer_run');

		// Exit: the reviewer re-dispatch allocates a TE slot (not exempt now).
		await dispatch(hook, dir, 'reviewer', 'call-b2');
		expect(await teSlots(dir)).toBe(1);
		await settle(hook, 'reviewer', 'call-b2');
		expect(state()).toBe('reviewer_run');

		await dispatch(hook, dir, 'test_engineer', 'call-b3');
		await settle(hook, 'test_engineer', 'call-b3');
		expect(state()).toBe('tests_run');
		const gate = checkReviewerGate(TASK, dir, false, SESSION);
		expect(gate.blocked).toBe(false);
	});

	it('G: a pre-fix wedge (TE-listing receipt, durable reviewer_run, flag true) is unwedged by a reviewer re-dispatch', async () => {
		const dir = await fixture({ exempt: true });
		await persistReviewRouteReceipt({
			projectRoot: dir,
			receipt: buildReviewRouteReceipt({
				sessionId: SESSION,
				taskId: TASK,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: [`${TASK}:reviewer:1`],
				requiredTestEngineers: [`${TASK}:test_engineer:1`],
			}),
		});
		await recordGateEvidence(dir, TASK, 'reviewer', 'old-reviewer', false, {
			expectedGeneration: 1,
			transitionId: 'old-reviewer:1.1',
			routeComplete: false,
		});
		advanceTaskState(
			swarmState.agentSessions.get(SESSION)!,
			TASK,
			'reviewer_run',
		);
		expect((await readTaskEvidence(dir, TASK))?.workflow.state).toBe(
			'reviewer_run',
		);

		const hook = createDelegationGateHook(config(), dir);
		await dispatch(hook, dir, 'reviewer', 'call-g1');
		expect(await teSlots(dir)).toBe(0);
		await settle(hook, 'reviewer', 'call-g1');

		expect(state()).toBe('tests_run');
		expect(checkReviewerGate(TASK, dir, false, SESSION).blocked).toBe(false);
	});

	it('H: fail-open router-error receipt + flag true but test_engineer required: reviewer-only does not advance', async () => {
		const dir = await fixture({ exempt: false, recordFiles: false });
		editEvidence(dir, (e) => {
			e.test_engineer_exempt = true;
			e.required_gates = ['reviewer', 'test_engineer'];
		});
		const hook = createDelegationGateHook(config(), dir);
		await dispatch(hook, dir, 'reviewer', 'call-h1');
		expect(await teSlots(dir)).toBeUndefined();
		await settle(hook, 'reviewer', 'call-h1');

		expect(state()).toBe('reviewer_run');
	});
});
