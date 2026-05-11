/**
 * Lean Turbo phase reviewer integration tests for phase boundary gate.
 *
 * Tests that verifyLeanTurboPhaseReady correctly parses reviewer evidence
 * from .swarm/evidence/{phase}/lean-turbo-reviewer.json as a fallback when
 * runState.lastReviewerVerdict is not set.
 *
 * Test scenarios:
 * 1. APPROVED verdict in evidence file → phase passes reviewer check
 * 2. REJECTED verdict in evidence file → phase blocked with rejection reason
 * 3. NEEDS_REVISION verdict in evidence file → phase blocked
 * 4. Missing evidence file → phase blocked (fail-closed)
 * 5. Invalid JSON in evidence file → phase blocked (fail-closed)
 * 6. Missing verdict field → phase blocked (fail-closed)
 * 7. runState verdict takes precedence over evidence file
 * 8. Arbitrary generated reviewer names supported (mega_reviewer, local_critic, etc.)
 *
 * Uses the _internals seam to inject mock results and write evidence files.
 * Follows the patterns from phase-complete-lean-turbo.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	_internals as phaseReadyInternals,
	verifyLeanTurboPhaseReady,
} from '../../../src/turbo/lean/phase-ready';
import { _internals as reviewerInternals } from '../../../src/turbo/lean/reviewer';

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'Reviewer Integration Test Plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

function setupSwarmDir(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });

	const planJson = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						description: 'Test task',
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson, null, 2),
	);

	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
		}),
	);
}

function writeEvidenceFile(
	dir: string,
	phase: number,
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
	reason?: string,
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	const evidencePath = path.join(evidenceDir, 'lean-turbo-reviewer.json');
	fs.writeFileSync(
		evidencePath,
		JSON.stringify(
			{
				phase,
				verdict,
				reason: reason ?? null,
				timestamp: new Date().toISOString(),
			},
			null,
			2,
		),
	);
}

function setupLeanTurboSession(
	dir: string,
	phase: number,
	sessionID = 'sess1',
	lastReviewerVerdict?: string,
	lastCriticVerdict?: string,
): void {
	// Create turbo-state.json with Lean Turbo session
	const turboState = {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			[sessionID]: {
				status: 'running',
				sessionID,
				strategy: 'lean',
				phase,
				maxParallelCoders: 4,
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['1.1'],
						files: [],
						status: 'completed',
					},
				],
				degradedTasks: [],
				lastReviewerVerdict: lastReviewerVerdict ?? undefined,
				lastCriticVerdict: lastCriticVerdict ?? undefined,
				counters: {
					lanesPlanned: 1,
					lanesStarted: 1,
					lanesCompleted: 1,
					lanesFailed: 0,
					tasksSerialized: 1,
					tasksDegraded: 0,
				},
			},
		},
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'turbo-state.json'),
		JSON.stringify(turboState, null, 2),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyLeanTurboPhaseReady — reviewer evidence integration', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-reviewer-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupSwarmDir(tempDir);

		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'lean';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = true;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	test('1. APPROVED verdict in evidence file → phase passes reviewer check', () => {
		setupLeanTurboSession(tempDir, 1);
		writeEvidenceFile(
			tempDir,
			1,
			'APPROVED',
			'All lanes completed successfully',
		);

		// Use phase_critic: false since we only have reviewer evidence
		const result = verifyLeanTurboPhaseReady(tempDir, 1, {
			phase_reviewer: true,
			phase_critic: false,
		});
		expect(result.ok).toBe(true);
		expect(result.evidence?.reviewerVerdict).toBe('APPROVED');
	});

	test('2. REJECTED verdict in evidence file → phase blocked with rejection reason', () => {
		setupLeanTurboSession(tempDir, 1);
		writeEvidenceFile(
			tempDir,
			1,
			'REJECTED',
			'Critical safety concerns detected',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	test('3. NEEDS_REVISION verdict in evidence file → phase blocked', () => {
		setupLeanTurboSession(tempDir, 1);
		writeEvidenceFile(
			tempDir,
			1,
			'NEEDS_REVISION',
			'Degraded tasks remain unresolved',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	test('4. Missing evidence file → phase blocked (fail-closed)', () => {
		setupLeanTurboSession(tempDir, 1);
		// No evidence file written

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	test('5. Invalid JSON in evidence file → phase blocked (fail-closed)', () => {
		setupLeanTurboSession(tempDir, 1);
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'lean-turbo-reviewer.json'),
			'not valid json {',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	test('6. Missing verdict field in evidence file → phase blocked (fail-closed)', () => {
		setupLeanTurboSession(tempDir, 1);
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'lean-turbo-reviewer.json'),
			JSON.stringify({
				phase: 1,
				// verdict field missing
				reason: 'test',
				timestamp: new Date().toISOString(),
			}),
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	test('7. runState verdict takes precedence over evidence file', () => {
		// Set both reviewer and critic verdicts in runState to APPROVED so both checks pass
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', 'APPROVED');

		// Evidence file has REJECTED — should be ignored because runState takes precedence
		writeEvidenceFile(tempDir, 1, 'REJECTED', 'Evidence file reason');

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(true);
		expect(result.evidence?.reviewerVerdict).toBe('APPROVED');
	});

	test('8. arbitrary generated reviewer names supported via resolveDefaultReviewerAgent', () => {
		// Test that resolveDefaultReviewerAgent correctly resolves arbitrary reviewer names
		const testCases = [
			{
				generatedAgentNames: ['mega_reviewer'],
				expected: 'mega_reviewer',
			},
			{
				generatedAgentNames: ['local_critic', 'local_reviewer'],
				expected: 'local_reviewer',
			},
			{
				generatedAgentNames: ['mega-reviewer', 'reviewer'],
				expected: 'mega-reviewer',
			},
			{
				generatedAgentNames: ['reviewer'],
				expected: 'reviewer',
			},
			{
				generatedAgentNames: [],
				expected: 'reviewer',
			},
		];

		for (const tc of testCases) {
			const resolved = reviewerInternals.resolveDefaultReviewerAgent(
				tc.generatedAgentNames,
			);
			expect(resolved).toBe(tc.expected);
		}
	});
});
