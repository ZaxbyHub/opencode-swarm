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

// This mock tracks advisory drift calls. It must never write drift-verifier.json.
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

/**
 * Task 2.3: Core timing bug fix in phase-complete.ts
 *
 * The bug: runDeterministicDriftCheck wrote drift-verifier.json INSIDE phase_complete
 * AFTER the drift gate had already checked for it. This created a race condition
 * where the evidence didn't exist when checked.
 *
 * The fix:
 * 1. curator-drift.ts: Removed drift-verifier.json writing — only writes advisory drift reports
 * 2. phase-complete.ts: runDeterministicDriftCheck may run only as an advisory
 *    drift-report writer; it must not create critic_drift_verifier evidence.
 * 3. phase_complete remains a pure enforcement gate for drift-verifier.json.
 */
describe('Task 2.3: phase_complete timing bug fix — drift gate architecture', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		runDeterministicDriftCheckCalled = false;

		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockRunDeterministicDriftCheck.mockClear();
		mockReadPriorDriftReports.mockClear();

		// Use realpathSync to resolve macOS /var→/private/var symlink so that
		// process.cwd() (which resolves symlinks after chdir) matches tempDir.
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
		// Restore cross-module mocks per two-tier DI convention
		mock.restore();
	});

	describe('1. advisory drift writer does not recreate drift-verifier evidence', () => {
		test('runDeterministicDriftCheck may run but does not rewrite approved verifier evidence', async () => {
			ensureAgentSession('sess1');
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			// Write approved drift-verifier.json so drift gate passes
			writeDriftVerifier(tempDir, 1, 'approved');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			expect(mockRunDeterministicDriftCheck).toHaveBeenCalled();
			expect(runDeterministicDriftCheckCalled).toBe(true);
			expect(
				fs.existsSync(
					path.join(tempDir, '.swarm', 'evidence', '1', 'drift-verifier.json'),
				),
			).toBe(true);
			expect(
				fs.existsSync(path.join(tempDir, '.swarm', 'drift-verifier.json')),
			).toBe(false);
		});

		test('runDeterministicDriftCheck is advisory when curator pipeline runs', async () => {
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

			// runCuratorPhase WAS called (curator pipeline runs)
			expect(mockRunCuratorPhase).toHaveBeenCalled();

			expect(mockRunDeterministicDriftCheck).toHaveBeenCalled();
			expect(
				fs.existsSync(
					path.join(tempDir, '.swarm', 'evidence', '1', 'drift-verifier.json'),
				),
			).toBe(true);
			expect(
				fs.existsSync(path.join(tempDir, '.swarm', 'drift-verifier.json')),
			).toBe(false);
		});

		test('advisory drift does not create drift-verifier.json when it is missing', async () => {
			// NO drift-verifier.json written — should trigger advisory-only warning
			// but still succeed because spec.md doesn't exist
			ensureAgentSession('sess1');
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should succeed with advisory warning about missing drift evidence
			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toContainEqual(
				expect.stringContaining('No effective spec'),
			);

			expect(mockRunDeterministicDriftCheck).toHaveBeenCalled();
			expect(
				fs.existsSync(path.join(tempDir, '.swarm', 'drift-verifier.json')),
			).toBe(false);
			expect(
				fs.existsSync(
					path.join(tempDir, '.swarm', 'evidence', '1', 'drift-verifier.json'),
				),
			).toBe(false);
		});
	});

	describe('2. Advisory-only mode when no drift-verifier.json and no spec.md', () => {
		test('phase_complete succeeds with warning when drift-verifier.json missing and no spec.md', async () => {
			ensureAgentSession('sess1');

			// Ensure NO drift-verifier.json and NO spec.md
			// (setup already doesn't create these)

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should succeed (advisory-only mode)
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Should contain advisory warning about missing drift evidence
			expect(parsed.warnings).toContainEqual(
				expect.stringContaining('No effective spec'),
			);
		});

		test('phase_complete BLOCKS when drift-verifier.json missing but spec.md exists', async () => {
			// Create spec.md
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\nSome requirements.',
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should be blocked
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
		});
	});
});
