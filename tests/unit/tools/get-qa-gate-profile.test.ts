/**
 * Tests for src/tools/get-qa-gate-profile.ts (FR-009).
 *
 * Tests the three observable outcomes of the get_qa_gate_profile tool:
 * 1. Current gate values returned (reviewer, test_engineer, sme_enabled, etc.)
 * 2. Lock state returned (locked_at, locked_by_snapshot_seq)
 * 3. Profile hash returned (SHA-256 hex digest for change detection)
 *
 * Note: loadPlanJsonOnly is called directly by executeGetQaGateProfile (not via
 * _internals), so tests that need a plan write a real plan.json to disk.
 * getProfile is called via _internals so it can be mocked for isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	type QaGateProfile,
	_internals as qaGateProfileInternals,
} from '../../../src/db/qa-gate-profile';
import { derivePlanId } from '../../../src/plan/utils';
import { executeGetQaGateProfile } from '../../../src/tools/get-qa-gate-profile';

// -----------------------------------------------------------------------
// Module-level state for _internals overrides
// -----------------------------------------------------------------------
// Store original getProfile before any test can mutate it
const { getProfile: originalGetProfile } = qaGateProfileInternals;

let testDir: string;
let cleanupDir2: string | null = null;

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(tmpdir(), 'get-qa-gate-profile-test-'));
	// Windows: resolve symlink to real tmpdir path so DB path matching works
	try {
		testDir = fs.realpathSync(testDir);
	} catch {
		// realpathSync throws on older Windows; use as-is
	}
	// Reset _internals.getProfile to the real implementation before each test
	qaGateProfileInternals.getProfile = originalGetProfile;
});

afterEach(() => {
	closeAllProjectDbs();
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
	if (cleanupDir2) {
		closeAllProjectDbs();
		try {
			fs.rmSync(cleanupDir2, { recursive: true, force: true });
		} catch {
			// ignore
		}
		cleanupDir2 = null;
	}
	// Restore _internals.getProfile
	qaGateProfileInternals.getProfile = originalGetProfile;
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Write a minimal plan.json into the test directory. */
function writePlanJson(
	dir: string,
	overrides: { swarm?: string; title?: string } = {},
): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: overrides.swarm ?? 'mega',
			title: overrides.title ?? 'test_project',
			phases: [{ id: 1, name: 'Phase 1', tasks: [] }],
		}),
		'utf-8',
	);
}

