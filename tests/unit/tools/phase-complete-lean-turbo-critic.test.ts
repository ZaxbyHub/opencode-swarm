/**
 * Lean Turbo phase critic integration tests for phase boundary gate.
 *
 * Tests that verifyLeanTurboPhaseReady correctly parses critic evidence
 * from .swarm/evidence/{phase}/lean-turbo-critic.json as a fallback when
 * runState.lastCriticVerdict is not set.
 *
 * Test scenarios:
 * 1. APPROVED verdict in evidence file → phase passes critic check
 * 2. REJECTED verdict in evidence file → phase blocked with rejection reason
 * 3. NEEDS_REVISION verdict in evidence file → phase blocked
 * 4. ESCALATE_TO_HUMAN verdict in evidence file → phase blocked
 * 5. Missing evidence file → phase blocked (fail-closed)
 * 6. Invalid JSON in evidence file → phase blocked (fail-closed)
 * 7. runState verdict takes precedence over evidence file
 * 8. Arbitrary generated critic names supported (mega_critic, local_critic, etc.)
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
import { _internals as criticInternals } from '../../../src/turbo/lean/integration';
import {
	_internals as phaseReadyInternals,
	verifyLeanTurboPhaseReady,
} from '../../../src/turbo/lean/phase-ready';

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'Critic Integration Test Plan';
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

function writeCriticEvidenceFile(
	dir: string,
	phase: number,
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN',
	reason?: string,
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	const evidencePath = path.join(evidenceDir, 'lean-turbo-critic.json');
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

function writeReviewerEvidenceFile(
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
	reviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
	criticVerdict?: string,
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
				lastReviewerVerdict: reviewerVerdict,
				lastCriticVerdict: criticVerdict,
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

describe('verifyLeanTurboPhaseReady — critic evidence integration', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-critic-test-')),
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

	test('1. APPROVED verdict in evidence file → phase passes critic check', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', undefined);
		writeCriticEvidenceFile(
			tempDir,
			1,
			'APPROVED',
			'Boundary conditions acceptable',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(true);
		expect(result.evidence?.criticVerdict).toBe('APPROVED');
	});

	test('2. REJECTED verdict in evidence file → phase blocked with rejection reason', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', undefined);
		writeCriticEvidenceFile(
			tempDir,
			1,
			'REJECTED',
			'Critical boundary integrity issue',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('3. NEEDS_REVISION verdict in evidence file → phase blocked', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', undefined);
		writeCriticEvidenceFile(
			tempDir,
			1,
			'NEEDS_REVISION',
			'Safety concerns must be addressed',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('4. ESCALATE_TO_HUMAN verdict in evidence file → phase blocked', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', undefined);
		writeCriticEvidenceFile(
			tempDir,
			1,
			'ESCALATE_TO_HUMAN',
			'Human judgment required',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('5. Missing evidence file → phase blocked (fail-closed)', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', undefined);
		// No critic evidence file written

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('6. Invalid JSON in evidence file → phase blocked (fail-closed)', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', undefined);
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'lean-turbo-critic.json'),
			'not valid json {',
		);

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('7. runState verdict takes precedence over evidence file', () => {
		// Set runState verdict to APPROVED (should take precedence)
		setupLeanTurboSession(tempDir, 1, 'sess1', 'APPROVED', 'APPROVED');

		// Evidence file has REJECTED — should be ignored because runState takes precedence
		writeCriticEvidenceFile(tempDir, 1, 'REJECTED', 'Evidence file reason');

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(true);
		expect(result.evidence?.criticVerdict).toBe('APPROVED');
	});

	test('8. arbitrary generated critic names supported via resolveDefaultCriticAgent', () => {
		// Test that resolveDefaultCriticAgent correctly resolves arbitrary critic names
		const testCases = [
			{
				generatedAgentNames: ['mega_critic'],
				expected: 'mega_critic',
			},
			{
				generatedAgentNames: ['local_reviewer', 'local_critic'],
				expected: 'local_critic',
			},
			{
				generatedAgentNames: ['mega-critic', 'critic'],
				expected: 'mega-critic',
			},
			{
				generatedAgentNames: ['critic'],
				expected: 'critic',
			},
			{
				generatedAgentNames: [],
				expected: 'critic',
			},
		];

		for (const tc of testCases) {
			const resolved = criticInternals.resolveDefaultCriticAgent(
				tc.generatedAgentNames,
			);
			expect(resolved).toBe(tc.expected);
		}
	});

	test('9. Both reviewer and critic evidence files used together', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', undefined, undefined);
		writeReviewerEvidenceFile(tempDir, 1, 'APPROVED', 'Reviewer approved');
		writeCriticEvidenceFile(tempDir, 1, 'APPROVED', 'Critic approved');

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(true);
		expect(result.evidence?.reviewerVerdict).toBe('APPROVED');
		expect(result.evidence?.criticVerdict).toBe('APPROVED');
	});

	test('10. Rejected reviewer blocks even if critic evidence is APPROVED', () => {
		setupLeanTurboSession(tempDir, 1, 'sess1', undefined, undefined);
		writeReviewerEvidenceFile(tempDir, 1, 'REJECTED', 'Reviewer rejected');
		writeCriticEvidenceFile(tempDir, 1, 'APPROVED', 'Critic approved');

		const result = verifyLeanTurboPhaseReady(tempDir, 1);
		expect(result.ok).toBe(false);
		// Reviewer check fails first
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});
});
