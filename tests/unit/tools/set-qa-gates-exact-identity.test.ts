import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	getOrCreateProfile,
	getProfile,
	getProfileForIdentity,
	getProfileLookupForIdentity,
	lockProfile,
} from '../../../src/db/qa-gate-profile';
import { derivePlanId } from '../../../src/plan/utils';
import type { SetQaGatesArgs } from '../../../src/tools/set-qa-gates';
import { executeSetQaGates } from '../../../src/tools/set-qa-gates';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CURRENT_PLAN_IDENTITY = {
	swarm: 'test-swarm',
	title: 'Test Plan',
} as const;

function writePlanJson(
	directory: string,
	title = CURRENT_PLAN_IDENTITY.title,
	swarm = CURRENT_PLAN_IDENTITY.swarm,
): void {
	const plan = {
		schema_version: '1.0.0',
		title,
		swarm,
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
}

describe('set-qa-gates exact identity flows', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('set-qa-gates-identity-');
		writePlanJson(tempDir);
	});

	afterEach(() => {
		closeProjectDb(tempDir);
		rmSync(tempDir, { recursive: true, force: true });
	});

	function getExactProfile(
		identity: { swarm: string; title: string } = CURRENT_PLAN_IDENTITY,
	) {
		return getProfileForIdentity(tempDir, identity);
	}

	it('bootstraps a profile before plan.json exists from an exact identity', async () => {
		rmSync(join(tempDir, '.swarm', 'plan.json'), { force: true });
		const args: SetQaGatesArgs = {
			swarm_id: ' test swarm ',
			plan_title: ' Initial Plan ',
			reviewer: false,
		};

		const result = await executeSetQaGates(args, tempDir);
		expect(result.success).toBe(true);
		expect(result.plan_id).toBe(
			derivePlanId({ swarm: args.swarm_id!, title: args.plan_title! }),
		);
		expect(
			getExactProfile({ swarm: args.swarm_id!, title: args.plan_title! })?.gates
				.reviewer,
		).toBe(false);
	});

	it('requires a complete explicit identity before plan.json exists', async () => {
		rmSync(join(tempDir, '.swarm', 'plan.json'), { force: true });
		expect((await executeSetQaGates({ reviewer: true }, tempDir)).reason).toBe(
			'plan_identity_required',
		);
		expect(
			(
				await executeSetQaGates(
					{ swarm_id: 'test-swarm', reviewer: true },
					tempDir,
				)
			).reason,
		).toBe('plan_identity_incomplete');
	});

	it('rejects blank explicit identity without creating a profile', async () => {
		rmSync(join(tempDir, '.swarm', 'plan.json'), { force: true });
		const result = await executeSetQaGates(
			{ swarm_id: '   ', plan_title: 'Future Plan', reviewer: true },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('plan_identity_invalid');
		expect(getProfile(tempDir, '___-Future_Plan')).toBeNull();
	});

	it('accepts an explicit identity matching the current plan', async () => {
		const result = await executeSetQaGates(
			{
				swarm_id: CURRENT_PLAN_IDENTITY.swarm,
				plan_title: CURRENT_PLAN_IDENTITY.title,
				mutation_test: true,
			},
			tempDir,
		);
		expect(result.success).toBe(true);
		expect(result.plan_id).toBe('test-swarm-Test_Plan');
	});

	it('rejects a partial explicit identity even when a current plan exists', async () => {
		const result = await executeSetQaGates(
			{ plan_title: CURRENT_PLAN_IDENTITY.title, mutation_test: true },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('plan_identity_incomplete');
	});

	it('rejects a mismatched explicit identity unless replacement is confirmed', async () => {
		const rejected = await executeSetQaGates(
			{
				swarm_id: 'test-swarm',
				plan_title: 'Replacement Plan',
				mutation_test: true,
			},
			tempDir,
		);
		expect(rejected.success).toBe(false);
		expect(rejected.reason).toBe('plan_identity_mismatch');
		expect(
			getProfileLookupForIdentity(tempDir, {
				swarm: 'test-swarm',
				title: 'Replacement Plan',
			}).kind,
		).toBe('missing');

		const confirmed = await executeSetQaGates(
			{
				swarm_id: 'test-swarm',
				plan_title: 'Replacement Plan',
				confirm_identity_change: true,
				mutation_test: true,
			},
			tempDir,
		);
		expect(confirmed.success).toBe(true);
		expect(confirmed.plan_id).toBe('test-swarm-Replacement_Plan');
	});

	it('creates a distinct exact profile when raw identity collides on readable plan_id', async () => {
		rmSync(join(tempDir, '.swarm', 'plan.json'), { force: true });
		const first = await executeSetQaGates(
			{ swarm_id: 'mega one', plan_title: 'Plan / 1', reviewer: false },
			tempDir,
		);
		const second = await executeSetQaGates(
			{ swarm_id: 'mega?one', plan_title: 'Plan ? 1', reviewer: false },
			tempDir,
		);
		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(first.profile?.profile_hash).not.toBe(second.profile?.profile_hash);
	});

	it('creates a replacement exact profile instead of mutating a locked colliding legacy row', async () => {
		writePlanJson(tempDir, 'Plan / 1', 'mega one');
		const readablePlanId = derivePlanId({
			swarm: 'mega one',
			title: 'Plan / 1',
		});
		getOrCreateProfile(tempDir, readablePlanId);
		lockProfile(tempDir, readablePlanId, 9);

		const result = await executeSetQaGates(
			{
				swarm_id: 'mega?one',
				plan_title: 'Plan ? 1',
				confirm_identity_change: true,
				mutation_test: true,
			},
			tempDir,
		);

		expect(result.success).toBe(true);
		expect(
			getProfileForIdentity(tempDir, {
				swarm: 'mega?one',
				title: 'Plan ? 1',
			})?.locked_by_snapshot_seq,
		).toBeNull();
		expect(getProfile(tempDir, readablePlanId)?.locked_by_snapshot_seq).toBe(9);
	});

	it('uses the initial explicit selection before applying later ratchet rules', async () => {
		const initial = await executeSetQaGates({ reviewer: false }, tempDir);
		expect(initial.success).toBe(true);
		expect(initial.profile?.gates.reviewer).toBe(false);
		expect((await executeSetQaGates({ reviewer: true }, tempDir)).success).toBe(
			true,
		);
		const disabled = await executeSetQaGates({ reviewer: false }, tempDir);
		expect(disabled.success).toBe(false);
		expect(disabled.reason).toBe('ratchet_violation');
	});

	it('adopts a locked legacy current-plan row with an empty patch', async () => {
		getOrCreateProfile(tempDir, 'test-swarm-Test_Plan');
		lockProfile(tempDir, 'test-swarm-Test_Plan', 1);
		const before = getProfile(tempDir, 'test-swarm-Test_Plan');

		const result = await executeSetQaGates(
			{ adopt_legacy_binding_only: true },
			tempDir,
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain('without changing gates or lock state');
		expect(result.profile?.locked_by_snapshot_seq).toBe(1);
		expect(result.profile?.gates).toEqual(before?.gates);
		expect(
			getProfileLookupForIdentity(tempDir, CURRENT_PLAN_IDENTITY).kind,
		).toBe('bound');
	});
});
