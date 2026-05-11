import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import { swarmState } from '../../../../src/state';
import type {
	LaneEvidence,
	PhaseEvidence,
} from '../../../../src/turbo/lean/evidence';
import {
	_internals,
	dispatchPhaseCritic,
	type PhaseCriticResult,
} from '../../../../src/turbo/lean/integration';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-critic-test-'));
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
	return dir;
}

function writeLaneEvidence(
	dir: string,
	phase: number,
	lane: LaneEvidence,
): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${lane.laneId}.json`),
		JSON.stringify(lane),
		'utf-8',
	);
}

function writePhaseEvidence(
	dir: string,
	phase: number,
	evidence: PhaseEvidence,
): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'lean-turbo-phase.json'),
		JSON.stringify(evidence),
		'utf-8',
	);
}

function writeReviewerEvidence(
	dir: string,
	phase: number,
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
	reason?: string,
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'lean-turbo-reviewer.json'),
		JSON.stringify({
			phase,
			verdict,
			reason: reason ?? null,
			timestamp: new Date().toISOString(),
		}),
		'utf-8',
	);
}

// ─── Original _internals references (for restoration) ─────────────────────────

const _originalListLaneEvidence = _internals.listLaneEvidence;
const _originalReadPhaseEvidence = _internals.readPhaseEvidence;
const _originalReadReviewerEvidence = _internals.readReviewerEvidence;
const _originalDispatchCriticAgent = _internals.dispatchCriticAgent;

// ─── Mock CriticPackage for testing ───────────────────────────────────────────

function makeCriticPackage(
	overrides: Partial<{
		phase: number;
		sessionID: string;
		reviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
		reviewerMissing: boolean;
		safetyConcerns: string[];
		laneSummaries: Array<{
			laneId: string;
			taskIds: string[];
			files: string[];
			status: LaneEvidence['status'];
		}>;
		filesChanged: string[];
		testResults: {
			totalLanes: number;
			completedLanes: number;
			failedLanes: number;
		};
		degradationSummary: {
			totalDegraded: number;
			resolvedDegraded: number;
			pendingDegraded: number;
		};
	}> = {},
) {
	return {
		phase: 1,
		sessionID: 'test-session',
		reviewerVerdict: 'APPROVED',
		reviewerMissing: false,
		safetyConcerns: [],
		laneSummaries: [],
		filesChanged: [],
		testResults: { totalLanes: 0, completedLanes: 0, failedLanes: 0 },
		degradationSummary: {
			totalDegraded: 0,
			resolvedDegraded: 0,
			pendingDegraded: 0,
		},
		...overrides,
	};
}

describe('dispatchPhaseCritic', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtemp();
	});

	afterEach(() => {
		// Restore original _internals
		_internals.listLaneEvidence = _originalListLaneEvidence;
		_internals.readPhaseEvidence = _originalReadPhaseEvidence;
		_internals.readReviewerEvidence = _originalReadReviewerEvidence;
		_internals.dispatchCriticAgent = _originalDispatchCriticAgent;

		// Clean up temp dir
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// ─── Test 1: Critic evidence compiled correctly from evidence files ─────────────
	test('compileCriticPackage gathers evidence correctly with reviewer APPROVED', async () => {
		// Set up lane evidence files
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1', '1.2'],
			files: ['src/a.ts', 'src/b.ts'],
			status: 'completed',
			agent: 'mega_coder',
			sessionId: 'test-session',
		});
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-2',
			taskIds: ['1.3'],
			files: ['src/c.ts'],
			status: 'completed',
			agent: 'local_coder',
			sessionId: 'test-session',
		});

		// Set up phase evidence
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
		});

		// Set up reviewer evidence
		writeReviewerEvidence(
			dir,
			1,
			'APPROVED',
			'all lanes completed successfully',
		);

		// Compile critic package using real functions
		const pkg = await _internals.compileCriticPackage(dir, 1, 'test-session');

		expect(pkg.phase).toBe(1);
		expect(pkg.sessionID).toBe('test-session');
		expect(pkg.reviewerVerdict).toBe('APPROVED');
		expect(pkg.reviewerMissing).toBe(false);
		expect(pkg.safetyConcerns).toHaveLength(0);
		expect(pkg.laneSummaries).toHaveLength(2);
		expect(pkg.laneSummaries[0].laneId).toBe('lane-1');
		expect(pkg.filesChanged).toContain('src/a.ts');
		expect(pkg.filesChanged).toContain('src/b.ts');
		expect(pkg.filesChanged).toContain('src/c.ts');
		expect(pkg.testResults.totalLanes).toBe(2);
		expect(pkg.testResults.completedLanes).toBe(2);
		expect(pkg.testResults.failedLanes).toBe(0);
	});

	test('compileCriticPackage notes missing reviewer evidence as safety concern', async () => {
		// Set up lane evidence files
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'completed',
			sessionId: 'test-session',
		});

		// Set up phase evidence
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
		});

		// Intentionally do NOT write reviewer evidence

		// Compile critic package
		const pkg = await _internals.compileCriticPackage(dir, 1, 'test-session');

		expect(pkg.reviewerMissing).toBe(true);
		expect(pkg.reviewerVerdict).toBeUndefined();
		expect(pkg.safetyConcerns).toContain(
			'Reviewer evidence is missing — critic cannot verify reviewer assessment',
		);
	});

	test('compileCriticPackage notes reviewer REJECTED as safety concern', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'completed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
		});
		writeReviewerEvidence(dir, 1, 'REJECTED', 'unresolved issues found');

		const pkg = await _internals.compileCriticPackage(dir, 1, 'test-session');

		expect(pkg.reviewerVerdict).toBe('REJECTED');
		expect(pkg.safetyConcerns).toContain(
			'Reviewer verdict is REJECTED: unresolved issues found',
		);
	});

	test('compileCriticPackage notes reviewer NEEDS_REVISION as safety concern', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'completed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
		});
		writeReviewerEvidence(dir, 1, 'NEEDS_REVISION', 'needs more work');

		const pkg = await _internals.compileCriticPackage(dir, 1, 'test-session');

		expect(pkg.reviewerVerdict).toBe('NEEDS_REVISION');
		expect(pkg.safetyConcerns).toContain(
			'Reviewer verdict is NEEDS_REVISION: needs more work',
		);
	});

	// ─── Test 2: Critic dispatch uses correct agent name ────────────────────────
	test('dispatch uses configured criticAgent name', async () => {
		let capturedAgentName: string | undefined;

		_internals.dispatchCriticAgent = mock(
			async (
				directory: string,
				pkg: unknown,
				agentName: string,
				timeoutMs: number,
			) => {
				capturedAgentName = agentName;
				return 'VERDICT: APPROVED\nREASON: test passed';
			},
		);

		const result = await dispatchPhaseCritic(dir, 1, 'test-session', {
			criticAgent: 'mega_critic',
		});

		expect(result.verdict).toBe('APPROVED');
		expect(capturedAgentName).toBe('mega_critic');
	});

	test('dispatch uses default critic agent when not configured', async () => {
		let capturedAgentName: string | undefined;

		_internals.dispatchCriticAgent = mock(
			async (
				directory: string,
				pkg: unknown,
				agentName: string,
				timeoutMs: number,
			) => {
				capturedAgentName = agentName;
				return 'VERDICT: APPROVED\nREASON: test passed';
			},
		);

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
		// Default should be 'critic' since no generatedAgentNames are mocked
		expect(capturedAgentName).toBe('critic');
	});

	test('dispatch passes directory parameter to critic agent for correct workspace scoping', async () => {
		let capturedDirectory: string | undefined;

		_internals.dispatchCriticAgent = mock(
			async (
				directory: string,
				pkg: unknown,
				agentName: string,
				timeoutMs: number,
			) => {
				capturedDirectory = directory;
				return 'VERDICT: APPROVED\nREASON: test passed';
			},
		);

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
		expect(capturedDirectory).toBe(dir);
	});

	// ─── Test 3: Critic verdict types are parsed and written ─────────────────────

	test('APPROVED verdict is parsed and written to evidence', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: APPROVED\nREASON: all boundary conditions met';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
		expect(result.reason).toBe('all boundary conditions met');
		expect(result.evidencePath).toMatch(/\.swarm/);
		expect(result.evidencePath).toMatch(/lean-turbo-critic\.json$/);

		// Verify the evidence file was actually written
		const evidenceContent = fs.readFileSync(result.evidencePath, 'utf-8');
		const parsed = JSON.parse(evidenceContent);
		expect(parsed.verdict).toBe('APPROVED');
		expect(parsed.reason).toBe('all boundary conditions met');
		expect(parsed.phase).toBe(1);
		expect(parsed.timestamp).toBeTruthy();
	});

	test('NEEDS_REVISION verdict is parsed and written', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: NEEDS_REVISION\nREASON: boundary integrity check failed';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('NEEDS_REVISION');
		expect(result.reason).toBe('boundary integrity check failed');
	});

	test('REJECTED verdict is parsed and written', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: REJECTED\nREASON: critical safety concerns unresolved';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('critical safety concerns unresolved');
	});

	test('ESCALATE_TO_HUMAN verdict is parsed and written', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: ESCALATE_TO_HUMAN\nREASON: decision requires human judgment';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('ESCALATE_TO_HUMAN');
		expect(result.reason).toBe('decision requires human judgment');
	});

	// ─── Test 4: Missing evidence handled gracefully ─────────────────────────────

	test('missing lane evidence files → empty laneSummaries, continues successfully', async () => {
		// Intentionally do NOT write any lane evidence files
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
		});
		writeReviewerEvidence(dir, 1, 'APPROVED', 'phase clean');

		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: APPROVED\nREASON: no lanes but phase boundary is acceptable';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
	});

	test('missing phase evidence → compilation still succeeds with defaults', async () => {
		// Intentionally do NOT write phase evidence
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'completed',
			sessionId: 'test-session',
		});
		writeReviewerEvidence(dir, 1, 'APPROVED', 'lanes complete');

		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: APPROVED\nREASON: phase evidence missing but lanes complete';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
	});

	// ─── Test 5: Malformed critic response → fail-closed ────────────────────────

	test('malformed response (no VERDICT marker) → REJECTED', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return 'The critic thought about it but gave no verdict.';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('Critic response could not be parsed');
	});

	test('empty response → REJECTED', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return '';
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('Critic response could not be parsed');
	});

	test('dispatch throws error → REJECTED with error reason', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			throw new Error('Session creation failed');
		});

		const result = await dispatchPhaseCritic(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe(
			'Critic dispatch failed: Session creation failed',
		);
	});

	// ─── Test 6: parseCriticVerdict edge cases ─────────────────────────────────

	test('parseCriticVerdict: case insensitive verdict matching', () => {
		const result1 = _internals.parseCriticVerdict('verdict: approved');
		expect(result1?.verdict).toBe('APPROVED');

		const result2 = _internals.parseCriticVerdict('Verdict: NEEDS_REVISION');
		expect(result2?.verdict).toBe('NEEDS_REVISION');

		const result3 = _internals.parseCriticVerdict('VERDICT: REJECTED');
		expect(result3?.verdict).toBe('REJECTED');

		const result4 = _internals.parseCriticVerdict('verdict: escalate_to_human');
		expect(result4?.verdict).toBe('ESCALATE_TO_HUMAN');
	});

	test('parseCriticVerdict: reason extracted from next line', () => {
		const result = _internals.parseCriticVerdict(
			'VERDICT: APPROVED\nREASON: all checks passed',
		);
		expect(result?.verdict).toBe('APPROVED');
		expect(result?.reason).toBe('all checks passed');
	});

	test('parseCriticVerdict: verdict without reason → reason undefined', () => {
		const result = _internals.parseCriticVerdict('VERDICT: APPROVED');
		expect(result?.verdict).toBe('APPROVED');
		expect(result?.reason).toBeUndefined();
	});

	test('parseCriticVerdict: returns null for unrecognized verdict', () => {
		const result = _internals.parseCriticVerdict('VERDICT: MAYBE');
		expect(result).toBeNull();
	});

	// ─── Test 7: writeCriticEvidence writes atomic JSON ────────────────────────

	test('writeCriticEvidence creates valid JSON with correct shape', async () => {
		const evidencePath = await _internals.writeCriticEvidence(
			dir,
			1,
			'APPROVED',
			'test reason',
		);

		const content = fs.readFileSync(evidencePath, 'utf-8');
		const parsed = JSON.parse(content);

		expect(parsed.phase).toBe(1);
		expect(parsed.verdict).toBe('APPROVED');
		expect(parsed.reason).toBe('test reason');
		expect(parsed.timestamp).toBeTruthy();
	});

	// ─── Test 8: resolveDefaultCriticAgent ─────────────────────────────────────

	test('resolveDefaultCriticAgent: returns critic when no generated names', () => {
		const result = _internals.resolveDefaultCriticAgent([]);
		expect(result).toBe('critic');
	});

	test('resolveDefaultCriticAgent: returns longest matching _critic suffix', () => {
		const result = _internals.resolveDefaultCriticAgent([
			'critic',
			'local_critic',
			'mega_critic',
		]);
		// 'local_critic' (12 chars) is longest
		expect(result).toBe('local_critic');
	});

	test('resolveDefaultCriticAgent: prefers -critic suffix over bare critic', () => {
		const result = _internals.resolveDefaultCriticAgent([
			'critic',
			'cloud-critic',
		]);
		expect(result).toBe('cloud-critic');
	});

	test('resolveDefaultCriticAgent: falls back to first generated name if no critic suffix', () => {
		const result = _internals.resolveDefaultCriticAgent([
			'mega_coder',
			'local_coder',
		]);
		expect(result).toBe('mega_coder');
	});

	// ─── Test 9: Evidence file path follows expected pattern ────────────────────

	test('evidence file path follows .swarm/evidence/{phase}/lean-turbo-critic.json', async () => {
		_internals.dispatchCriticAgent = mock(async () => {
			return 'VERDICT: APPROVED\nREASON: all good';
		});

		const result = await dispatchPhaseCritic(dir, 3, 'test-session');

		expect(result.evidencePath).toMatch(
			/\.swarm[/\\]evidence[/\\]3[/\\]lean-turbo-critic\.json$/,
		);
	});

	// ─── Test 11: Degradation summary in package ─────────────────────────────────

	test('compileCriticPackage: degradation summary computed correctly', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1', '1.2'], // 1.1 completed in lane, 1.2 is degraded
			files: [],
			status: 'completed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [
				{ taskId: '1.2', reason: 'global file conflict' },
				{ taskId: '1.3', reason: 'protected path' },
			],
			startedAt: new Date().toISOString(),
			status: 'completed',
		});
		writeReviewerEvidence(dir, 1, 'APPROVED');

		const pkg = await _internals.compileCriticPackage(dir, 1, 'test-session');

		// 1.2 is covered by lane and completed → resolved
		// 1.3 is NOT covered by any lane → pending
		expect(pkg.degradationSummary.totalDegraded).toBe(2);
		expect(pkg.degradationSummary.resolvedDegraded).toBe(1);
		expect(pkg.degradationSummary.pendingDegraded).toBe(1);
		expect(pkg.safetyConcerns).toContain(
			'1 degraded task(s) remain unresolved',
		);
	});

	// ─── Test 12: readReviewerEvidence handles missing/invalid files ─────────────

	test('readReviewerEvidence: returns null for missing file', async () => {
		// Intentionally do NOT write reviewer evidence
		const result = await _internals.readReviewerEvidence(dir, 1);
		expect(result).toBeNull();
	});

	test('readReviewerEvidence: returns null for invalid JSON', async () => {
		const evidenceDir = path.join(dir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'lean-turbo-reviewer.json'),
			'not valid json',
			'utf-8',
		);

		const result = await _internals.readReviewerEvidence(dir, 1);
		expect(result).toBeNull();
	});

	test('readReviewerEvidence: returns parsed evidence when valid', async () => {
		writeReviewerEvidence(dir, 1, 'REJECTED', 'critical issues');

		const result = await _internals.readReviewerEvidence(dir, 1);
		expect(result).not.toBeNull();
		expect(result!.verdict).toBe('REJECTED');
		expect(result!.reason).toBe('critical issues');
	});
});
