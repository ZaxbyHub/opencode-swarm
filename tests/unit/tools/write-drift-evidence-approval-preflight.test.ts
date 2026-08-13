import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	getProfileForIdentity,
	setGatesForIdentity,
} from '../../../src/db/qa-gate-profile';
import { initLedger, loadLastApprovedPlan } from '../../../src/plan/ledger';
import { derivePlanId } from '../../../src/plan/utils';
import {
	_internals,
	executeWriteDriftEvidence,
} from '../../../src/tools/write-drift-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function createTestPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Drift Snapshot Test',
		swarm: 'drift-snapshot-swarm',
		current_phase: 1,
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
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function setupSwarmDirWithPlan(dir: string, plan: Plan): Promise<void> {
	await fs.promises.mkdir(path.join(dir, '.swarm'), { recursive: true });
	await fs.promises.writeFile(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
	await initLedger(dir, derivePlanId(plan));
}

function createExactQaProfile(dir: string, plan: Plan): void {
	getOrCreateProfileForIdentity(
		dir,
		{ swarm: plan.swarm, title: plan.title },
		'ts',
	);
}

describe('write_drift_evidence approval preflight', () => {
	let tempDir: string;
	let originalLockProfileForIdentity: typeof _internals.lockProfileForIdentity;

	beforeEach(() => {
		originalLockProfileForIdentity = _internals.lockProfileForIdentity;
		tempDir = canonicalMkdtemp('drift-evidence-preflight-');
	});

	afterEach(async () => {
		_internals.lockProfileForIdentity = originalLockProfileForIdentity;
		closeProjectDb(tempDir);
		await fs.promises.rm(tempDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	});

	test('ST-001 rejects APPROVED when no exact QA gate profile exists and leaves no durable artifacts', async () => {
		const plan = createTestPlan();
		await setupSwarmDirWithPlan(tempDir, plan);

		const result = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Approval without QA selection',
				},
				tempDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('qa_gate_selection_required');
		expect(result.recovery_guidance).toContain('set_qa_gates');

		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'drift-verifier.json',
		);
		expect(existsSync(evidencePath)).toBe(false);
		expect(await loadLastApprovedPlan(tempDir)).toBeNull();
	});

	test('ST-001 rejects APPROVED when the QA profile is unbound_legacy and writes no approval artifacts', async () => {
		const plan = createTestPlan();
		await setupSwarmDirWithPlan(tempDir, plan);
		getOrCreateProfile(tempDir, derivePlanId(plan), 'legacy');

		const result = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Approval against legacy row',
				},
				tempDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('qa_gate_identity_unbound');
		expect(result.recovery_guidance).toContain(
			'adopt_legacy_binding_only: true',
		);

		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'drift-verifier.json',
		);
		expect(existsSync(evidencePath)).toBe(false);
		expect(await loadLastApprovedPlan(tempDir)).toBeNull();
	});

	test('ST-001 requires approval to rerun after legacy binding and locks the successful approval snapshot', async () => {
		const plan = createTestPlan();
		await setupSwarmDirWithPlan(tempDir, plan);
		getOrCreateProfile(tempDir, derivePlanId(plan), 'legacy');

		const firstAttempt = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'First approval attempt',
				},
				tempDir,
			),
		);
		expect(firstAttempt.success).toBe(false);
		expect(firstAttempt.reason).toBe('qa_gate_identity_unbound');

		setGatesForIdentity(
			tempDir,
			{ swarm: plan.swarm, title: plan.title },
			{},
			{
				allowLegacyAdoption: true,
				legacyAdoptionIdentity: { swarm: plan.swarm, title: plan.title },
			},
		);

		const secondAttempt = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Second approval attempt',
				},
				tempDir,
			),
		);
		expect(secondAttempt.success).toBe(true);
		expect(secondAttempt.approvedSnapshot).toBeDefined();
		expect(secondAttempt.qaProfileLocked?.locked_by_snapshot_seq).toBe(
			secondAttempt.approvedSnapshot.locked_by_snapshot_seq,
		);
		expect(secondAttempt.approvedSnapshot.seq).toBeGreaterThan(
			secondAttempt.approvedSnapshot.locked_by_snapshot_seq,
		);

		const profile = getProfileForIdentity(tempDir, {
			swarm: plan.swarm,
			title: plan.title,
		});
		expect(profile?.locked_by_snapshot_seq).toBe(
			secondAttempt.approvedSnapshot.locked_by_snapshot_seq,
		);
		expect(profile?.locked_at).not.toBeNull();
	});

	test('ST-001 rejects APPROVED when plan.json is missing before any approval artifacts are written', async () => {
		const result = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Approved without a plan',
				},
				tempDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('plan_required_for_approval');
		expect(result.recovery_guidance).toContain('.swarm/plan.json');
	});

	test('ST-001 fails closed when critic-approved snapshot persistence throws', async () => {
		const plan = createTestPlan();
		await fs.promises.mkdir(path.join(tempDir, '.swarm'), {
			recursive: true,
		});
		await fs.promises.writeFile(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);
		createExactQaProfile(tempDir, plan);

		const result = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Ledger unavailable scenario',
				},
				tempDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('approval_persistence_failed');
		expect(result.message).toMatch(/Ledger not initialized/);

		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'drift-verifier.json',
		);
		expect(existsSync(evidencePath)).toBe(false);
	});

	test('ST-001 does not publish a critic-approved snapshot when exact profile locking fails', async () => {
		const plan = createTestPlan();
		await setupSwarmDirWithPlan(tempDir, plan);
		createExactQaProfile(tempDir, plan);
		_internals.lockProfileForIdentity = () => {
			throw new Error('injected exact profile lock failure');
		};

		const result = JSON.parse(
			await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Approval with failed profile lock',
				},
				tempDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('approval_persistence_failed');
		expect(result.message).toContain('injected exact profile lock failure');
		expect(await loadLastApprovedPlan(tempDir)).toBeNull();
		expect(
			existsSync(
				path.join(tempDir, '.swarm', 'evidence', '1', 'drift-verifier.json'),
			),
		).toBe(false);
	});
});
