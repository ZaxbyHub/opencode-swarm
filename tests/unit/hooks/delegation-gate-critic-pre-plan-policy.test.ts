import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfile } from '../../../src/db/qa-gate-profile';
import { derivePlanId } from '../../../src/plan/utils';
import { getScopeBindingForParentDispatch } from '../../../src/scope/scope-binding';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executeSetQaGates } from '../../../src/tools/set-qa-gates';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Critic Policy Test',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Implement issue fix',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
	};
}

function writePlan(directory: string, plan: Plan): void {
	const swarmDir = join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(join(swarmDir, 'plan.json'), JSON.stringify(plan), 'utf8');
}

function coderDispatch(sessionID: string) {
	return {
		input: {
			tool: 'Task',
			sessionID,
			callID: `${sessionID}-coder`,
		},
		output: {
			args: {
				subagent_type: 'coder',
				prompt:
					'TASK: 1.1\nImplement the plan.\nACCEPTANCE: task complete and tested',
			},
		},
	};
}

async function expectCriticBlock(directory: string, sessionID: string) {
	const hook = createDelegationGateHook(makeConfig(), directory);
	const { input, output } = coderDispatch(sessionID);
	await expect(hook.toolBefore(input, output)).rejects.toThrow(
		'PLAN_CRITIC_GATE_VIOLATION',
	);
}

describe('delegation gate critic_pre_plan policy', () => {
	let directory: string;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		directory = canonicalMkdtemp('critic-policy-');
		plan = makePlan();
		writePlan(directory, plan);
	});

	afterEach(() => {
		resetSwarmState();
		closeProjectDb(directory);
		rmSync(directory, { recursive: true, force: true });
	});

	it('skips only the critic assertion when persisted policy is false', async () => {
		const configured = await executeSetQaGates(
			{ critic_pre_plan: false },
			directory,
		);
		expect(configured.success).toBe(true);
		const sessionID = 'critic-policy-disabled';
		ensureAgentSession(sessionID, 'architect');
		const hook = createDelegationGateHook(makeConfig(), directory);
		const { input, output } = coderDispatch(sessionID);

		await hook.toolBefore(input, output);
		expect(
			getScopeBindingForParentDispatch({
				parentSessionId: sessionID,
				dispatchCallId: input.callID,
			}),
		).not.toBeNull();
	});

	it('enforces the historical default when no profile exists', async () => {
		await expectCriticBlock(directory, 'critic-policy-missing');
	});

	it('fails closed when a persisted gate has a corrupt non-boolean value', async () => {
		const planId = derivePlanId(plan);
		getOrCreateProfile(directory, planId);
		getProjectDb(directory).run(
			'UPDATE qa_gate_profile SET gates = ? WHERE plan_id = ?',
			['{"critic_pre_plan":0}', planId],
		);

		await expectCriticBlock(directory, 'critic-policy-corrupt');
	});

	it('allows a true session override to re-enable persisted false', async () => {
		const configured = await executeSetQaGates(
			{ critic_pre_plan: false },
			directory,
		);
		expect(configured.success).toBe(true);
		const sessionID = 'critic-policy-session-enable';
		ensureAgentSession(sessionID, 'architect').qaGateSessionOverrides = {
			critic_pre_plan: true,
		};

		await expectCriticBlock(directory, sessionID);
	});

	it('ignores a false session override and keeps persisted true enabled', async () => {
		getOrCreateProfile(directory, derivePlanId(plan));
		const sessionID = 'critic-policy-session-loosen';
		ensureAgentSession(sessionID, 'architect').qaGateSessionOverrides = {
			critic_pre_plan: false,
		};

		await expectCriticBlock(directory, sessionID);
	});

	it('preserves no-plan scope failure instead of reporting critic policy', async () => {
		rmSync(join(directory, '.swarm', 'plan.json'), { force: true });
		const sessionID = 'critic-policy-no-plan';
		ensureAgentSession(sessionID, 'architect');
		const hook = createDelegationGateHook(makeConfig(), directory);
		const { input, output } = coderDispatch(sessionID);

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'SCOPE_NOT_DECLARED',
		);
	});
});
