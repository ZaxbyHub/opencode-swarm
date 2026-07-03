import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realCurator from '../../../src/hooks/curator';
import * as realCuratorDrift from '../../../src/hooks/curator-drift';
import * as realKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import {
	createConfig,
	writeGateEvidence,
	writeRetroBundle,
} from './_phase-complete-test-helpers';

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

// Mock the curator modules — spread real exports, override only the mocked functions
mock.module('../../../src/hooks/curator', () => ({
	...realCurator,
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	...realCuratorDrift,
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mock(async () => []),
}));

// Also mock the knowledge-curator module to avoid interference from curateAndStoreSwarm
mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...realKnowledgeCurator,
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

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

			// Advisory drift runs after curator updates, but it must not recreate
			// the old critic_drift_verifier evidence gate.
			expect(mockRunDeterministicDriftCheck).toHaveBeenCalled();
			expect(
				fs.existsSync(path.join(tempDir, '.swarm', 'drift-verifier.json')),
			).toBe(false);
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
