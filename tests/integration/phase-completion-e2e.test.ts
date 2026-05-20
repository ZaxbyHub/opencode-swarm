import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { executePhaseComplete } from '../../src/tools/phase-complete';

/**
 * E2E phase completion validation test.
 *
 * Tests the v6.36 architecture change where:
 * 1. architect delegates to critic_drift_verifier BEFORE calling phase_complete
 * 2. critic_drift_verifier writes .swarm/evidence/{phase}/drift-verifier.json with verdict='approved'
 * 3. phase_complete reads that evidence and passes the drift gate
 * 4. Without the evidence file, phase_complete blocks with DRIFT_VERIFICATION_MISSING (when spec.md exists)
 */
describe('phase_complete E2E — drift evidence → phase_complete reads it and succeeds', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	/**
	 * Helper: create a per-test temp dir with proper structure, call fn, then cleanup.
	 * Eliminates shared mutable state across concurrent tests.
	 */
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-e2e-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: ['coder'],
					require_docs: false,
					policy: 'enforce',
					regression_sweep: { enforce: false },
				},
				curator: {
					enabled: false,
					phase_enabled: false,
				},
			}),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
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
								status: 'completed',
								description: 'Test task',
							},
						],
					},
				],
			}),
		);
		try {
			return await fn(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	/**
	 * Helper: write a valid retrospective bundle for a phase
	 */
	function writeRetroBundle(dir: string, phaseNumber: number): void {
		const retroDir = path.join(
			dir,
			'.swarm',
			'evidence',
			`retro-${phaseNumber}`,
		);
		fs.mkdirSync(retroDir, { recursive: true });

		const retroBundle = {
			schema_version: '1.0.0',
			task_id: `retro-${phaseNumber}`,
			entries: [
				{
					task_id: `retro-${phaseNumber}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: `Phase ${phaseNumber} retrospective`,
					phase_number: phaseNumber,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: ['Test lesson'],
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify(retroBundle, null, 2),
		);
	}

	/**
	 * Helper: write drift-verifier.json evidence for a phase
	 */
	function writeDriftEvidence(
		dir: string,
		phaseNumber: number,
		verdict: 'approved' | 'rejected',
		summary: string,
	): void {
		const driftDir = path.join(dir, '.swarm', 'evidence', String(phaseNumber));
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

	/**
	 * Helper: create spec.md in .swarm directory
	 */
	function writeSpecMd(dir: string): void {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'spec.md'),
			'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
		);
	}

	/**
	 * Helper: set up a session with the required agents dispatched
	 */
	function setupSessionWithAgents(): void {
		ensureAgentSession('test-session');
		recordPhaseAgentDispatch('test-session', 'coder');
		// Explicitly disable turbo mode to prevent interference
		swarmState.agentSessions.get('test-session')!.turboMode = false;
	}

	describe('Drift Gate Scenarios', () => {
		test('1. drift-verifier.json approved + spec.md exists → phase_complete succeeds', async () => {
			await withTempDir(async (dir) => {
				// Arrange: critic_drift_verifier wrote approved drift evidence
				writeSpecMd(dir);
				writeDriftEvidence(
					dir,
					1,
					'approved',
					'No drift detected. Phase is clean.',
				);
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert: phase_complete reads the evidence and passes the gate
				expect(result.success).toBe(true);
				expect(result.status).toBe('success');
				expect(result.reason).toBeUndefined();
				expect(result.warnings).toHaveLength(0);
			});
		});

		test('2. drift-verifier.json missing + spec.md exists → blocks with DRIFT_VERIFICATION_MISSING', async () => {
			await withTempDir(async (dir) => {
				// Arrange: critic_drift_verifier was NOT run (no evidence written)
				writeSpecMd(dir);
				// DO NOT write drift-verifier.json
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert: phase_complete blocks because spec.md exists and no drift evidence
				expect(result.success).toBe(false);
				expect(result.status).toBe('blocked');
				expect(result.reason).toBe('DRIFT_VERIFICATION_MISSING');
				expect(result.message).toContain(
					'.swarm/evidence/1/drift-verifier.json',
				);
			});
		});

		test('3. drift-verifier.json with verdict=rejected → blocks with DRIFT_VERIFICATION_REJECTED', async () => {
			await withTempDir(async (dir) => {
				// Arrange: critic_drift_verifier returned rejected verdict
				writeSpecMd(dir);
				writeDriftEvidence(
					dir,
					1,
					'rejected',
					'Implementation has drift from spec.',
				);
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert: phase_complete blocks with rejected verdict
				expect(result.success).toBe(false);
				expect(result.status).toBe('blocked');
				expect(result.reason).toBe('DRIFT_VERIFICATION_REJECTED');
				expect(result.message).toContain('drift verifier returned verdict');
			});
		});

		test('5. no spec.md + no drift-verifier.json → phase_complete succeeds with warning (advisory mode)', async () => {
			await withTempDir(async (dir) => {
				// Arrange: no spec.md means drift verification is advisory-only
				// DO NOT write spec.md
				// DO NOT write drift-verifier.json
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert: phase_complete succeeds with advisory warning
				expect(result.success).toBe(true);
				expect(result.status).toBe('success');
				// Should have warning about no spec.md and drift verification missing
				expect(result.warnings).toSatisfy((w: string[]) =>
					w.some(
						(warning) =>
							warning.includes('No spec.md found') ||
							warning.includes('consider running critic_drift_verifier'),
					),
				);
			});
		});

		test('10. first-pass: drift step runs, writer emits correct artifact, phase_complete passes on single invocation', async () => {
			await withTempDir(async (dir) => {
				// Simulate the correct flow:
				// 1. Architect delegates to critic_drift_verifier (returns APPROVED)
				// 2. Architect calls write_drift_evidence (writes artifact)
				// 3. Architect calls phase_complete ONCE — must succeed without a second call

				// Step 1: Write spec.md (drift gate is active when spec.md exists)
				fs.writeFileSync(
					path.join(dir, '.swarm', 'spec.md'),
					'# Test Spec\nFR-001: Test requirement',
				);

				// Step 2: Write retro evidence using the existing helper (required by phase_complete)
				writeRetroBundle(dir, 1);

				// Step 3: Write drift-verifier.json (simulates architect calling write_drift_evidence after critic returns)
				const evidenceDir = path.join(dir, '.swarm', 'evidence', '1');
				fs.mkdirSync(evidenceDir, { recursive: true });
				const driftEvidence = {
					entries: [
						{
							type: 'drift-verification',
							verdict: 'approved',
							summary: 'All Phase 1 tasks verified as implemented',
							timestamp: new Date().toISOString(),
						},
					],
				};
				fs.writeFileSync(
					path.join(evidenceDir, 'drift-verifier.json'),
					JSON.stringify(driftEvidence),
				);

				// Step 4: Set up required swarm state
				const sessionId = 'test-session-first-pass';
				ensureAgentSession(sessionId, 'architect');
				recordPhaseAgentDispatch(sessionId, 'coder');

				// Step 5: Call phase_complete ONCE — must succeed on first invocation
				const result = await executePhaseComplete(
					{ phase: 1, sessionID: sessionId },
					dir,
				);
				const parsed = JSON.parse(result);

				// Verify: succeeded on first call, no second call needed
				expect(parsed.success).toBe(true);
				expect(parsed.status).not.toBe('blocked');
				expect(parsed.status).not.toBe('error');

				// Verify: drift evidence was read correctly (not missing)
				expect(parsed.message ?? '').not.toContain(
					'DRIFT_VERIFICATION_MISSING',
				);
				expect(parsed.message ?? '').not.toContain(
					'DRIFT_VERIFICATION_REJECTED',
				);
			});
		});
	});

	describe('Evidence File Format Variations', () => {
		test('6. drift evidence with type=diff instead of drift → treated as missing', async () => {
			await withTempDir(async (dir) => {
				// Arrange: evidence written but with wrong type field
				writeSpecMd(dir);
				const driftDir = path.join(dir, '.swarm', 'evidence', '1');
				fs.mkdirSync(driftDir, { recursive: true });
				fs.writeFileSync(
					path.join(driftDir, 'drift-verifier.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: 'drift-verifier-1',
						entries: [
							{
								task_id: 'drift-verifier-1',
								type: 'diff_review', // wrong type, doesn't contain 'drift'
								verdict: 'approved',
								summary: 'Review passed',
							},
						],
					}),
				);
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert: no drift entry found → treated as missing
				expect(result.success).toBe(false);
				expect(result.status).toBe('blocked');
				expect(result.reason).toBe('DRIFT_VERIFICATION_MISSING');
			});
		});

		test('7. drift evidence with empty entries array → treated as missing', async () => {
			await withTempDir(async (dir) => {
				// Arrange: evidence file exists but entries array is empty
				writeSpecMd(dir);
				const driftDir = path.join(dir, '.swarm', 'evidence', '1');
				fs.mkdirSync(driftDir, { recursive: true });
				fs.writeFileSync(
					path.join(driftDir, 'drift-verifier.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: 'drift-verifier-1',
						entries: [],
					}),
				);
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert
				expect(result.success).toBe(false);
				expect(result.status).toBe('blocked');
				expect(result.reason).toBe('DRIFT_VERIFICATION_MISSING');
			});
		});

		test('8. drift evidence with invalid JSON → treated as missing', async () => {
			await withTempDir(async (dir) => {
				// Arrange: evidence file exists but contains invalid JSON
				writeSpecMd(dir);
				const driftDir = path.join(dir, '.swarm', 'evidence', '1');
				fs.mkdirSync(driftDir, { recursive: true });
				fs.writeFileSync(
					path.join(driftDir, 'drift-verifier.json'),
					'{ invalid json } garbage',
				);
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert
				expect(result.success).toBe(false);
				expect(result.status).toBe('blocked');
				expect(result.reason).toBe('DRIFT_VERIFICATION_MISSING');
			});
		});
	});

	describe('Multi-Entry Drift Evidence', () => {
		test('9. multiple entries in drift evidence, only one with drift type → uses that entry', async () => {
			await withTempDir(async (dir) => {
				// Arrange: multiple entries but only one has type containing 'drift'
				writeSpecMd(dir);
				const driftDir = path.join(dir, '.swarm', 'evidence', '1');
				fs.mkdirSync(driftDir, { recursive: true });
				fs.writeFileSync(
					path.join(driftDir, 'drift-verifier.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: 'drift-verifier-1',
						entries: [
							{
								task_id: 'drift-verifier-1',
								type: 'review',
								verdict: 'pass',
								summary: 'Review passed',
							},
							{
								task_id: 'drift-verifier-1',
								type: 'drift',
								verdict: 'approved',
								summary: 'No drift',
							},
						],
					}),
				);
				writeRetroBundle(dir, 1);
				setupSessionWithAgents();

				// Act
				const resultRaw = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				);
				const result = JSON.parse(resultRaw);

				// Assert: should use the drift entry
				expect(result.success).toBe(true);
				expect(result.status).toBe('success');
			});
		});
	});
});
