import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DriftReport } from '../../../src/hooks/curator-types';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';

// Track whether runDeterministicDriftCheck was called
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

// This mock tracks calls but is NOT actually invoked by phase_complete (per Task 2.3 fix)
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

const mockReadPriorDriftReports = mock(async (): Promise<DriftReport[]> => []);

mock.module('../../../src/hooks/curator', () => ({
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mockReadPriorDriftReports,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

/**
 * Helper: write retrospective evidence bundle
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
 * Helper: write completion-verify.json evidence
 */
function writeCompletionVerify(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
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
}

/**
 * Helper: write drift-verifier.json evidence (the enforcement gate file)
 */
function writeDriftVerifier(
	directory: string,
	phase: number,
	verdict: 'approved' | 'rejected',
	summary?: string,
): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });

	const driftVerifier = {
		schema_version: '1.0.0',
		task_id: 'drift-verifier',
		entries: [
			{
				task_id: 'drift-verifier',
				type: 'drift_verification',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: verdict,
				summary:
					summary ??
					(verdict === 'approved'
						? 'Drift check passed'
						: 'NEEDS_REVISION: Drift detected'),
			},
		],
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify(driftVerifier, null, 2),
	);
}

/**
 * Helper: create config with optional curator settings
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

/**
 * Task 2.3: Core timing bug fix in phase-complete.ts
 *
 * The bug: runDeterministicDriftCheck wrote drift-verifier.json INSIDE phase_complete
 * AFTER the drift gate had already checked for it. This created a race condition
 * where the evidence didn't exist when checked.
 *
 * The fix:
 * 1. curator-drift.ts: Removed drift-verifier.json writing — only writes advisory drift reports
 * 2. phase-complete.ts: Removed runDeterministicDriftCheck call, replaced with readPriorDriftReports for
 *    informational advisory messages
 * 3. phase_complete is now a pure enforcement gate that reads pre-written evidence
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

	describe('1. runDeterministicDriftCheck is NOT called by phase_complete (core fix)', () => {
		test('runDeterministicDriftCheck mock is never called during phase_complete execution', async () => {
			ensureAgentSession('sess1');

			// Write approved drift-verifier.json so drift gate passes
			writeDriftVerifier(tempDir, 1, 'approved');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// KEY ASSERTION: runDeterministicDriftCheck should NOT have been called
			// The fix removed this call from phase_complete
			expect(mockRunDeterministicDriftCheck).not.toHaveBeenCalled();
			expect(runDeterministicDriftCheckCalled).toBe(false);
		});

		test('runDeterministicDriftCheck is not called even when curator pipeline runs', async () => {
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

			// But runDeterministicDriftCheck was NOT called
			expect(mockRunDeterministicDriftCheck).not.toHaveBeenCalled();
		});

		test('runDeterministicDriftCheck is not called even when drift-verifier.json is missing', async () => {
			// NO drift-verifier.json written — should trigger advisory-only warning
			// but still succeed because spec.md doesn't exist
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should succeed with advisory warning about missing drift evidence
			expect(parsed.success).toBe(true);
			expect(parsed.warnings).toContainEqual(
				expect.stringContaining('No spec.md found'),
			);

			// runDeterministicDriftCheck should NOT have been called to "fix" the missing evidence
			expect(mockRunDeterministicDriftCheck).not.toHaveBeenCalled();
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
				expect.stringContaining('No spec.md found'),
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

	describe('6. Curator pipeline errors do not block phase_complete', () => {
		test('phase_complete succeeds even when runCuratorPhase throws', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

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
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

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
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				createConfig({ enabled: true, phase_enabled: true }),
			);

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
});
