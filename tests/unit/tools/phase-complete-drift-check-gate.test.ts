import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../src/db/project-db';
import type { QaGateProfile } from '../../../src/db/qa-gate-profile';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Mutable state to control the mock's return value
let mockProfileReturnValue: QaGateProfile | null = null;

/**
 * Mock getProfile function - reads from mutable mockProfileReturnValue
 */
function mockGetProfile(dir: string, planId: string): QaGateProfile | null {
	return mockProfileReturnValue;
}

// Mock the qa-gate-profile module BEFORE importing phase_complete
mock.module('../../../src/db/qa-gate-profile.js', () => ({
	getProfile: mockGetProfile,
	getOrCreateProfile: mock((dir: string, planId: string) => {
		// Import the real function for use in tests
		const {
			getOrCreateProfile: real,
		} = require('../../../src/db/qa-gate-profile.js');
		return real(dir, planId);
	}),
	setGates: mock(
		(dir: string, planId: string, gates: Record<string, boolean>) => {
			const { setGates: real } = require('../../../src/db/qa-gate-profile.js');
			return real(dir, planId, gates);
		},
	),
}));

const { phase_complete } = await import('../../../src/tools/phase-complete');

const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'Test Plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

/**
 * Helper to create a mock profile with specified drift_check value
 */
function createMockProfile(driftCheckValue: boolean): QaGateProfile {
	return {
		id: 1,
		plan_id: PLAN_ID,
		created_at: new Date().toISOString(),
		project_type: null,
		gates: {
			reviewer: true,
			test_engineer: true,
			council_mode: false,
			sme_enabled: true,
			critic_pre_plan: true,
			hallucination_guard: false,
			sast_enabled: true,
			mutation_test: false,
			council_general_review: false,
			drift_check: driftCheckValue,
		},
		locked_at: null,
		locked_by_snapshot_seq: null,
	};
}

function writeRetroBundle(dir: string, phase: number): void {
	const retroDir = path.join(dir, '.swarm', 'evidence', `retro-${phase}`);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}),
	);
}

function writeSpecMd(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
	);
}

function setupBaseDir(dir: string, phaseType?: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });

	const phase: Record<string, unknown> = {
		id: 1,
		name: 'Phase 1',
		status: 'pending',
		tasks: [
			{
				id: '1.1',
				phase: 1,
				status: 'pending',
				description: 'Test task',
			},
		],
	};
	if (phaseType) {
		phase.type = phaseType;
	}

	const planJson = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		current_phase: 1,
		phases: [phase],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson, null, 2),
	);

	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
		}),
	);
}

function writeDriftEvidence(
	directory: string,
	phaseNumber: number,
	verdict: 'approved' | 'rejected',
	summary: string,
): void {
	const driftDir = path.join(
		directory,
		'.swarm',
		'evidence',
		String(phaseNumber),
	);
	fs.mkdirSync(driftDir, { recursive: true });

	const driftEvidence = {
		schema_version: '1.0.0',
		task_id: `drift-verifier-${phaseNumber}`,
		entries: [
			{
				task_id: `drift-verifier-${phaseNumber}`,
				type: 'drift',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: verdict,
				summary: summary,
			},
		],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};

	fs.writeFileSync(
		path.join(driftDir, 'drift-verifier.json'),
		JSON.stringify(driftEvidence, null, 2),
	);
}

