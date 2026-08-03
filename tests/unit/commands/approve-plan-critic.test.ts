import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApprovePlanCriticCommand } from '../../../src/commands/approve-plan-critic.js';
import type { Plan } from '../../../src/config/plan-schema.js';
import { loadLastApprovedPlan } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Approve Plan Critic Command Test',
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
						description: 'Do the thing',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
	};
}

async function writePlan(dir: string): Promise<Plan> {
	const plan = makePlan();
	await mkdir(join(dir, '.swarm'), { recursive: true });
	const { initLedger } = await import('../../../src/plan/ledger.js');
	const { writeFileSync } = await import('node:fs');
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await initLedger(dir, derivePlanId(plan));
	return plan;
}

describe('/swarm approve-plan-critic command', () => {
	let dir: string;

	beforeEach(async () => {
		resetSwarmState();
		dir = await mkdtemp(join(tmpdir(), 'approve-plan-critic-cmd-'));
	});

	afterEach(async () => {
		resetSwarmState();
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('records a manual approval with user_confirmed: true', async () => {
		const plan = await writePlan(dir);
		ensureAgentSession('session-cmd', 'architect');

		const result = await handleApprovePlanCriticCommand(
			dir,
			['critic', 'returned', 'APPROVED', 'but', 'format', 'mismatched'],
			'session-cmd',
		);

		expect(result).toContain('manual plan_critic_gate approval');
		expect(result).toContain('user_confirmed: true');

		const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
		expect(approved?.approval?.source).toBe('plan_critic_gate');
		expect(approved?.approval?.method).toBe('manual_override');
		expect(approved?.approval?.user_confirmed).toBe(true);
		expect(approved?.approval?.reason).toBe(
			'critic returned APPROVED but format mismatched',
		);
	});

	test('appends an audit event to .swarm/events.jsonl', async () => {
		await writePlan(dir);
		ensureAgentSession('session-audit-cmd', 'architect');

		await handleApprovePlanCriticCommand(
			dir,
			['test reason'],
			'session-audit-cmd',
		);

		const eventsPath = join(dir, '.swarm', 'events.jsonl');
		expect(existsSync(eventsPath)).toBe(true);
		const events = readFileSync(eventsPath, 'utf8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		const last = JSON.parse(events[events.length - 1]);
		expect(last.type).toBe('plan_critic_gate_manual_approval');
		expect(last.user_confirmed).toBe(true);
		expect(last.reason).toBe('test reason');
	});

	test('errors when no reason is provided', async () => {
		await writePlan(dir);
		ensureAgentSession('session-noreason', 'architect');

		const result = await handleApprovePlanCriticCommand(
			dir,
			[],
			'session-noreason',
		);
		expect(result).toContain('Error: a reason is required');
	});

	test('errors when sessionID is missing', async () => {
		await writePlan(dir);
		const result = await handleApprovePlanCriticCommand(dir, ['reason'], '');
		expect(result).toContain('requires an active sessionID');
	});

	test('errors when the session is not an architect', async () => {
		await writePlan(dir);
		ensureAgentSession('session-coder-cmd', 'coder');

		const result = await handleApprovePlanCriticCommand(
			dir,
			['reason'],
			'session-coder-cmd',
		);
		expect(result).toContain('NOT_AUTHORIZED');
	});

	test('errors when no plan.json exists', async () => {
		await mkdir(join(dir, '.swarm'), { recursive: true });
		ensureAgentSession('session-noplan-cmd', 'architect');

		const result = await handleApprovePlanCriticCommand(
			dir,
			['reason'],
			'session-noplan-cmd',
		);
		expect(result).toContain('PLAN_NOT_FOUND');
	});
});
