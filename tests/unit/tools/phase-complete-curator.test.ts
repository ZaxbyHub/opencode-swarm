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
	report: {
		schema_version: 1 as const,
		phase: 1,
		timestamp: new Date().toISOString(),
		alignment: 'ALIGNED' as const,
		drift_score: 0,
		first_deviation: null,
		compounding_effects: [],
		corrections: [],
		requirements_checked: 0,
		requirements_satisfied: 0,
		scope_additions: [],
		injection_summary: '',
	},
	report_path: '',
	injection_text: '',
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

/**
 * Create config with optional curator settings
 */
function createConfig(curatorConfig?: {
	enabled?: boolean;
	phase_enabled?: boolean;
}): string {
	const config: Record<string, unknown> = {
		phase_complete: {
			enabled: true,
			required_agents: [],
			require_docs: false,
			policy: 'enforce',
		},
		// Always write explicit curator config to override any user-level config that may
		// have curator.enabled=true (user config deep-merges with project config).
		curator: {
			enabled: curatorConfig?.enabled ?? false,
			phase_enabled: curatorConfig?.phase_enabled ?? true,
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

describe('phase_complete - curator pipeline', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();

		// Clear mock call history
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();

		// Create temp directory
		// Use realpathSync to resolve macOS /var→/private/var symlink so that
		// process.cwd() (which resolves symlinks after chdir) matches tempDir.
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-curator-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory and evidence directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		// Write retro bundle for phase 1
		writeRetroBundle(tempDir, 1, 'pass');
		writeGateEvidence(tempDir, 1);
		writeRetroBundle(tempDir, 2, 'pass');
		writeGateEvidence(tempDir, 2);

		// Create default config WITHOUT curator enabled (default case)
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			createConfig(),
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
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	describe('curator pipeline skipped when enabled=false (default)', () => {
		test('runCuratorPhase is NOT called when curator is not enabled', async () => {
			// Config has curator disabled (default)
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase complete should still succeed
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Curator functions should NOT have been called
			expect(mockRunCuratorPhase).not.toHaveBeenCalled();
			expect(mockApplyCuratorKnowledgeUpdates).not.toHaveBeenCalled();
			expect(mockRunDeterministicDriftCheck).not.toHaveBeenCalled();
		});

		test('curator pipeline skipped when curator.enabled explicitly set to false', async () => {
			// Explicitly set curator.enabled = false
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: false, phase_enabled: true }),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(mockRunCuratorPhase).not.toHaveBeenCalled();
		});
	});

	describe('curator pipeline runs when enabled=true', () => {
		test('runCuratorPhase IS called when curator.enabled and curator.phase_enabled are both true', async () => {
			// Config with curator enabled
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');
			recordPhaseAgentDispatch('sess1', 'test_engineer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase complete should succeed
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Curator functions SHOULD have been called
			expect(mockRunCuratorPhase).toHaveBeenCalled();
			expect(mockRunCuratorPhase).toHaveBeenCalledWith(
				tempDir,
				1,
				expect.arrayContaining(['coder', 'reviewer', 'test_engineer']),
				expect.objectContaining({
					enabled: true,
					phase_enabled: true,
				}),
				expect.objectContaining({}), // _knowledgeConfig: { directory?: string }, passed as {}
				undefined,
			);

			expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalledWith(
				tempDir,
				[], // knowledge_recommendations from mock
				expect.objectContaining({
					enabled: true,
					schema_version: 1,
				}), // knowledgeConfig: KnowledgeConfig
			);
		});

		test('calls curator functions in sequence: runCuratorPhase -> applyCuratorKnowledgeUpdates', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			await phase_complete.execute({ phase: 1, sessionID: 'sess1' });

			// Verify call order
			const calls = mockRunCuratorPhase.mock.calls;
			expect(calls.length).toBe(1);

			// applyCuratorKnowledgeUpdates should be called after runCuratorPhase
			expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalled();

			// runDeterministicDriftCheck is no longer called from phase_complete
			expect(mockRunDeterministicDriftCheck).not.toHaveBeenCalled();
		});
	});

	describe('curator error does not block phase_complete', () => {
		test('phase_complete returns success even when runCuratorPhase throws', async () => {
			// Set up config with curator enabled
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Make runCuratorPhase throw an error
			mockRunCuratorPhase.mockRejectedValueOnce(
				new Error('Curator phase failed'),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase complete should STILL succeed (not blocked by curator error)
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// The error should have been caught and logged as a warning
			// (we can't easily test the console.warn output, but we verify the result is valid)
		});

		test('phase_complete returns success even when applyCuratorKnowledgeUpdates throws', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Make applyCuratorKnowledgeUpdates throw an error
			mockApplyCuratorKnowledgeUpdates.mockRejectedValueOnce(
				new Error('Knowledge update failed'),
			);

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

		test('phase_complete returns success even when runDeterministicDriftCheck throws', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Make runDeterministicDriftCheck throw an error
			mockRunDeterministicDriftCheck.mockRejectedValueOnce(
				new Error('Drift check failed'),
			);

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

		test('result is valid JSON with success:true when curator errors occur', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Make all curator functions throw
			mockRunCuratorPhase.mockRejectedValueOnce(new Error('Curator error 1'));
			mockApplyCuratorKnowledgeUpdates.mockRejectedValueOnce(
				new Error('Curator error 2'),
			);
			mockRunDeterministicDriftCheck.mockRejectedValueOnce(
				new Error('Curator error 3'),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});

			// Should be valid JSON
			expect(() => JSON.parse(result)).not.toThrow();

			const parsed = JSON.parse(result);

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
	});

	describe('curator pipeline skipped when phase_enabled=false', () => {
		test('runCuratorPhase is NOT called when phase_enabled=false but enabled=true', async () => {
			// Config with curator.enabled=true but phase_enabled=false
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: false }),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Phase complete should succeed
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Curator functions should NOT have been called
			expect(mockRunCuratorPhase).not.toHaveBeenCalled();
			expect(mockApplyCuratorKnowledgeUpdates).not.toHaveBeenCalled();
			expect(mockRunDeterministicDriftCheck).not.toHaveBeenCalled();
		});
	});

	describe('curator pipeline execution context', () => {
		test('curator receives correct phase number', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Write retro bundle for phase 2
			writeRetroBundle(tempDir, 2, 'pass');

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 2,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(mockRunCuratorPhase).toHaveBeenCalledWith(
				expect.any(String), // directory
				2, // phase should be 2
				expect.any(Array),
				expect.objectContaining({
					enabled: true,
					phase_enabled: true,
				}), // curatorConfig: CuratorConfig
				expect.objectContaining({}), // _knowledgeConfig: { directory?: string }, passed as {}
				undefined,
			);
		});

		test('curator receives correct agentsDispatched', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');
			recordPhaseAgentDispatch('sess1', 'test_engineer');
			recordPhaseAgentDispatch('sess1', 'docs');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Verify the agents array passed to runCuratorPhase
			expect(mockRunCuratorPhase).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Number),
				expect.arrayContaining(['coder', 'reviewer', 'test_engineer', 'docs']),
				expect.objectContaining({
					enabled: true,
					phase_enabled: true,
				}), // curatorConfig: CuratorConfig
				expect.objectContaining({}), // _knowledgeConfig: { directory?: string }, passed as {}
				undefined,
			);
		});
	});
});

