import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';

// Mock curator functions BEFORE importing the module under test
const mockRunCuratorPhase = mock(async () => ({
	phase: 1,
	agents_dispatched: ['coder', 'reviewer', 'test_engineer'],
	compliance: [],
	knowledge_recommendations: [],
	summary: 'Test curator phase result',
	timestamp: new Date().toISOString(),
}));

const mockApplyCuratorKnowledgeUpdates = mock(async () => ({
	applied: 0,
	skipped: 0,
}));

const mockRunDeterministicDriftCheck = mock(async () => ({
	phase: 1,
	alignment: 'ALIGNED',
	drift_score: 0,
	recommendations: [],
	timestamp: new Date().toISOString(),
}));

// Mock the curator modules
mock.module('../../../src/hooks/curator', () => ({
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mock(async () => []),
}));

// Also mock the knowledge-curator module to avoid interference from curateAndStoreSwarm
mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

/**
 * Create valid config with curator enabled for testing curator pipeline errors
 */
function createValidConfigWithCurator(): string {
	const config = {
		phase_complete: {
			enabled: true,
			required_agents: [],
			require_docs: false,
			policy: 'warn',
		},
		curator: {
			enabled: true,
			phase_enabled: true,
			init_enabled: true,
			max_summary_tokens: 2000,
			min_knowledge_confidence: 0.7,
			compliance_report: true,
			suppress_warnings: true,
			drift_inject_max_chars: 500,
		},
	};
	return JSON.stringify(config);
}

/**
 * Helper function to write a valid retro bundle for a phase
 */
function writeRetroBundle(
	directory: string,
	phaseNumber: number,
	verdict: 'pass' | 'fail' = 'pass',
): void {
	const retroDir = path.join(
		directory,
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
	);
}

/**
 * Helper function to write gate evidence files for Phase 4 mandatory gates
 */
function writeGateEvidence(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
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

describe('phase_complete - curator pipeline adversarial tests', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();

		// Clear mock call history
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();

		// Reset mock implementations to default
		mockRunCuratorPhase.mockImplementation(async () => ({
			phase: 1,
			agents_dispatched: ['coder', 'reviewer', 'test_engineer'],
			compliance: [],
			knowledge_recommendations: [],
			summary: 'Test curator phase result',
			timestamp: new Date().toISOString(),
		}));

		// Create temp directory
		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'phase-complete-curator-adversarial-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory and evidence directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		// Write retro bundle for phase 1
		writeRetroBundle(tempDir, 1, 'pass');
		writeGateEvidence(tempDir, 1);

		// Create .opencode directory
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
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
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	// ============================================================
	// NOTE: Vectors 1 & 2 (malformed/extreme config values) cannot be tested
	// as intended because invalid curator config causes the entire PluginConfig
	// to fail Zod validation at parse time (before curator pipeline runs).
	// This is a security finding - invalid config causes DoS.
	// ============================================================

	// ============================================================
	// Attack Vector 3: runCuratorPhase returns null/undefined result
	// ============================================================
	describe('3. runCuratorPhase returns null/undefined result', () => {
		test('runCuratorPhase returns null - accessing property on null throws, caught by try/catch', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase return null
			mockRunCuratorPhase.mockImplementation(async () => null as never);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should still succeed - null access error caught by outer try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('runCuratorPhase returns undefined - accessing property throws, caught by try/catch', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase return undefined
			mockRunCuratorPhase.mockImplementation(async () => undefined as never);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('runCuratorPhase returns empty object - partial result handled gracefully', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase return empty object (missing required properties)
			mockRunCuratorPhase.mockImplementation(async () => ({}) as never);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - accessing null property throws, caught by try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	// ============================================================
	// Attack Vector 4: runCuratorPhase returns result with null/undefined recommendations
	// ============================================================
	describe('4. runCuratorPhase returns result with null/undefined recommendations', () => {
		test('knowledge_recommendations is null - applyCuratorKnowledgeUpdates called with null', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase return null knowledge_recommendations
			mockRunCuratorPhase.mockImplementation(async () => ({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [],
				knowledge_recommendations: null, // Null recommendations
				summary: 'Test',
				timestamp: new Date().toISOString(),
			}));

			// Make applyCuratorKnowledgeUpdates throw when given null
			mockApplyCuratorKnowledgeUpdates.mockImplementation(async () => {
				throw new Error('Cannot apply null recommendations');
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - error caught by outer try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('knowledge_recommendations is undefined - applyCuratorKnowledgeUpdates called with undefined', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase return undefined knowledge_recommendations
			mockRunCuratorPhase.mockImplementation(async () => ({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [],
				// knowledge_recommendations not provided (undefined)
				summary: 'Test',
				timestamp: new Date().toISOString(),
			}));

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - accessing undefined property throws, caught by try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	// ============================================================
	// Attack Vector 5: Async poison pill — runCuratorPhase returns rejected promise
	// ============================================================
	describe('5. Async poison pill — runCuratorPhase returns rejected promise', () => {
		test('runCuratorPhase rejects with Error - caught by try/catch', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase reject
			mockRunCuratorPhase.mockRejectedValue(
				new Error('Curator phase catastrophic failure'),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - rejection caught by outer try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('runCuratorPhase rejects with non-Error value (string) - caught by try/catch', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase reject with non-Error value
			mockRunCuratorPhase.mockRejectedValue(
				'Curator phase failed catastrophically',
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - rejection caught by outer try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('runCuratorPhase rejects with object - caught by try/catch', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase reject with object
			mockRunCuratorPhase.mockRejectedValue({ error: 'CRITICAL', code: 500 });

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - rejection caught by outer try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('runCuratorPhase rejects with null - caught by try/catch', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make runCuratorPhase reject with null
			mockRunCuratorPhase.mockRejectedValue(null);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase should succeed - rejection caught by outer try/catch
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	// ============================================================
	// Additional edge cases
	// ============================================================
	describe('Additional edge cases', () => {
		test('Result JSON is always valid even when curator pipeline fails completely', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Make all curator functions fail
			mockRunCuratorPhase.mockRejectedValue(new Error('Total failure'));
			mockApplyCuratorKnowledgeUpdates.mockRejectedValue(
				new Error('Knowledge failure'),
			);
			mockRunDeterministicDriftCheck.mockRejectedValue(
				new Error('Drift failure'),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});

			// Should be valid JSON
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(result);
			} catch {
				throw new Error('Result is not valid JSON');
			}

			// Should have expected structure
			expect(parsed).toHaveProperty('success');
			expect(parsed).toHaveProperty('phase');
			expect(parsed).toHaveProperty('message');
			expect(parsed).toHaveProperty('agentsDispatched');
			expect(parsed).toHaveProperty('agentsMissing');
			expect(parsed).toHaveProperty('status');
			expect(parsed).toHaveProperty('warnings');

			// Should indicate success
			expect(parsed.success).toBe(true);
		});

		test('Multiple sequential curator errors are all caught and logged', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createValidConfigWithCurator(),
			);

			// Run multiple times to test cumulative error handling
			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			// First call - curator fails
			mockRunCuratorPhase.mockRejectedValueOnce(new Error('First failure'));
			let result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			let parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// Second call - applyCuratorKnowledgeUpdates fails
			mockRunCuratorPhase.mockImplementation(async () => ({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [],
				knowledge_recommendations: [],
				summary: 'Test',
				timestamp: new Date().toISOString(),
			}));
			mockApplyCuratorKnowledgeUpdates.mockRejectedValueOnce(
				new Error('Second failure'),
			);
			result = await phase_complete.execute({ phase: 1, sessionID: 'sess1' });
			parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});
	});
});
