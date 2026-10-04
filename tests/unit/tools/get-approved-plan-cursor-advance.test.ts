/**
 * get_approved_plan reports no drift for a phase-boundary cursor advance.
 *
 * The approval baseline (the structural plan hash) includes the
 * `current_phase` cursor (#2532). Completing a phase's last task advances the
 * cursor, so get_approved_plan reported drift for an unedited plan — while the
 * critic gate (approvedSnapshotCoversPlan) accepted the same plan. Both now
 * apply the same check; a structural edit is still drift.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import { initLedger } from '../../../src/plan/ledger';
import { updateTaskStatus } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executeGetApprovedPlan } from '../../../src/tools/get-approved-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	createDelegationGateHook,
	makeConfig,
} from '../hooks/_delegation-gate-helpers';

function task(id: string, phase: number, file: string) {
	return {
		id,
		phase,
		status: 'pending' as const,
		size: 'small' as const,
		description: `Task ${id}`,
		depends: [],
		files_touched: [file],
	};
}

const PLAN: Plan = {
	schema_version: '1.0.0',
	title: 'Cursor Advance Drift',
	swarm: 'cursor-drift-swarm',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'One',
			status: 'in_progress',
			tasks: [task('1.1', 1, 'src/a.ts')],
		},
		{
			id: 2,
			name: 'Two',
			status: 'pending',
			tasks: [task('2.1', 2, 'src/b.ts')],
		},
	],
};

let dir: string;

function readPlan(): Plan {
	return JSON.parse(
		readFileSync(join(dir, '.swarm', 'plan.json'), 'utf-8'),
	) as Plan;
}

beforeEach(async () => {
	resetSwarmState();
	dir = canonicalMkdtemp('cursor-drift-');
	mkdirSync(join(dir, '.git'), { recursive: true });
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(PLAN, null, 2),
	);
	await initLedger(dir, derivePlanId(PLAN));
	await updateTaskStatus(dir, '1.1', 'pending');
	ensureAgentSession('session-cursor-drift', 'architect');
	await createDelegationGateHook(makeConfig(), dir).toolAfter(
		{
			tool: 'Task',
			sessionID: 'session-cursor-drift',
			callID: 'critic-cursor-drift',
			args: {
				subagent_type: 'critic',
				prompt: 'MODE: CRITIC-GATE\nEvaluate this plan before implementation.',
			},
		},
		{ output: 'VERDICT: APPROVED\nThe plan is ready for execution.' },
	);
});

afterEach(async () => {
	resetSwarmState();
	if (dir && existsSync(dir)) {
		closeProjectDb(dir);
		await rm(dir, { recursive: true, force: true, maxRetries: 5 });
	}
});

describe('get_approved_plan across a phase-boundary cursor advance', () => {
	test('completing phase 1 (cursor 1 → 2) is not drift', async () => {
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(readPlan().current_phase).toBe(2);
		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(false);
	});

	test('a structural edit after the advance is still drift', async () => {
		await updateTaskStatus(dir, '1.1', 'completed');
		const plan = readPlan();
		plan.phases[1].tasks[0].description = 'Edited after approval';
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(true);
	});
});
