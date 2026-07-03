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
	writeCompletionVerify,
	writeDriftVerifier,
	writeRetroBundle,
} from './_phase-complete-test-helpers';

// Track whether runDeterministicDriftCheck was called as the advisory report writer.
let runDeterministicDriftCheckCalled = false;

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

const mockRunDeterministicDriftCheck = mock(async () => {
	runDeterministicDriftCheckCalled = true;
	return {
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
	};
});

const mockReadPriorDriftReports = mock(async () => []);

mock.module('../../../src/hooks/curator', () => ({
	...realCurator,
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	...realCuratorDrift,
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mockReadPriorDriftReports,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...realKnowledgeCurator,
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

describe('Task 2.3: curator pipeline errors do not block phase_complete', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		runDeterministicDriftCheckCalled = false;

		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();
		mockReadPriorDriftReports.mockClear();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-timing-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		writeRetroBundle(tempDir, 1, 'pass');
		writeCompletionVerify(tempDir, 1);

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

	test('phase_complete succeeds even when runCuratorPhase throws', async () => {
		writeDriftVerifier(tempDir, 1, 'approved');
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

		// Should still succeed (curator errors are non-blocking)
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('phase_complete succeeds even when applyCuratorKnowledgeUpdates throws', async () => {
		writeDriftVerifier(tempDir, 1, 'approved');
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
	});

	test('phase_complete succeeds even when readPriorDriftReports throws', async () => {
		writeDriftVerifier(tempDir, 1, 'approved');
		mockReadPriorDriftReports.mockRejectedValueOnce(
			new Error('Read drift reports failed'),
		);

		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess1',
		});
		const parsed = JSON.parse(result);

		// Should still succeed (drift advisory injection is non-blocking)
		expect(parsed.success).toBe(true);
	});
});
