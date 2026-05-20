import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../../src/state';
import type {
	LaneEvidence,
	PhaseEvidence,
} from '../../../../src/turbo/lean/evidence';
import {
	_internals,
	dispatchPhaseReviewer,
	type PhaseReviewerResult,
} from '../../../../src/turbo/lean/reviewer';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-reviewer-test-'));
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

// ─── Original _internals references (for restoration) ─────────────────────────

const _originalListLaneEvidence = _internals.listLaneEvidence;
const _originalReadPhaseEvidence = _internals.readPhaseEvidence;
const _originalDispatchReviewerAgent = _internals.dispatchReviewerAgent;

// ─── Mock ReviewPackage for testing ───────────────────────────────────────────

function makeReviewPackage(
	overrides: Partial<{
		phase: number;
		sessionID: string;
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
		buildStatus: 'unknown' | 'passed' | 'failed';
		degradationSummary: {
			totalDegraded: number;
			resolvedDegraded: number;
			pendingDegraded: number;
		};
		integratedDiffSummary?: string;
	}> = {},
) {
	return {
		phase: 1,
		sessionID: 'test-session',
		laneSummaries: [],
		filesChanged: [],
		testResults: { totalLanes: 0, completedLanes: 0, failedLanes: 0 },
		buildStatus: 'unknown' as const,
		degradationSummary: {
			totalDegraded: 0,
			resolvedDegraded: 0,
			pendingDegraded: 0,
		},
		...overrides,
	};
}

