import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	DEFAULT_QA_GATES,
	getProfile,
	lockProfile,
} from '../../../src/db/qa-gate-profile';
import type { SetQaGatesArgs } from '../../../src/tools/set-qa-gates';
import { executeSetQaGates } from '../../../src/tools/set-qa-gates';

const ALL_GATE_NAMES = [
	'reviewer',
	'test_engineer',
	'council_mode',
	'sme_enabled',
	'critic_pre_plan',
	'hallucination_guard',
	'sast_enabled',
	'mutation_test',
	'phase_council',
	'drift_check',
	'final_council',
] as const;

function writePlanJson(
	directory: string,
	title = 'Test Plan',
	swarm = 'test-swarm',
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
	const swarmDir = join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
}

describe('set-qa-gates tool', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'set-qa-gates-test-'));
		writePlanJson(tempDir);
	});

	afterEach(() => {
		closeProjectDb(tempDir);
		rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// QA GATE PROFILE UPDATES
	// -------------------------------------------------------------------------

	describe('gate profile updates', () => {
		it('creates profile with defaults when none exists', async () => {
			const result = await executeSetQaGates({}, tempDir);
			expect(result.success).toBe(true);
			expect(result.plan_id).toBeDefined();

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			// Defaults should be applied
			expect(profile!.gates).toEqual(DEFAULT_QA_GATES);
		});

		it('enables a single gate and persists correctly', async () => {
			const result = await executeSetQaGates({ council_mode: true }, tempDir);
			expect(result.success).toBe(true);

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			expect(profile!.gates.council_mode).toBe(true);
			// Other defaults remain unchanged
			expect(profile!.gates.reviewer).toBe(DEFAULT_QA_GATES.reviewer);
		});

		it('enables multiple gates in a single call', async () => {
			const args: SetQaGatesArgs = {
				council_mode: true,
				sme_enabled: true,
				phase_council: true,
			};
			const result = await executeSetQaGates(args, tempDir);
			expect(result.success).toBe(true);

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			expect(profile!.gates.council_mode).toBe(true);
			expect(profile!.gates.sme_enabled).toBe(true);
			expect(profile!.gates.phase_council).toBe(true);
			// Defaults that were not overridden
			expect(profile!.gates.reviewer).toBe(DEFAULT_QA_GATES.reviewer);
			expect(profile!.gates.test_engineer).toBe(DEFAULT_QA_GATES.test_engineer);
		});

		it('sets all boolean gate fields via executeSetQaGates', async () => {
			// Build an args object that sets every gate to true
			const args: SetQaGatesArgs = {};
			for (const gate of ALL_GATE_NAMES) {
				args[gate] = true;
			}

			const result = await executeSetQaGates(args, tempDir);
			expect(result.success).toBe(true);

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			for (const gate of ALL_GATE_NAMES) {
				expect(profile!.gates[gate]).toBe(true);
			}
		});

		it('returns the updated profile in the result', async () => {
			const result = await executeSetQaGates({ mutation_test: true }, tempDir);
			expect(result.success).toBe(true);
			expect(result.profile).toBeDefined();
			expect(result.profile!.gates.mutation_test).toBe(true);
			expect(result.profile!.plan_id).toBe(result.plan_id);
			expect(result.profile!.locked_at).toBeNull();
		});

		it('returns plan_json_unavailable when plan.json is missing', async () => {
			// Remove the plan.json to trigger the error
			rmSync(join(tempDir, '.swarm', 'plan.json'), { force: true });

			const result = await executeSetQaGates({ reviewer: true }, tempDir);
			expect(result.success).toBe(false);
			expect(result.reason).toBe('plan_json_unavailable');
			expect(result.message).toContain('plan.json');
		});

		it('preserves project_type when profile is first created', async () => {
			const result = await executeSetQaGates(
				{ project_type: 'typescript' },
				tempDir,
			);
			expect(result.success).toBe(true);

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			expect(profile!.project_type).toBe('typescript');
		});

		it('does not overwrite project_type on subsequent calls', async () => {
			// First call sets project_type
			await executeSetQaGates({ project_type: 'python' }, tempDir);

			// Second call without project_type
			await executeSetQaGates({ sme_enabled: true }, tempDir);

			const profile = getProfile(tempDir, 'test-swarm-Test_Plan');
			expect(profile).not.toBeNull();
			expect(profile!.project_type).toBe('python');
		});
	});

	// -------------------------------------------------------------------------
	// LOCK SEMANTICS
	// -------------------------------------------------------------------------

	describe('lock semantics', () => {
		it('setGates throws when profile is locked', async () => {
			// First enable a gate so we have a profile
			const result = await executeSetQaGates({ reviewer: true }, tempDir);
			expect(result.success).toBe(true);

			// Lock the profile
			lockProfile(tempDir, result.plan_id!, 1);

			// Attempt to modify — should fail
			const lockedResult = await executeSetQaGates(
				{ council_mode: true },
				tempDir,
			);
			expect(lockedResult.success).toBe(false);
			expect(lockedResult.reason).toBe('profile_locked');
			expect(lockedResult.message).toContain('locked');
		});

		it('ratchet-tight: cannot disable a gate that is already enabled', async () => {
			// Enable a gate
			const result = await executeSetQaGates({ reviewer: true }, tempDir);
			expect(result.success).toBe(true);

			// Attempt to disable it — should fail with ratchet violation
			const disableResult = await executeSetQaGates(
				{ reviewer: false },
				tempDir,
			);
			expect(disableResult.success).toBe(false);
			expect(disableResult.reason).toBe('ratchet_violation');
			expect(disableResult.message).toContain('ratchet');
		});

		it('ratchet-tight: setting same value is idempotent', async () => {
			// Enable a gate
			const result1 = await executeSetQaGates({ reviewer: true }, tempDir);
			expect(result1.success).toBe(true);

			// Set it to true again — should succeed (idempotent)
			const result2 = await executeSetQaGates({ reviewer: true }, tempDir);
			expect(result2.success).toBe(true);

			// Verify it's still enabled
			const profile = getProfile(tempDir, result1.plan_id!);
			expect(profile!.gates.reviewer).toBe(true);
		});

		it('ratchet-tight: enabling multiple gates, then disabling one fails', async () => {
			// Enable several gates at once
			await executeSetQaGates(
				{ council_mode: true, sme_enabled: true, phase_council: true },
				tempDir,
			);

			// Attempt to disable one of them — should fail
			const result = await executeSetQaGates({ council_mode: false }, tempDir);
			expect(result.success).toBe(false);
			expect(result.reason).toBe('ratchet_violation');
		});

		it('can enable additional gates on an already-modified profile', async () => {
			// Enable one gate
			await executeSetQaGates({ council_mode: true }, tempDir);

			// Enable another on top
			const result = await executeSetQaGates({ sme_enabled: true }, tempDir);
			expect(result.success).toBe(true);

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile!.gates.council_mode).toBe(true);
			expect(profile!.gates.sme_enabled).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// PROFILE PERSISTENCE
	// -------------------------------------------------------------------------

	describe('profile persistence', () => {
		it('changes survive across multiple executeSetQaGates calls', async () => {
			// Call 1: enable mutation_test
			const r1 = await executeSetQaGates({ mutation_test: true }, tempDir);
			expect(r1.success).toBe(true);

			// Call 2: enable drift_check
			const r2 = await executeSetQaGates({ drift_check: true }, tempDir);
			expect(r2.success).toBe(true);

			// Both should be enabled
			const profile = getProfile(tempDir, r1.plan_id!);
			expect(profile!.gates.mutation_test).toBe(true);
			expect(profile!.gates.drift_check).toBe(true);
			// Default that was not overridden
			expect(profile!.gates.council_mode).toBe(DEFAULT_QA_GATES.council_mode);
		});

		it('profile data is readable after closeProjectDb and re-open', async () => {
			// Modify gates
			await executeSetQaGates(
				{ final_council: true, phase_council: true },
				tempDir,
			);

			// Close and reopen the DB
			closeProjectDb(tempDir);

			// Read the profile — should still reflect the changes
			const profile = getProfile(tempDir, 'test-swarm-Test_Plan');
			expect(profile).not.toBeNull();
			expect(profile!.gates.final_council).toBe(true);
			expect(profile!.gates.phase_council).toBe(true);
		});

		it('profile persists to disk and survives tempDir reuse', async () => {
			// Enable gates on tempDir
			await executeSetQaGates(
				{ sme_enabled: true, hallucination_guard: true },
				tempDir,
			);

			const planId = 'test-swarm-Test_Plan';

			// Close DB
			closeProjectDb(tempDir);

			// Re-read before tempDir cleanup
			const profile = getProfile(tempDir, planId);
			expect(profile).not.toBeNull();
			expect(profile!.gates.sme_enabled).toBe(true);
			expect(profile!.gates.hallucination_guard).toBe(true);
		});

		it('computeProfileHash returns stable hash for same gates', async () => {
			const result1 = await executeSetQaGates({ council_mode: true }, tempDir);
			expect(result1.profile).toBeDefined();
			const hash1 = result1.profile!.profile_hash;

			// Same gates should produce same hash
			const result2 = await executeSetQaGates({ council_mode: true }, tempDir);
			expect(result2.profile).toBeDefined();
			const hash2 = result2.profile!.profile_hash;

			expect(hash1).toBe(hash2);
		});

		it('different gates produce different profile hashes', async () => {
			const result1 = await executeSetQaGates({ council_mode: true }, tempDir);
			const hash1 = result1.profile!.profile_hash;

			// Use mutation_test: true which is false in DEFAULT_QA_GATES
			const result2 = await executeSetQaGates({ mutation_test: true }, tempDir);
			const hash2 = result2.profile!.profile_hash;

			expect(hash1).not.toBe(hash2);
		});
	});

	// -------------------------------------------------------------------------
	// SCHEMA VALIDATION (via set_qa_gates tool)
	// -------------------------------------------------------------------------

	describe('schema validation', () => {
		it('unknown gate names are stripped by Zod', async () => {
			// We test via the result — if an unknown gate were accepted, the
			// profile would have an extra property that does not exist in QaGates
			// Since we use executeSetQaGates directly, unknown keys are ignored
			// by the implementation's own gate-key filter
			const result = await executeSetQaGates(
				{ reviewer: true, not_a_real_gate: true } as SetQaGatesArgs,
				tempDir,
			);
			expect(result.success).toBe(true);

			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			// only 'reviewer' should be true; no extra gates
			expect(Object.keys(profile!.gates)).toHaveLength(ALL_GATE_NAMES.length);
		});
	});
});
