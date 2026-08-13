import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfile } from '../../../src/db/qa-gate-profile';
import { _internals, executeSetQaGates } from '../../../src/tools/set-qa-gates';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const IDENTITY = { swarm: 'test-swarm', title: 'Test Plan' } as const;
const realSetGatesForIdentity = _internals.setGatesForIdentity;

function writePlan(directory: string): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: IDENTITY.title,
			swarm: IDENTITY.swarm,
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
		}),
		'utf8',
	);
}

describe('set_qa_gates binding-only recovery failures (TF-002)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('set-qa-gates-binding-only-');
		writePlan(tempDir);
		_internals.setGatesForIdentity = realSetGatesForIdentity;
	});

	afterEach(() => {
		_internals.setGatesForIdentity = realSetGatesForIdentity;
		closeProjectDb(tempDir);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('rejects any gate or project-type mutation in binding-only mode', async () => {
		// Previous coverage exercised only successful adoption, so a regression
		// could silently combine recovery with a gate mutation.
		const gatePatch = await executeSetQaGates(
			{ adopt_legacy_binding_only: true, reviewer: true },
			tempDir,
		);
		expect(gatePatch.success).toBe(false);
		expect(gatePatch.reason).toBe('binding_only_patch_conflict');

		const projectPatch = await executeSetQaGates(
			{ adopt_legacy_binding_only: true, project_type: 'ts' },
			tempDir,
		);
		expect(projectPatch.success).toBe(false);
		expect(projectPatch.reason).toBe('binding_only_patch_conflict');
	});

	it('rejects binding-only recovery for a replacement identity', async () => {
		const result = await executeSetQaGates(
			{
				adopt_legacy_binding_only: true,
				swarm_id: 'replacement',
				plan_title: 'Replacement',
				confirm_identity_change: true,
			},
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('adopt_legacy_requires_current_plan');
	});

	it('does not fabricate a profile when no legacy row exists', async () => {
		const result = await executeSetQaGates(
			{ adopt_legacy_binding_only: true },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('no_profile');
	});

	it('is idempotent when the current profile is already exact-bound', async () => {
		expect((await executeSetQaGates({ reviewer: true }, tempDir)).success).toBe(
			true,
		);
		const result = await executeSetQaGates(
			{ adopt_legacy_binding_only: true },
			tempDir,
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain('already exact-bound');
	});

	it('classifies an adoption exception as binding_only_failed', async () => {
		getOrCreateProfile(tempDir, 'test-swarm-Test_Plan');
		_internals.setGatesForIdentity = (() => {
			throw new Error('injected adoption failure');
		}) as typeof realSetGatesForIdentity;

		const result = await executeSetQaGates(
			{ adopt_legacy_binding_only: true },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('binding_only_failed');
		expect(result.message).toBe('injected adoption failure');
	});
});
