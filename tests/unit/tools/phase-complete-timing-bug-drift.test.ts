import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realCurator from '../../../src/hooks/curator';
import * as realCuratorDrift from '../../../src/hooks/curator-drift';
import type { DriftReport } from '../../../src/hooks/curator-types';
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

describe('Task 2.3: drift gate — verdicts and prior reports', () => {
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
		resetSwarmState();
		mock.restore();
	});

	describe('3. drift-verifier.json with verdict=approved passes gate', () => {
		test('phase_complete succeeds when drift-verifier.json has verdict approved', async () => {
			writeDriftVerifier(tempDir, 1, 'approved');

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('phase_complete succeeds with custom approved summary', async () => {
			writeDriftVerifier(tempDir, 1, 'approved', 'All requirements verified');

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});

	describe('4. drift-verifier.json with verdict=rejected blocks gate', () => {
		test('phase_complete blocks when drift-verifier.json has verdict rejected', async () => {
			writeDriftVerifier(
				tempDir,
				1,
				'rejected',
				'NEEDS_REVISION: Spec drift detected',
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_REJECTED');
			expect(parsed.message).toContain(
				"drift verifier returned verdict 'rejected'",
			);
		});

		test('phase_complete blocks when summary contains NEEDS_REVISION', async () => {
			// verdict is 'approved' but summary indicates needs revision
			writeDriftVerifier(
				tempDir,
				1,
				'approved',
				'NEEDS_REVISION: Some drift detected',
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_REJECTED');
		});
	});

	describe('5. readPriorDriftReports is called for advisory injection', () => {
		test('readPriorDriftReports is called when curator pipeline runs with session state', async () => {
			// Enable curator pipeline
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			writeDriftVerifier(tempDir, 1, 'approved');
			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// readPriorDriftReports should have been called (for advisory injection)
			expect(mockReadPriorDriftReports).toHaveBeenCalled();
			expect(mockReadPriorDriftReports).toHaveBeenCalledWith(tempDir);
		});

		test('readPriorDriftReports returns drift reports that trigger advisory messages', async () => {
			// Enable curator pipeline
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			writeDriftVerifier(tempDir, 1, 'approved');

			// Mock readPriorDriftReports to return a report with drift_score > 0
			mockReadPriorDriftReports.mockResolvedValueOnce([
				{
					schema_version: 1,
					phase: 1,
					timestamp: new Date().toISOString(),
					alignment: 'MINOR_DRIFT' as const,
					drift_score: 0.35,
					first_deviation: {
						phase: 1,
						task: '1.1',
						description: 'Implementation deviates from spec',
					},
					compounding_effects: [],
					corrections: ['Update spec to match implementation'],
					requirements_checked: 10,
					requirements_satisfied: 8,
					scope_additions: [],
					injection_summary: 'Phase 1: MINOR_DRIFT (0.35)',
				},
			]);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});
});