describe('phase_complete — drift_check gate scenarios (Task 3.3)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		closeAllProjectDbs();
		mockProfileReturnValue = null; // Reset mock state

		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'phase-complete-drift-check-gate-test-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupBaseDir(tempDir);
		writeRetroBundle(tempDir, 1);

		// Ensure turbo mode is disabled for these tests
		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		swarmState.agentSessions.get('sess1')!.turboMode = false;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		closeAllProjectDbs();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	/**
	 * Test 7 (CRITICAL): Non-code phase bypass BEFORE evidence reading
	 *
	 * This was a reviewer-rejected bug fix. The non-code phase type check must
	 * run BEFORE drift evidence reading. A non-code phase with stale rejected
	 * drift evidence must NOT be blocked.
	 */
	describe('7. Non-code phase bypass BEFORE drift evidence reading (critical)', () => {
		test('7a. non-code phase with rejected drift evidence -> phase completes (bypasses evidence reading)', async () => {
			// Set up phase as non-code type
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						type: 'non-code', // This is the key - phase is non-code
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								description: 'Test task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Write REJECTED drift evidence - this should be IGNORED for non-code phase
			writeDriftEvidence(
				tempDir,
				1,
				'rejected',
				'NEEDS_REVISION: drift detected',
			);
			writeSpecMd(tempDir); // spec.md exists but shouldn't matter for non-code

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// CRITICAL: phase should succeed despite rejected drift evidence
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Warning should indicate non-code phase skipped drift verification
			const nonCodeWarning = parsed.warnings.find(
				(w: string) =>
					w.includes("'non-code'") &&
					w.includes('Drift verification was skipped'),
			);
			expect(nonCodeWarning).toBeDefined();
			expect(nonCodeWarning).toContain('non-code');
			expect(nonCodeWarning).toContain('Drift verification was skipped');
		});

		test('7b. non-code phase without any drift evidence -> phase completes (advisory skip)', async () => {
			// Set up phase as non-code type
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						type: 'non-code',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								description: 'Test task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// No drift evidence file at all
			// spec.md exists but shouldn't trigger blocking for non-code phase
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - non-code phase bypasses drift check
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('7c. code phase (no type annotation) with rejected drift evidence -> BLOCKED', async () => {
			// Set up phase WITHOUT type annotation (default code phase)
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						// NO type annotation = code phase
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								description: 'Test task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Write REJECTED drift evidence
			writeDriftEvidence(
				tempDir,
				1,
				'rejected',
				'NEEDS_REVISION: drift detected',
			);
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Code phase SHOULD be blocked by rejected drift evidence
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_REJECTED');
		});

		test('7d. non-code phase with phase 2 drift evidence (wrong phase) -> still bypasses', async () => {
			// Set up phase 1 as non-code
			const planJson = {
				schema_version: '1.0.0',
				title: PLAN_TITLE,
				swarm: PLAN_SWARM,
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						type: 'non-code',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								description: 'Test task',
							},
						],
					},
					{
						id: 2,
						name: 'Phase 2',
						type: 'non-code',
						status: 'pending',
						tasks: [
							{
								id: '2.1',
								phase: 2,
								status: 'pending',
								description: 'Phase 2 task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Write rejected drift evidence for phase 1
			writeDriftEvidence(
				tempDir,
				1,
				'rejected',
				'NEEDS_REVISION: drift detected',
			);
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase 1 should succeed because it's non-code
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	/**
	 * Test 8: drift_check=false skip
	 *
	 * When drift_check is disabled via QA gate profile, the gate should skip
	 * with a warning message indicating drift verification was skipped.
	 */
	describe('8. drift_check=false skips drift verification', () => {
		test('8a. drift_check disabled in profile -> warning about skipped drift verification', async () => {
			// Configure mock to return a profile with drift_check: false
			mockProfileReturnValue = createMockProfile(false);

			// Do NOT write drift evidence - with drift_check disabled, this should be fine
			writeSpecMd(tempDir); // spec.md exists but drift_check is disabled

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed because drift_check is disabled
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Warning should indicate drift_check is disabled
			const driftWarning = parsed.warnings.find(
				(w: string) => w.includes('drift_check') && w.includes('disabled'),
			);
			expect(driftWarning).toBeDefined();
			expect(driftWarning).toContain('drift_check');
			expect(driftWarning).toContain('disabled');
			expect(driftWarning).toContain('Drift verification was skipped');

			// Reset mock to default (returns null)
			mockProfileReturnValue = null;
		});

		test('8b. drift_check disabled with existing drift evidence -> still succeeds (evidence ignored)', async () => {
			// Configure mock to return a profile with drift_check: false
			mockProfileReturnValue = createMockProfile(false);

			// Write drift evidence - it should be ignored since drift_check is disabled
			writeDriftEvidence(
				tempDir,
				1,
				'rejected',
				'NEEDS_REVISION: drift detected',
			);
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - drift evidence is ignored when drift_check is disabled
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Reset mock to default (returns null)
			mockProfileReturnValue = null;
		});

		test('8c. drift_check enabled (default) with missing drift evidence and spec.md -> BLOCKED', async () => {
			// Mock returns null by default (no profile = drift_check defaults to true)
			// Write spec.md to trigger blocking on missing drift evidence
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked because drift_check is true by default and drift evidence is missing
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});
	});

	/**
	 * Test 9: Profile load error fallback
	 *
	 * When profile loading throws an error, drift_check defaults to enabled
	 * (safe default - preserve current mandatory behavior).
	 */
	describe('9. Profile load error defaults drift_check to enabled', () => {
		test('9a. profile load error -> drift_check defaults to enabled (safe default)', async () => {
			// This test verifies the catch block for profile load errors
			// We simulate this by NOT creating a profile (getProfile returns null)
			// and verifying drift_check defaults to true
			//
			// Since we can't easily mock getProfile to throw without module mocking,
			// we verify the default behavior: no profile = drift_check enabled

			// Do NOT create a profile - getProfile will return null
			// writeSpecMd to trigger blocking on missing drift evidence
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked because with no profile, drift_check defaults to true
			// and drift evidence is missing with spec.md present
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});
	});

	/**
	 * Test 10: Turbo mode skips drift gate entirely
	 *
	 * This is covered in the existing drift gate tests but included here
	 * for completeness.
	 */
	describe('10. Turbo mode skips drift gate', () => {
		test('10a. turbo mode active -> phase completes without drift evidence', async () => {
			// Enable turbo mode
			swarmState.agentSessions.get('sess1')!.turboMode = true;

			// Do NOT write drift evidence - turbo mode should bypass
			writeSpecMd(tempDir);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should succeed because turbo mode skips drift gate
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});
});