/** Create a QA gate profile directly in the DB via getOrCreateProfile. */
function createProfile(
	dir: string,
	planId: string,
	projectType = 'ts',
): QaGateProfile {
	const { getOrCreateProfile } = qaGateProfileInternals;
	return getOrCreateProfile(dir, planId, projectType);
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('get_qa_gate_profile — executeGetQaGateProfile', () => {
	// -------------------------------------------------------------------------
	// Outcome 1: plan_json_unavailable when no plan exists
	// -------------------------------------------------------------------------
	test('returns plan_json_unavailable when plan.json does not exist', async () => {
		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('plan_json_unavailable');
		expect(result.plan_id).toBeUndefined();
		expect(result.profile).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// Outcome 2: no_profile when plan exists but no profile in DB
	// -------------------------------------------------------------------------
	test('returns no_profile when plan.json exists but no profile has been created', async () => {
		writePlanJson(testDir);
		const planId = derivePlanId({ swarm: 'mega', title: 'test_project' });

		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('no_profile');
		expect(result.plan_id).toBe(planId);
		expect(result.profile).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// Outcome 3a: gates returned with correct boolean values for each gate flag
	// -------------------------------------------------------------------------
	test('returns all gate flags with correct boolean values', async () => {
		writePlanJson(testDir);
		const planId = derivePlanId({ swarm: 'mega', title: 'test_project' });

		// Create the profile via the DB directly
		const profile = createProfile(testDir, planId);

		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(true);
		expect(result.plan_id).toBe(planId);
		expect(result.profile).toBeDefined();

		const gates = result.profile!.gates;

		// All eleven gate flags must be present and be booleans
		const expectedGates = [
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

		for (const key of expectedGates) {
			expect(typeof gates[key]).toBe('boolean');
		}

		// Default values are seeded when profile is created
		expect(gates).toEqual(profile.gates);
	});

	// -------------------------------------------------------------------------
	// Outcome 3b: lock state returned (locked_at, locked_by_snapshot_seq)
	// -------------------------------------------------------------------------
	test('returns null lock state for unlocked profile', async () => {
		writePlanJson(testDir);
		const planId = derivePlanId({ swarm: 'mega', title: 'test_project' });

		createProfile(testDir, planId);

		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(true);
		expect(result.profile!.locked_at).toBeNull();
		expect(result.profile!.locked_by_snapshot_seq).toBeNull();
	});

	test('returns correct lock state for locked profile', async () => {
		writePlanJson(testDir);
		const planId = derivePlanId({ swarm: 'mega', title: 'test_project' });

		createProfile(testDir, planId);

		// Lock the profile with a snapshot seq — import lockProfile directly
		const { lockProfile } = await import('../../../src/db/qa-gate-profile');
		const locked = lockProfile(testDir, planId, 42);

		expect(locked.locked_at).not.toBeNull();
		expect(locked.locked_by_snapshot_seq).toBe(42);

		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(true);
		expect(result.profile!.locked_at).not.toBeNull();
		expect(result.profile!.locked_by_snapshot_seq).toBe(42);
	});

	// -------------------------------------------------------------------------
	// Outcome 3c: profile hash returned as SHA-256 hex string
	// -------------------------------------------------------------------------
	test('returns profile_hash as a valid SHA-256 hex string', async () => {
		writePlanJson(testDir);
		const planId = derivePlanId({ swarm: 'mega', title: 'test_project' });

		createProfile(testDir, planId);

		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(true);
		expect(typeof result.profile!.profile_hash).toBe('string');
		// SHA-256 produces exactly 64 hex characters
		expect(result.profile!.profile_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test('profile_hash changes when gates are updated', async () => {
		writePlanJson(testDir);
		const planId = derivePlanId({ swarm: 'mega', title: 'test_project' });

		createProfile(testDir, planId);

		const beforeResult = await executeGetQaGateProfile({}, testDir);
		const hashBefore = beforeResult.profile!.profile_hash;

		// Enable hallucination_guard via setGates
		const { setGates } = await import('../../../src/db/qa-gate-profile');
		setGates(testDir, planId, { hallucination_guard: true });

		const afterResult = await executeGetQaGateProfile({}, testDir);
		const hashAfter = afterResult.profile!.profile_hash;

		expect(hashAfter).not.toBe(hashBefore);
		// Both must still be valid SHA-256 hex strings
		expect(hashAfter).toMatch(/^[a-f0-9]{64}$/);
	});

	// -------------------------------------------------------------------------
	// Field correctness: all fields in the returned profile object
	// -------------------------------------------------------------------------
	test('returns all required fields in the profile object', async () => {
		writePlanJson(testDir, { title: 'another_test' });
		const planId = derivePlanId({ swarm: 'mega', title: 'another_test' });

		createProfile(testDir, planId);

		const result = await executeGetQaGateProfile({}, testDir);
		expect(result.success).toBe(true);

		const p = result.profile!;
		expect(typeof p.plan_id).toBe('string');
		expect(p.plan_id).toBe(planId);
		expect(p.project_type).toBe('ts');
		expect(typeof p.gates).toBe('object');
		// locked_at is null (typeof null === 'object') for unlocked profile
		expect(p.locked_at).toBeNull();
		expect(p.locked_by_snapshot_seq).toBeNull();
		expect(typeof p.created_at).toBe('string'); // ISO datetime string
		expect(typeof p.profile_hash).toBe('string');
	});

	// -------------------------------------------------------------------------
	// Isolation: different directory / plan_id combinations return independent results
	// -------------------------------------------------------------------------
	test('returns independent results for different directories', async () => {
		// Set up two separate directories with different plan.json files
		const dir2 = fs.mkdtempSync(
			path.join(tmpdir(), 'get-qa-gate-profile-test-dir2-'),
		);
		cleanupDir2 = dir2;

		// Resolve symlinks for consistency
		let resolvedDir2 = dir2;
		try {
			resolvedDir2 = fs.realpathSync(dir2);
		} catch {
			// use as-is
		}

		// Write different plans to each directory
		const swarmDir1 = path.join(testDir, '.swarm');
		const swarmDir2 = path.join(resolvedDir2, '.swarm');
		fs.mkdirSync(swarmDir1, { recursive: true });
		fs.mkdirSync(swarmDir2, { recursive: true });

		const planIdA = derivePlanId({ swarm: 'mega', title: 'project_a' });
		const planIdB = derivePlanId({ swarm: 'mega', title: 'project_b' });

		fs.writeFileSync(
			path.join(swarmDir1, 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				swarm: 'mega',
				title: 'project_a',
				phases: [{ id: 1, name: 'Phase 1', tasks: [] }],
			}),
			'utf-8',
		);
		fs.writeFileSync(
			path.join(swarmDir2, 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				swarm: 'mega',
				title: 'project_b',
				phases: [{ id: 1, name: 'Phase 1', tasks: [] }],
			}),
			'utf-8',
		);

		createProfile(testDir, planIdA);
		createProfile(resolvedDir2, planIdB);

		const resultA = await executeGetQaGateProfile({}, testDir);
		const resultB = await executeGetQaGateProfile({}, resolvedDir2);

		expect(resultA.plan_id).toBe(planIdA);
		expect(resultB.plan_id).toBe(planIdB);
		expect(resultA.plan_id).not.toBe(resultB.plan_id);
	});
});
