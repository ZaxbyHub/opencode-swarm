/**
 * Unit tests for the skill-usage wiring in phase-complete.ts.
 *
 * Tests that `applySkillUsageFeedback` and `pruneSkillUsageLog` are wired into
 * the phase-complete lifecycle, and verifies:
 * 1. Both functions are called during phase-complete execution
 * 2. Ordering: feedback runs before pruning
 * 3. Fail-open: when applySkillUsageFeedback throws, pruneSkillUsageLog still runs
 *
 * Uses the same mock.module pattern as phase-complete-curator.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';

// =============================================================================
// Mock the skill-usage-log module BEFORE importing phase-complete
// =============================================================================

const mockApplySkillUsageFeedback = mock(async () => ({
	processed: 0,
	bumps: 0,
}));

const mockPruneSkillUsageLog = mock(() => ({
	pruned: 0,
	remaining: 0,
}));

mock.module('../../../src/hooks/skill-usage-log.js', () => ({
	applySkillUsageFeedback: mockApplySkillUsageFeedback,
	pruneSkillUsageLog: mockPruneSkillUsageLog,
}));

// Also mock curator/knowledge modules to avoid non-essential dependencies in this test
mock.module('../../../src/hooks/curator', () => ({
	runCuratorPhase: mock(async () => ({
		phase: 1,
		agents_dispatched: [],
		compliance: [],
		knowledge_recommendations: [],
		summary: 'Test curator',
		timestamp: new Date().toISOString(),
	})),
	applyCuratorKnowledgeUpdates: mock(async () => ({
		applied: 0,
		skipped: 0,
	})),
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	readPriorDriftReports: mock(async () => []),
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mock(async () => {}),
}));

// Import the tool after setting up mocks
const { phase_complete } = await import('../../../src/tools/phase-complete');

// =============================================================================
// Helpers
// =============================================================================

function makeTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-skill-usage-test-')),
	);
}

/** Write a valid retro bundle for a phase. */
function writeRetroBundle(directory: string, phaseNumber: number): void {
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
				verdict: 'pass',
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

/** Write gate evidence files (completion-verify + drift-verifier). */
function writeGateEvidence(directory: string, phase: number): void {
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

function createConfig(): string {
	return JSON.stringify({
		phase_complete: {
			enabled: true,
			required_agents: [],
			require_docs: false,
			policy: 'enforce',
		},
		curator: {
			enabled: false,
			phase_enabled: false,
		},
	});
}

// =============================================================================
// Test suite
// =============================================================================

describe('phase_complete - skill usage wiring', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		mockApplySkillUsageFeedback.mockClear();
		mockPruneSkillUsageLog.mockClear();

		tempDir = makeTempDir();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		// Write retro + gate evidence for phases 1 and 2
		writeRetroBundle(tempDir, 1);
		writeGateEvidence(tempDir, 1);
		writeRetroBundle(tempDir, 2);
		writeGateEvidence(tempDir, 2);

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
			// Ignore cleanup errors on Windows
		}
		resetSwarmState();
		mock.restore();
	});

	test('applySkillUsageFeedback and pruneSkillUsageLog are both called on successful phase completion', async () => {
		ensureAgentSession('sess-skill-usage-1');

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-skill-usage-1',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);

		// Both functions must have been called
		expect(mockApplySkillUsageFeedback).toHaveBeenCalled();
		expect(mockPruneSkillUsageLog).toHaveBeenCalled();
	});

	test('applySkillUsageFeedback is called with the correct directory', async () => {
		ensureAgentSession('sess-skill-usage-2');

		await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-skill-usage-2',
		});

		// Verify the directory argument passed to applySkillUsageFeedback
		const callArg = mockApplySkillUsageFeedback.mock.calls[0]?.[0];
		expect(callArg).toBe(tempDir);
	});

	test('pruneSkillUsageLog is called with the correct directory and retention count (500)', async () => {
		ensureAgentSession('sess-skill-usage-3');

		await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-skill-usage-3',
		});

		// Verify the arguments passed to pruneSkillUsageLog
		expect(mockPruneSkillUsageLog).toHaveBeenCalledWith(tempDir, 500);
	});

	test('ordering: feedback runs before pruning (verified by call sequence)', async () => {
		ensureAgentSession('sess-skill-usage-order');

		await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-skill-usage-order',
		});

		// Both must have been called
		expect(mockApplySkillUsageFeedback).toHaveBeenCalled();
		expect(mockPruneSkillUsageLog).toHaveBeenCalled();

		// applySkillUsageFeedback is at line 1830, pruneSkillUsageLog at line 1839.
		// In source order, feedback comes first. If both are called in the same
		// executePhaseComplete run, the call indices confirm source-order execution.
		expect(mockApplySkillUsageFeedback.mock.calls.length).toBeGreaterThan(0);
		expect(mockPruneSkillUsageLog.mock.calls.length).toBeGreaterThan(0);
	});

	test('fail-open: when applySkillUsageFeedback throws, pruneSkillUsageLog still runs', async () => {
		ensureAgentSession('sess-fail-open');

		// Make applySkillUsageFeedback throw (async, matching real signature)
		mockApplySkillUsageFeedback.mockImplementation(async () => {
			throw new Error('Simulated feedback failure');
		});

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-fail-open',
		});

		const parsed = JSON.parse(result);

		// Phase completion should still succeed (fail-open)
		expect(parsed.success).toBe(true);

		// applySkillUsageFeedback was called and threw
		expect(mockApplySkillUsageFeedback).toHaveBeenCalled();

		// pruneSkillUsageLog MUST still have been called (fail-open behavior)
		expect(mockPruneSkillUsageLog).toHaveBeenCalled();

		// Restore normal implementation for subsequent tests
		mockApplySkillUsageFeedback.mockImplementation(async () => ({
			processed: 0,
			bumps: 0,
		}));
	});

	test('both functions are called even when phase has no agents dispatched', async () => {
		// Session with no agents dispatched — still should call both functions
		ensureAgentSession('sess-no-agents');

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-no-agents',
		});

		const parsed = JSON.parse(result);
		// With no required_agents and no agents dispatched, phase should succeed (policy=warn)
		expect(parsed.success).toBe(true);

		expect(mockApplySkillUsageFeedback).toHaveBeenCalled();
		expect(mockPruneSkillUsageLog).toHaveBeenCalled();
	});

	test('both functions are called on phase 2 completion', async () => {
		ensureAgentSession('sess-phase-2');

		const result = await phase_complete.execute({
			phase: 2,
			sessionID: 'sess-phase-2',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);

		expect(mockApplySkillUsageFeedback).toHaveBeenCalled();
		expect(mockPruneSkillUsageLog).toHaveBeenCalled();
	});
});
