import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	DEFAULT_QA_GATES,
	getOrCreateProfile,
	getProfileForIdentity,
	type QaGates,
	_internals as qaProfileInternals,
} from '../../../src/db/qa-gate-profile';
import { derivePlanId } from '../../../src/plan/utils';
import type { SetQaGatesArgs } from '../../../src/tools/set-qa-gates';
import { executeSetQaGates } from '../../../src/tools/set-qa-gates';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PLAN = {
	schema_version: '1.0.0',
	title: 'Initial QA Selection',
	swarm: 'test-swarm',
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
					description: 'Implement the change',
					depends: [],
					files_touched: ['src/index.ts'],
				},
			],
		},
	],
} as const;

const PLAN_ID = derivePlanId(PLAN);
const originalGetProfile = qaProfileInternals.getProfile;
const DEFAULT_ON_GATE_NAMES = [
	'reviewer',
	'test_engineer',
	'sme_enabled',
	'critic_pre_plan',
	'sast_enabled',
	'drift_check',
] as const satisfies ReadonlyArray<keyof QaGates>;

function writePlan(directory: string): void {
	const swarmDir = join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(join(swarmDir, 'plan.json'), JSON.stringify(PLAN), 'utf8');
}

describe('set_qa_gates initial selection', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('qa-initial-selection-');
		writePlan(directory);
	});

	afterEach(() => {
		qaProfileInternals.getProfile = originalGetProfile;
		closeProjectDb(directory);
		rmSync(directory, { recursive: true, force: true });
	});

	it('persists false for every default-on gate on the first selection', async () => {
		const defaultOnGates = (
			Object.keys(DEFAULT_QA_GATES) as Array<keyof QaGates>
		).filter((gate) => DEFAULT_QA_GATES[gate]);
		expect(defaultOnGates).toEqual(DEFAULT_ON_GATE_NAMES);
		const selection: SetQaGatesArgs = {};
		for (const gate of defaultOnGates) selection[gate] = false;

		const result = await executeSetQaGates(selection, directory);

		expect(result.success).toBe(true);
		const profile = getProfileForIdentity(directory, PLAN);
		expect(profile).not.toBeNull();
		for (const gate of defaultOnGates) {
			expect(profile?.gates[gate]).toBe(false);
		}
	});

	it('keeps the ratchet after the initial false selection', async () => {
		const initial = await executeSetQaGates(
			{ critic_pre_plan: false },
			directory,
		);
		expect(initial.success).toBe(true);

		const enabled = await executeSetQaGates(
			{ critic_pre_plan: true },
			directory,
		);
		expect(enabled.success).toBe(true);

		const loosened = await executeSetQaGates(
			{ critic_pre_plan: false },
			directory,
		);
		expect(loosened.success).toBe(false);
		expect(loosened.reason).toBe('ratchet_violation');
		expect(getProfileForIdentity(directory, PLAN)?.gates.critic_pre_plan).toBe(
			true,
		);
	});

	it('does not loosen a true profile created by a concurrent winner', async () => {
		getOrCreateProfile(directory, PLAN_ID, undefined, {
			critic_pre_plan: true,
		});
		let reads = 0;
		qaProfileInternals.getProfile = (dir, planId) => {
			reads += 1;
			// Simulate the losing caller's pre-INSERT read racing just before the
			// winner commits. The INSERT then hits the UNIQUE constraint.
			if (reads === 1) return null;
			return originalGetProfile(dir, planId);
		};

		const result = await executeSetQaGates(
			{ critic_pre_plan: false },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('ratchet_violation');
		expect(originalGetProfile(directory, PLAN_ID)?.gates.critic_pre_plan).toBe(
			true,
		);
	});
});
