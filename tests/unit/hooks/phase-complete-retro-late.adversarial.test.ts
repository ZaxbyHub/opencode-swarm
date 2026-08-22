import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const { phase_complete } = await import('../../../src/tools/phase-complete');

describe('phase_complete retrospective gate - ADVERSARIAL ATTACKS', () => {
	let tempDir: string;
	let originalCwd: string;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		resetSwarmState();

		const { configDir, cleanup } = createIsolatedTestEnv();
		tempDir = configDir;
		cleanupEnv = cleanup;
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (cleanupEnv) {
			cleanupEnv();
		}
		resetSwarmState();
	});

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

	function writeGateEvidence(phase: number): void {
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', `${phase}`);
		fs.mkdirSync(evidenceDir, { recursive: true });

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
		}, 30000);
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
				null,
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
		test('verdict = \"\" should be rejected', async () => {
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
					verdict: '',
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
					phase_number: 0,
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
