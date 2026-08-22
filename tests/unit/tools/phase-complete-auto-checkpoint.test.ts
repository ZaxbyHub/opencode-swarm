import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureAgentSession, resetSwarmState } from '../../../src/state';

// Import tools after setting up environment
const { phase_complete } = await import('../../../src/tools/phase-complete');

// phase_complete performs the full preflight twice (including bounded Git and
// evidence checks) before the single plan transition. Multi-phase cases invoke
// it repeatedly and need a file-level budget above Bun's 5-second default.
setDefaultTimeout(60_000);

describe('phase_complete auto-checkpoint trigger', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();

		// Create temp directory
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'auto-checkpoint-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Initialize a git repo in temp directory
		execSync('git init', { encoding: 'utf-8' });
		execSync('git config --local commit.gpgsign false', { encoding: 'utf-8' });
		execSync('git config user.email "test@test.com"', { encoding: 'utf-8' });
		execSync('git config user.name "Test"', { encoding: 'utf-8' });
		// Create initial commit
		fs.writeFileSync(path.join(tempDir, 'initial.txt'), 'initial');
		execSync('git add .', { encoding: 'utf-8' });
		execSync('git commit -m "initial"', { encoding: 'utf-8' });

		// Create .swarm directory and evidence directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		// Create .opencode directory with config file
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'warn',
				},
			}),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		// Reset state after each test
		resetSwarmState();
	});

	// Helper function to write a valid retro bundle
	function writeRetroBundle(
		phaseNumber: number,
		verdict: 'pass' | 'fail' = 'pass',
	): void {
		const retroDir = path.join(
			tempDir,
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
					verdict: verdict,
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: phaseNumber,
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
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify(retroBundle, null, 2),
			'utf-8',
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

	describe('auto-checkpoint creation', () => {
		// NOTE: The phase_complete implementation does not write checkpoints.json.
		// Auto-checkpoint creation was removed or never implemented in the source.
		// These tests verify that phase_complete still succeeds without checkpoint logic.

		test('Phase completes successfully without checkpoint file being created', async () => {
			const sessionId = 'test-session-1';
			ensureAgentSession(sessionId);
			writeRetroBundle(1, 'pass');
			writeGateEvidence(1);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: sessionId,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);

			// No checkpoint log is created (feature not implemented in phase_complete)
			const checkpointLogPath = path.join(
				tempDir,
				'.swarm',
				'checkpoints.json',
			);
			expect(fs.existsSync(checkpointLogPath)).toBe(false);
		});

		test('Phase completes and event is written without checkpoint', async () => {
			const sessionId = 'test-session-2';
			ensureAgentSession(sessionId);
			writeRetroBundle(2, 'pass');
			writeGateEvidence(2);

			const result = await phase_complete.execute({
				phase: 2,
				sessionID: sessionId,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(2);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			expect(fs.existsSync(eventsPath)).toBe(true);

			const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
			const lastEvent = JSON.parse(events[events.length - 1]);
			expect(lastEvent.event).toBe('phase_complete');
			expect(lastEvent.phase).toBe(2);
		});

		test('Phase completes successfully on repeated calls', async () => {
			const sessionId = 'test-session-3';
			ensureAgentSession(sessionId);
			writeRetroBundle(1, 'pass');
			writeGateEvidence(1);

			const result1 = await phase_complete.execute({
				phase: 1,
				sessionID: sessionId,
			});
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(true);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: sessionId,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);
			expect(parsed.status).toBe('success');
		});

		test('Phase completes for different phase numbers', async () => {
			const phases = [1, 2, 5, 10, 99];

			for (const phaseNum of phases) {
				resetSwarmState();
				const sessionId = `test-session-${phaseNum}`;
				ensureAgentSession(sessionId);

				writeRetroBundle(phaseNum, 'pass');
				writeGateEvidence(phaseNum);

				const result = await phase_complete.execute({
					phase: phaseNum,
					sessionID: sessionId,
				});
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(true);
				expect(parsed.phase).toBe(phaseNum);
			}
		});

		test('Non-git directory - checkpoint failure is non-fatal', async () => {
			// Arrange: Create a non-git directory
			const nonGitDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-test-')),
			);
			try {
				// Create .swarm directory structure
				fs.mkdirSync(path.join(nonGitDir, '.swarm'), { recursive: true });
				fs.mkdirSync(path.join(nonGitDir, '.swarm', 'evidence'), {
					recursive: true,
				});

				// Create .opencode directory with config file
				fs.mkdirSync(path.join(nonGitDir, '.opencode'), { recursive: true });
				fs.writeFileSync(
					path.join(nonGitDir, '.opencode', 'opencode-swarm.json'),
					JSON.stringify({
						phase_complete: {
							enabled: true,
							required_agents: [],
							require_docs: false,
							policy: 'warn',
						},
					}),
				);

				// Create session and retro bundle
				const sessionId = 'test-session-non-git';
				ensureAgentSession(sessionId);

				// Write retro bundle to nonGitDir
				const retroDir = path.join(nonGitDir, '.swarm', 'evidence', 'retro-1');
				fs.mkdirSync(retroDir, { recursive: true });
				const retroBundle = {
					schema_version: '1.0.0',
					task_id: 'retro-1',
					entries: [
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
					],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				};
				fs.writeFileSync(
					path.join(retroDir, 'evidence.json'),
					JSON.stringify(retroBundle, null, 2),
					'utf-8',
				);

				// Write gate evidence for Phase 4 mandatory gates
				const evidenceDir = path.join(nonGitDir, '.swarm', 'evidence', '1');
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

				// Change to non-git directory
				process.chdir(nonGitDir);

				// Act: Call phase_complete in non-git directory
				const result = await phase_complete.execute({
					phase: 1,
					sessionID: sessionId,
				});
				const parsed = JSON.parse(result);

				// Assert: Phase should complete successfully despite checkpoint failure
				expect(parsed.success).toBe(true);
				expect(parsed.phase).toBe(1);
				expect(parsed.status).toBe('success');
			} finally {
				// Cleanup - change back to original dir first
				process.chdir(originalCwd);
				fs.rmSync(nonGitDir, { recursive: true, force: true });
			}
		});
	});
});
