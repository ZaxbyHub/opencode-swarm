import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetGlobalEventBus } from '../../../src/background/event-bus';
import {
	_internals,
	runPreflight,
} from '../../../src/services/preflight-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalRunSecretscan = _internals.runSecretscan;

describe('Preflight Service', () => {
	let testDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		// Create a temporary test directory
		testDir = canonicalMkdtemp('preflight-test-');
	});

	afterEach(() => {
		_internals.runSecretscan = originalRunSecretscan;
		// Clean up test directory
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	function writePlanWithCompletedTask(): void {
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'spec.md'),
			'# Test Plan\n\n- FR-001 MUST be covered by implementation evidence.\n',
		);
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
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
								status: 'completed',
								size: 'small',
								description: 'Task 1.1',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
	}

	function writeDurableGateEvidence(taskId: string): void {
		const evidenceDir = path.join(testDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'review-session',
						timestamp: '2026-01-01T00:00:00.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test-session',
						timestamp: '2026-01-01T00:01:00.000Z',
						agent: 'test_engineer',
					},
				},
			}),
		);
	}

	function writeIncompleteDurableGateEvidence(taskId: string): void {
		const evidenceDir = path.join(testDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['critic', 'reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'review-session',
						timestamp: '2026-01-01T00:00:00.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test-session',
						timestamp: '2026-01-01T00:01:00.000Z',
						agent: 'test_engineer',
					},
				},
			}),
		);
	}

	function writeInvalidDurableGateEvidence(taskId: string): void {
		const evidenceDir = path.join(testDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['critic'],
			}),
		);
	}

	function writeLegacyEvidenceBundleDirectory(taskId: string): void {
		fs.mkdirSync(path.join(testDir, '.swarm', 'evidence', taskId), {
			recursive: true,
		});
	}
	describe('secrets check execution', () => {
		it('should run secrets check when not skipped and return pass for clean directory', async () => {
			// Run with secrets check NOT skipped - should hit the actual secrets check code path
			fs.writeFileSync(path.join(testDir, 'clean.txt'), 'clean\n');
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipEvidence: true,
				skipVersion: true,
				// skipSecrets is NOT set, so secrets check runs
			});

			const secretsCheck = report.checks.find((c) => c.type === 'secrets');
			expect(secretsCheck).toBeDefined();
			expect(['pass', 'skip']).toContain(secretsCheck?.status);
		});

		it('fails the secrets check when a requested file is oversized', async () => {
			fs.writeFileSync(path.join(testDir, 'clean.txt'), 'clean\n');
			fs.writeFileSync(
				path.join(testDir, 'oversized.txt'),
				Buffer.alloc(513 * 1024, 0x61),
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const secretsCheck = report.checks.find((c) => c.type === 'secrets');
			expect(secretsCheck?.status).toBe('fail');
			expect(secretsCheck?.message).toContain('incomplete file(s)');
			expect(secretsCheck?.details?.incompleteFiles).toBe(1);
			expect(secretsCheck?.details?.incompletePaths).toEqual([
				expect.objectContaining({
					path: expect.stringContaining('oversized.txt'),
					reason: 'oversized',
				}),
			]);
			expect(report.overall).toBe('fail');
		});

		it('fails the secrets check when zero files are scanned', async () => {
			fs.writeFileSync(
				path.join(testDir, 'screenshot.png'),
				Buffer.from([0x89]),
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const secretsCheck = report.checks.find((c) => c.type === 'secrets');
			expect(secretsCheck?.status).toBe('fail');
			expect(secretsCheck?.message).toContain('zero requested files scanned');
			expect(secretsCheck?.details?.filesScanned).toBe(0);
			expect(report.overall).toBe('fail');
		});

		it('fails closed when the scanner reports deadline-truncated coverage', async () => {
			_internals.runSecretscan = (async () => ({
				scan_dir: testDir,
				findings: [],
				count: 0,
				files_scanned: 1,
				skipped_files: 1,
				incomplete_files: 1,
				incomplete_paths: [{ path: 'later.txt', reason: 'deadline' }],
			})) as typeof _internals.runSecretscan;

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const secretsCheck = report.checks.find((c) => c.type === 'secrets');
			expect(secretsCheck?.status).toBe('fail');
			expect(secretsCheck?.message).toContain('later.txt (deadline)');
			expect(report.overall).toBe('fail');
		});
	});

	describe('evidence check execution', () => {
		it('should run evidence check when not skipped and return skip for directory without plan', async () => {
			// Run with evidence check NOT skipped - should hit the "No plan found" branch
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipVersion: true,
				// skipEvidence is NOT set, so evidence check runs
			});

			const evidenceCheck = report.checks.find((c) => c.type === 'evidence');
			expect(evidenceCheck).toBeDefined();
			expect(evidenceCheck?.status).toBe('skip');
			expect(evidenceCheck?.message).toContain('No plan found');
		});

		it('should pass completed tasks with only complete durable gate evidence', async () => {
			writePlanWithCompletedTask();
			writeDurableGateEvidence('1.1');

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipVersion: true,
			});

			const evidenceCheck = report.checks.find((c) => c.type === 'evidence');
			expect(evidenceCheck).toBeDefined();
			expect(evidenceCheck?.status).toBe('pass');
			expect(evidenceCheck?.message).toContain(
				'All 1 completed tasks have evidence',
			);
			expect(evidenceCheck?.details?.totalCompleted).toBe(1);
			expect(evidenceCheck?.details?.totalWithEvidence).toBe(1);
		});

		it('should fail completed tasks with legacy evidence but incomplete durable gates', async () => {
			writePlanWithCompletedTask();
			writeLegacyEvidenceBundleDirectory('1.1');
			writeIncompleteDurableGateEvidence('1.1');

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipVersion: true,
			});

			const evidenceCheck = report.checks.find((c) => c.type === 'evidence');
			expect(evidenceCheck).toBeDefined();
			expect(evidenceCheck?.status).toBe('fail');
			expect(evidenceCheck?.message).toContain(
				'1 completed task(s) missing evidence',
			);
			expect(evidenceCheck?.details?.totalCompleted).toBe(1);
			expect(evidenceCheck?.details?.totalWithEvidence).toBe(0);
			expect(evidenceCheck?.details?.missingTasks).toContain('1.1');
		});

		it('should fail completed tasks with legacy evidence but invalid durable gates', async () => {
			writePlanWithCompletedTask();
			writeLegacyEvidenceBundleDirectory('1.1');
			writeInvalidDurableGateEvidence('1.1');

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipVersion: true,
			});

			const evidenceCheck = report.checks.find((c) => c.type === 'evidence');
			expect(evidenceCheck).toBeDefined();
			expect(evidenceCheck?.status).toBe('fail');
			expect(evidenceCheck?.message).toContain(
				'1 completed task(s) missing evidence',
			);
			expect(evidenceCheck?.details?.totalCompleted).toBe(1);
			expect(evidenceCheck?.details?.totalWithEvidence).toBe(0);
			expect(evidenceCheck?.details?.missingTasks).toContain('1.1');
		});
	});
});
