import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema.js';
import { loadLastApprovedPlan } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executeApprovePlanCritic } from '../../../src/tools/approve-plan-critic.js';

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Approve Plan Critic Tool Test',
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
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await initLedger(dir, derivePlanId(plan));
	return plan;
}

// Avoid importing node:fs's writeFileSync at module top so the dynamic import
// pattern in the sibling command test is mirrored (keeps the fixture
// self-contained per file).
import { writeFileSync } from 'node:fs';

describe('approve_plan_critic tool', () => {
	let dir: string;

	beforeEach(async () => {
		resetSwarmState();
		dir = await mkdtemp(join(tmpdir(), 'approve-plan-critic-tool-'));
	});

	afterEach(async () => {
		resetSwarmState();
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('records a manual approval with user_confirmed: false (agent path)', async () => {
		const plan = await writePlan(dir);
		ensureAgentSession('session-tool', 'architect');

		const result = await executeApprovePlanCritic(
			{ reason: 'critic APPROVED but snapshot not recorded' },
			dir,
			{ sessionID: 'session-tool' },
		);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.method).toBe('manual_override');
		expect(parsed.user_confirmed).toBe(false);

		const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
		expect(approved?.approval?.source).toBe('plan_critic_gate');
		expect(approved?.approval?.method).toBe('manual_override');
		expect(approved?.approval?.user_confirmed).toBe(false);
	});

	test('appends an audit event to .swarm/events.jsonl', async () => {
		await writePlan(dir);
		ensureAgentSession('session-tool-audit', 'architect');

		await executeApprovePlanCritic({ reason: 'audit check' }, dir, {
			sessionID: 'session-tool-audit',
		});

		const eventsPath = join(dir, '.swarm', 'events.jsonl');
		expect(existsSync(eventsPath)).toBe(true);
		const events = readFileSync(eventsPath, 'utf8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		const last = JSON.parse(events[events.length - 1]);
		expect(last.type).toBe('plan_critic_gate_manual_approval');
		expect(last.user_confirmed).toBe(false);
		expect(last.reason).toBe('audit check');
	});

	test('rejects a non-architect session', async () => {
		await writePlan(dir);
		ensureAgentSession('session-reviewer', 'reviewer');

		const result = await executeApprovePlanCritic(
			{ reason: 'reviewer tries self-unblock' },
			dir,
			{ sessionID: 'session-reviewer' },
		);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('NOT_AUTHORIZED');
	});

	test('rejects when reason is missing', async () => {
		await writePlan(dir);
		ensureAgentSession('session-noreason-tool', 'architect');

		const result = await executeApprovePlanCritic({}, dir, {
			sessionID: 'session-noreason-tool',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Invalid approve_plan_critic call');
	});

	test('rejects when sessionID is missing', async () => {
		await writePlan(dir);

		const result = await executeApprovePlanCritic(
			{ reason: 'no session' },
			dir,
			{},
		);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('active sessionID');
	});
});
