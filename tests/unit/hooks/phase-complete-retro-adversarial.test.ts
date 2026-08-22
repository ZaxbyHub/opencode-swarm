import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

// Import the tool after setting up environment
const { phase_complete } = await import('../../../src/tools/phase-complete');

describe('phase_complete retrospective gate - ADVERSARIAL ATTACKS', () => {
	let tempDir: string;
	let originalCwd: string;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();

		// Create temp directory using createIsolatedTestEnv
		const { configDir, cleanup } = createIsolatedTestEnv();
		tempDir = configDir;
		cleanupEnv = cleanup;
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory and evidence directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (cleanupEnv) {
			cleanupEnv();
		}
		// Reset state after each test
		resetSwarmState();
	});

	// Helper function to write a retro bundle with custom entries
	function writeRetroBundleWithEntries(taskId: string, entries: any[]): void {
		const retroDir = path.join(tempDir, '.swarm', 'evidence', taskId);
		fs.mkdirSync(retroDir, { recursive: true });

		const retroBundle = {
			schema_version: '1.0.0',
			task_id: taskId,
			entries: entries,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify(retroBundle, null, 2),
		);
	}

	// Helper function to write gate evidence files for Phase 4 mandatory gates
	function writeGateEvidence(phase: number): void {
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', `${phase}`);
		fs.mkdirSync(evidenceDir, { recursive: true });

		// Write completion-verify.json
		const completionVerify = {
			status: 'passed',
			tasksChecked: 1,
			tasksPassed: 1,
			tasksBlocked: 0,
			reason: 'All task identifiers found in source files',
		};
		fs.writeFileSync(
			path.join(evidenceDir, 'completion-verify.json'),
			JSON.stringify(completionVerify, null, 2),
		);

		// Write drift-verifier.json
		const driftVerifier = {
			schema_version: '1.0.0',
			task_id: 'drift-verifier',
			entries: [
				{
					task_id: 'drift-verifier',
					type: 'drift_verification',
					timestamp: new Date().toISOString(),
					agent: 'critic',
					verdict: 'approved',
					summary: 'Drift check passed',
				},
			],
		};
		fs.writeFileSync(
			path.join(evidenceDir, 'drift-verifier.json'),
			JSON.stringify(driftVerifier, null, 2),
		);
	}

	describe('Attack Vector 1: Path traversal in phase number', () => {
		test('phase = NaN should be rejected (sanitization)', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// Attempt to call phase_complete with phase = NaN
			const result = await phase_complete.execute({
				phase: NaN,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be rejected at argument validation, not retro gate
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = Infinity should be blocked at retro gate', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: Infinity,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Infinity is not < 1, so argument validation passes
			// But retro gate should block since retro-Infinity won't exist
			expect(parsed.success).toBe(false);
			expect(
				parsed.status === 'blocked' ||
					parsed.message === 'Invalid phase number',
			).toBe(true);
		});

		test('phase = -1 should be rejected at argument validation', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: -1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = 0 should be rejected at argument validation', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 0,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = 1.5 (float) should be rejected at argument validation', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1.5,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// 1.5 is not an integer, so argument validation rejects it
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = 9999999 (very large number) should be blocked by retro gate', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 9999999,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
		});
	});

	describe('Attack Vector 2: Prototype pollution via entry object', () => {
		test('entry with __proto__ pollution is blocked by Zod validation', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// Create a malicious object with __proto__
			// Note: JSON.stringify will not serialize prototype properties, so this will fail validation
			const maliciousEntry = Object.create(null);
			maliciousEntry.type = 'retrospective';
			maliciousEntry.phase_number = 1;
			maliciousEntry.verdict = 'pass';

			writeRetroBundleWithEntries('retro-1', [maliciousEntry]);
			writeGateEvidence(1);

			// Zod validation rejects the bundle because it's missing required fields
			// (JSON.stringify doesn't serialize properties correctly from Object.create(null))
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked because the bundle fails validation
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect([
				'RETROSPECTIVE_SCHEMA_INVALID',
				'SNAPSHOT_IDENTITY_ERROR',
			]).toContain(parsed.reason);
			const decisiveGate = parsed.gate_report.entries.find(
				(entry: { code: string }) => entry.code === parsed.reason,
			);
			expect(['block', 'error']).toContain(decisiveGate?.outcome);
		});

		test('entry with inherited properties is blocked by Zod validation', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// Create an entry with properties on prototype
			// Note: JSON.stringify won't include prototype properties, so validation fails
			const proto = { phase_number: 1 };
			const entry = Object.create(proto);
			entry.type = 'retrospective';
			entry.verdict = 'pass';

			writeRetroBundleWithEntries('retro-1', [entry]);
			writeGateEvidence(1);

			// Zod validation rejects the bundle (missing required fields)
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect([
				'RETROSPECTIVE_SCHEMA_INVALID',
				'SNAPSHOT_IDENTITY_ERROR',
			]).toContain(parsed.reason);
			const decisiveEntries = parsed.gate_report.entries.filter(
				(entry: { id: string; outcome: string }) =>
					(entry.id === 'retrospective' || entry.id === 'snapshot_identity') &&
					(entry.outcome === 'block' || entry.outcome === 'error'),
			);
			expect(decisiveEntries.length).toBeGreaterThan(0);
		});
	});

	describe('Attack Vector 3: Type confusion via JSON coercion', () => {
		test('phase_number as string "1" should fail strict equality check', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// Write entry with phase_number as string "1" instead of number 1
			writeRetroBundleWithEntries('retro-1', [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: '1', // String instead of number
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should fail because phase_number "1" !== 1 (strict equality)
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});

		test('phase_number = true should fail strict equality check', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: true, // Boolean instead of number
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});
	});

	describe('Attack Vector 4: verdict bypass via case', () => {
		test('verdict = "Pass" (capital P) should be rejected', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'Pass', // Capital P
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});

		test('verdict = "PASS" should be rejected', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'PASS', // All caps
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});
	});

	describe('Attack Vector 5: Large entry array denial-of-service', () => {
		test('bundle with 100,000 non-retro entries before valid retro is rejected closed', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// Create 100,000 non-retro entries
			const largeEntries = [];
			for (let i = 0; i < 100000; i++) {
				largeEntries.push({
					task_id: 'retro-1',
					type: 'note',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'info',
					summary: `Note ${i}`,
				});
			}

			// Add valid retro at the end
			largeEntries.push({
				task_id: 'retro-1',
				type: 'retrospective',
				timestamp: new Date().toISOString(),
				agent: 'architect',
				verdict: 'pass',
				summary: 'Phase retrospective',
				metadata: {},
				phase_number: 1,
				total_tool_calls: 10,
				coder_revisions: 1,
				reviewer_rejections: 0,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_count: 5,
				task_complexity: 'moderate',
				top_rejection_reasons: [],
				lessons_learned: ['Lesson 1'],
			});

			writeRetroBundleWithEntries('retro-1', largeEntries);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect([
				'RETROSPECTIVE_SCHEMA_INVALID',
				'SNAPSHOT_IDENTITY_ERROR',
			]).toContain(parsed.reason);
			const decisiveEntries = parsed.gate_report.entries.filter(
				(entry: { id: string; outcome: string }) =>
					(entry.id === 'retrospective' || entry.id === 'snapshot_identity') &&
					(entry.outcome === 'block' || entry.outcome === 'error'),
			);
			expect(decisiveEntries.length).toBeGreaterThan(0);
		}, 30000); // 30 second timeout for this DoS test
	});

	describe('Attack Vector 6: Null entry in entries array', () => {
		test('entries array with null should not crash and should block', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				null, // Null entry
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			// This should either crash (TypeError: Cannot read property 'type' of null)
			// or it should handle it gracefully
			// Let's see what happens
			try {
				const result = await phase_complete.execute({
					phase: 1,
					sessionID: 'sess1',
				});
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(false);
				expect(parsed.status).toBe('blocked');
				expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
				expect(parsed.message).toContain('Schema validation failed');
			} catch (error) {
				// If it crashes, that's a bug - report it
				expect.fail(`Crashed with null entry: ${error}`);
			}
		});
	});

	describe('Attack Vector 7: Integer overflow in phase', () => {
		test('phase = 2147483648 (max safe int + 1) should be handled', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 2147483648,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked because retro-2147483648 doesn't exist
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
		});

		test('phase = Number.MAX_SAFE_INTEGER should be handled', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: Number.MAX_SAFE_INTEGER,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
		});
	});

	describe('Attack Vector 8: Empty string verdict', () => {
		test('verdict = "" should be rejected', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: '', // Empty string
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});
	});

	describe('Attack Vector 9: Phase_number = 0 with phase = 1', () => {
		test('phase_number = 0 should not match phase = 1', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 0, // Should not match phase = 1
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: [],
					lessons_learned: ['Lesson 1'],
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});
	});

	describe('Additional attack: Missing required fields', () => {
		test('entry missing type should not bypass gate', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					// Missing 'type' field
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});

		test('entry missing verdict should not bypass gate', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			writeRetroBundleWithEntries('retro-1', [
				{
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					// Missing 'verdict' field
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
				},
			]);
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toContain('Schema validation failed');
		});
	});
});
