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

describe('curator error does not block phase_complete', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-curator-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		writeRetroBundle(tempDir, 1, 'pass');
		writeGateEvidence(tempDir, 1);
		writeRetroBundle(tempDir, 2, 'pass');
		writeGateEvidence(tempDir, 2);

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			createConfig({ enabled: true, phase_enabled: true }),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
		mock.restore();
	});

	test('phase_complete returns success even when runCuratorPhase throws', async () => {
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
	});

	test('phase_complete returns success even when applyCuratorKnowledgeUpdates throws', async () => {
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