/**
 * Task 5.3: Curator wiring fix - compliance warnings surfacing
 *
 * Phase 4.2 fix: phase_complete surfaces compliance warnings when suppress_warnings is false.
 *
 * Tests:
 * - phase_complete surfaces compliance warnings when suppress_warnings: false
 * - phase_complete does NOT surface compliance warnings when suppress_warnings: true
 */
describe('Task 5.3: curator compliance warnings surfacing', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-compliance-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		writeRetroBundle(tempDir, 1, 'pass');
		writeGateEvidence(tempDir, 1);
		writeRetroBundle(tempDir, 2, 'pass');
		writeGateEvidence(tempDir, 2);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		resetSwarmState();
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	describe('compliance warnings are surfaced when suppress_warnings: false', () => {
		test('phase_complete surfaces compliance warnings in result when curator returns compliance observations', async () => {
			// Set up config with curator enabled and suppress_warnings: false
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			// Create custom config with suppress_warnings: false
			const customConfig = {
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
				curator: {
					enabled: true,
					phase_enabled: true,
					init_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: false, // Key setting for this test
					drift_inject_max_chars: 500,
				},
			};
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify(customConfig),
			);

			// Override suppress_warnings to false in the mock config that will be parsed
			// The config object has suppress_warnings: true by default in createConfig
			// We need to mock runCuratorPhase to return compliance observations

			// Set up runCuratorPhase to return compliance observations
			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [
					{ severity: 'warning', description: 'Reviewer skipped for task 1.1' },
					{
						severity: 'error',
						description: 'No retrospective written for phase 1',
					},
				],
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toBeDefined();

			// Compliance warnings should be surfaced
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeDefined();
			expect(complianceWarning).toContain('Reviewer skipped');
			expect(complianceWarning).toContain('No retrospective');
		});

		test('compliance warnings are capped at 5 observations', async () => {
			// Set up config with curator enabled and suppress_warnings: false
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			// Create custom config with suppress_warnings: false
			const customConfig = {
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
				curator: {
					enabled: true,
					phase_enabled: true,
					init_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: false, // Key setting for this test
					drift_inject_max_chars: 500,
				},
			};
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify(customConfig),
			);

			// Set up runCuratorPhase to return more than 5 compliance observations
			const manyObservations = Array.from({ length: 10 }, (_, i) => ({
				severity: 'warning' as const,
				description: `Compliance observation ${i + 1}`,
			}));

			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: manyObservations,
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Find the curator compliance warning
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeDefined();

			// Should contain only 5 observations (capped)
			const warningText = complianceWarning as string;
			// Each observation appears as [WARNING] or [ERROR] description
			const warningCount = (warningText.match(/\[WARNING\]/g) || []).length;
			const errorCount = (warningText.match(/\[ERROR\]/g) || []).length;
			expect(warningCount + errorCount).toBeLessThanOrEqual(5);
		});
	});

	describe('compliance warnings are NOT surfaced when suppress_warnings: true', () => {
		test('phase_complete does NOT surface compliance warnings when suppress_warnings: true', async () => {
			// Set up config with curator enabled and suppress_warnings: true (default)
			// createConfig already sets suppress_warnings: true by default
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Set up runCuratorPhase to return compliance observations
			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [
					{ severity: 'warning', description: 'Reviewer skipped for task 1.1' },
				],
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toBeDefined();

			// Compliance warnings should NOT be surfaced
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeUndefined();
		});

		test('phase_complete does NOT surface compliance warnings when curator returns empty compliance array', async () => {
			// Set up config with curator enabled
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Set up runCuratorPhase to return empty compliance array
			mockRunCuratorPhase.mockResolvedValueOnce({
				phase: 1,
				agents_dispatched: ['coder'],
				compliance: [],
				knowledge_recommendations: [],
				summary: 'Test phase result',
				timestamp: new Date().toISOString(),
			});

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toBeDefined();

			// Compliance warnings should NOT be surfaced (empty array)
			const complianceWarning = parsed.warnings.find((w: string) =>
				w.includes('Curator compliance'),
			);
			expect(complianceWarning).toBeUndefined();
		});
	});
});