describe('dispatchPhaseReviewer', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtemp();
	});

	afterEach(() => {
		// Restore original _internals
		_internals.listLaneEvidence = _originalListLaneEvidence;
		_internals.readPhaseEvidence = _originalReadPhaseEvidence;
		_internals.dispatchReviewerAgent = _originalDispatchReviewerAgent;

		// Clean up temp dir
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// ─── Test 1: Reviewer evidence compiled correctly from lane evidence files ──
	test('compileReviewPackage gathers lane evidence correctly', async () => {
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

		// Compile review package using real functions
		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			false,
		);

		expect(pkg.phase).toBe(1);
		expect(pkg.sessionID).toBe('test-session');
		expect(pkg.laneSummaries).toHaveLength(2);
		expect(pkg.laneSummaries[0].laneId).toBe('lane-1');
		expect(pkg.laneSummaries[0].files).toEqual(['src/a.ts', 'src/b.ts']);
		expect(pkg.laneSummaries[1].laneId).toBe('lane-2');
		expect(pkg.filesChanged).toContain('src/a.ts');
		expect(pkg.filesChanged).toContain('src/b.ts');
		expect(pkg.filesChanged).toContain('src/c.ts');
		expect(pkg.testResults.totalLanes).toBe(2);
		expect(pkg.testResults.completedLanes).toBe(2);
		expect(pkg.testResults.failedLanes).toBe(0);
	});

	// ─── Test 2: Reviewer dispatch uses correct agent name ───────────────────
	test('dispatch uses configured reviewerAgent name', async () => {
		let capturedAgentName: string | undefined;

		_internals.dispatchReviewerAgent = mock(
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

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session', {
			reviewerAgent: 'mega_reviewer',
		});

		expect(result.verdict).toBe('APPROVED');
		expect(capturedAgentName).toBe('mega_reviewer');
	});

	test('dispatch uses default reviewer agent when not configured', async () => {
		let capturedAgentName: string | undefined;

		_internals.dispatchReviewerAgent = mock(
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

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
		// Default should be 'reviewer' since no generatedAgentNames are mocked
		expect(capturedAgentName).toBe('reviewer');
	});

	// ─── Test 3: Reviewer verdict is parsed and written to evidence file ──────
	test('APPROVED verdict is parsed and written to evidence', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'VERDICT: APPROVED\nREASON: all lanes completed successfully';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
		expect(result.reason).toBe('all lanes completed successfully');
		expect(result.evidencePath).toContain('.swarm');
		expect(result.evidencePath).toContain('lean-turbo-reviewer.json');

		// Verify the evidence file was actually written
		const evidenceContent = fs.readFileSync(result.evidencePath, 'utf-8');
		const parsed = JSON.parse(evidenceContent);
		expect(parsed.verdict).toBe('APPROVED');
		expect(parsed.reason).toBe('all lanes completed successfully');
		expect(parsed.phase).toBe(1);
		expect(parsed.timestamp).toBeTruthy();
	});

	test('NEEDS_REVISION verdict is parsed and written', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'VERDICT: NEEDS_REVISION\nREASON: lane-2 failed but phase was marked complete';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('NEEDS_REVISION');
		expect(result.reason).toBe('lane-2 failed but phase was marked complete');
	});

	test('REJECTED verdict is parsed and written', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'VERDICT: REJECTED\nREASON: unresolved degraded tasks remain';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('unresolved degraded tasks remain');
	});

	// ─── Test 4: Missing lane evidence is handled gracefully ───────────────────
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

		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'VERDICT: APPROVED\nREASON: no lanes found but phase is clean';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
		expect(result.reason).toBe('no lanes found but phase is clean');
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

		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'VERDICT: APPROVED\nREASON: phase evidence missing but lanes complete';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('APPROVED');
	});

	// ─── Test 5: Malformed reviewer response → fail-closed ─────────────────────
	test('malformed response (no VERDICT marker) → REJECTED', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'The reviewer thought about it but gave no verdict.';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('Reviewer response could not be parsed');
	});

	test('empty response → REJECTED', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return '';
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('Reviewer response could not be parsed');
	});

	test('dispatch throws error → REJECTED with error reason', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			throw new Error('Session creation failed');
		});

		const result = await dispatchPhaseReviewer(dir, 1, 'test-session');

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe(
			'Reviewer dispatch failed: Session creation failed',
		);
	});

	// ─── Test 6: parseReviewerVerdict edge cases ───────────────────────────────
	test('parseReviewerVerdict: case insensitive verdict matching', () => {
		const result1 = _internals.parseReviewerVerdict('verdict: approved');
		expect(result1?.verdict).toBe('APPROVED');

		const result2 = _internals.parseReviewerVerdict('Verdict: NEEDS_REVISION');
		expect(result2?.verdict).toBe('NEEDS_REVISION');

		const result3 = _internals.parseReviewerVerdict('VERDICT: REJECTED');
		expect(result3?.verdict).toBe('REJECTED');
	});

	test('parseReviewerVerdict: reason extracted from next line', () => {
		const result = _internals.parseReviewerVerdict(
			'VERDICT: APPROVED\nREASON: all checks passed',
		);
		expect(result?.verdict).toBe('APPROVED');
		expect(result?.reason).toBe('all checks passed');
	});

	test('parseReviewerVerdict: verdict without reason → reason undefined', () => {
		const result = _internals.parseReviewerVerdict('VERDICT: APPROVED');
		expect(result?.verdict).toBe('APPROVED');
		expect(result?.reason).toBeUndefined();
	});

	test('parseReviewerVerdict: returns null for unrecognized verdict', () => {
		const result = _internals.parseReviewerVerdict('VERDICT: MAYBE');
		expect(result).toBeNull();
	});

	// ─── Test 7: writeReviewerEvidence writes atomic JSON ──────────────────────
	test('writeReviewerEvidence creates valid JSON with correct shape', async () => {
		const evidencePath = await _internals.writeReviewerEvidence(
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

	// ─── Test 8: resolveDefaultReviewerAgent ──────────────────────────────────
	test('resolveDefaultReviewerAgent: returns reviewer when no generated names', () => {
		const result = _internals.resolveDefaultReviewerAgent([]);
		expect(result).toBe('reviewer');
	});

	test('resolveDefaultReviewerAgent: returns longest matching _reviewer suffix', () => {
		const result = _internals.resolveDefaultReviewerAgent([
			'reviewer',
			'local_reviewer',
			'mega_reviewer',
		]);
		// 'local_reviewer' (14 chars) is longest
		expect(result).toBe('local_reviewer');
	});

	test('resolveDefaultReviewerAgent: prefers -reviewer suffix over bare reviewer', () => {
		const result = _internals.resolveDefaultReviewerAgent([
			'reviewer',
			'cloud-reviewer',
		]);
		expect(result).toBe('cloud-reviewer');
	});

	test('resolveDefaultReviewerAgent: falls back to first generated name if no reviewer suffix', () => {
		const result = _internals.resolveDefaultReviewerAgent([
			'mega_coder',
			'local_coder',
		]);
		expect(result).toBe('mega_coder');
	});

	// ─── Test 9: compileReviewPackage with requireDiffSummary ──────────────────
	test('compileReviewPackage: does not include integratedDiffSummary when not required', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
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
			integratedDiffSummary: 'added: 100 lines, removed: 50 lines',
		});

		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			false,
		);

		expect(pkg.integratedDiffSummary).toBeUndefined();
	});

	test('compileReviewPackage: includes integratedDiffSummary when requireDiffSummary=true', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
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
			integratedDiffSummary: 'added: 100 lines, removed: 50 lines',
		});

		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			true,
		);

		expect(pkg.integratedDiffSummary).toBe(
			'added: 100 lines, removed: 50 lines',
		);
	});

	// ─── Test 10: compilation includes degradation summary ──────────────────────
	test('compileReviewPackage: degradation summary computed correctly', async () => {
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

		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			false,
		);

		// 1.2 is covered by lane and completed → resolved
		// 1.3 is NOT covered by any lane → pending
		expect(pkg.degradationSummary.totalDegraded).toBe(2);
		expect(pkg.degradationSummary.resolvedDegraded).toBe(1);
		expect(pkg.degradationSummary.pendingDegraded).toBe(1);
	});

	// ─── Test 11: build status derived from phase and lane status ──────────────
	test('compileReviewPackage: buildStatus=passed when completed and no failed lanes', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
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

		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			false,
		);

		expect(pkg.buildStatus).toBe('passed');
	});

	test('compileReviewPackage: buildStatus=failed when phase status is failed', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'failed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(dir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'failed',
		});

		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			false,
		);

		expect(pkg.buildStatus).toBe('failed');
	});

	test('compileReviewPackage: buildStatus=failed when some lanes failed', async () => {
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'completed',
			sessionId: 'test-session',
		});
		writeLaneEvidence(dir, 1, {
			laneId: 'lane-2',
			taskIds: ['1.2'],
			files: [],
			status: 'failed',
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

		const pkg = await _internals.compileReviewPackage(
			dir,
			1,
			'test-session',
			false,
		);

		expect(pkg.buildStatus).toBe('failed');
		expect(pkg.testResults.failedLanes).toBe(1);
	});

	// ─── Test 12: Evidence file path follows expected pattern ─────────────────
	test('evidence file path follows .swarm/evidence/{phase}/lean-turbo-reviewer.json', async () => {
		_internals.dispatchReviewerAgent = mock(async (directory: string) => {
			return 'VERDICT: APPROVED\nREASON: all good';
		});

		const result = await dispatchPhaseReviewer(dir, 3, 'test-session');

		expect(result.evidencePath).toMatch(
			/\.swarm[\\/]evidence[\\/]3[\\/]lean-turbo-reviewer\.json$/,
		);
	});

	// ─── Test 13a: dispatchReviewerAgent passes directory to session.create ─────────
	test('dispatchReviewerAgent passes directory to client.session.create', async () => {
		let capturedDirectory: string | undefined;

		const mockClient = {
			session: {
				create: mock(async (params: { query: { directory: string } }) => {
					capturedDirectory = params.query.directory;
					return { data: { id: 'mock-session-id' } };
				}),
				prompt: mock(async () => ({
					data: {
						parts: [{ type: 'text', text: 'VERDICT: APPROVED\nREASON: test' }],
					},
				})),
				delete: mock(async () => ({})),
			},
		};

		const originalClient = swarmState.opencodeClient;
		swarmState.opencodeClient = mockClient as typeof mockClient;

		try {
			const pkg = makeReviewPackage();
			await _internals.dispatchReviewerAgent(dir, pkg, 'test_reviewer', 0);

			expect(capturedDirectory).toBe(dir);
		} finally {
			swarmState.opencodeClient = originalClient;
		}
	});

	// ─── Test 13: timeoutMs=0 does NOT short-circuit prompt ─────────────────────
	test('defaultDispatchReviewerAgent with timeoutMs=0 awaits prompt without racing', async () => {
		// Set up a mock opencodeClient
		let promptCallCount = 0;
		let promptResolve: (value: {
			data: { parts: Array<{ type: 'text'; text?: string }> };
		}) => void;

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'mock-session-id' },
				})),
				prompt: mock(
					async () =>
						new Promise<{
							data: { parts: Array<{ type: 'text'; text?: string }> };
						}>((resolve) => {
							promptCallCount++;
							promptResolve = resolve;
						}),
				),
				delete: mock(async () => ({})),
			},
		};

		const originalClient = swarmState.opencodeClient;
		swarmState.opencodeClient = mockClient as typeof mockClient;

		try {
			// Call defaultDispatchReviewerAgent directly with timeoutMs=0
			const pkg = makeReviewPackage();
			const resultPromise = _internals.dispatchReviewerAgent(
				dir,
				pkg,
				'test_reviewer',
				0,
			);

			// Give the event loop a tick so the prompt call registers
			await new Promise((r) => setTimeout(r, 10));

			// Verify prompt was called exactly once (not racing against a 0ms timeout)
			expect(promptCallCount).toBe(1);

			// Resolve the prompt
			await promptResolve!({
				data: {
					parts: [
						{
							type: 'text',
							text: 'VERDICT: APPROVED\nREASON: timeout test passed',
						},
					],
				},
			});

			const result = await resultPromise;
			expect(result).toContain('VERDICT: APPROVED');
		} finally {
			swarmState.opencodeClient = originalClient;
		}
	});

	test('defaultDispatchReviewerAgent with timeoutMs>0 races against rejecting timeout', async () => {
		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'mock-session-id' },
				})),
				prompt: mock(async () => {
					// This promise never resolves - simulating a hung prompt
					return new Promise(() => {});
				}),
				delete: mock(async () => ({})),
			},
		};

		const originalClient = swarmState.opencodeClient;
		swarmState.opencodeClient = mockClient as typeof mockClient;

		try {
			// Call defaultDispatchReviewerAgent with a very short timeout
			const pkg = makeReviewPackage();
			let thrownError: Error | undefined;

			try {
				await _internals.dispatchReviewerAgent(dir, pkg, 'test_reviewer', 50);
			} catch (err) {
				thrownError = err as Error;
			}

			// Should have timed out
			expect(thrownError).toBeDefined();
			expect(thrownError?.message).toMatch(/timed out after 50ms/);
		} finally {
			swarmState.opencodeClient = originalClient;
		}
	});
});
