/**
 * Tests for the epic_run_phase tool.
 * File: tests/unit/tools/epic-run-phase.test.ts
 *
 * Covers:
 *  - Fails closed when Epic Mode is not active for the session.
 *  - Fails gracefully when .swarm/plan.json is missing.
 *  - Demotion path: returns reason='demoted' without invoking LeanTurboRunner.
 *  - Promotion path: invokes LeanTurboRunner, returns the lane results.
 *  - Promotion-evidence is appended exactly once per call.
 *  - Records the decision into the session state (`recordEpicDecision`).
 *  - Lean runner exceptions are surfaced as reason='lean-runner-error'.
 *
 * Uses the _internals DI seam — no mock.module (AGENTS.md invariant 7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	epic_decide_phase,
	executeEpicDecidePhase,
	executeEpicRunPhase,
} from '../../../src/tools/epic-run-phase';

const realInternals = { ..._internals };

interface StubState {
	epicActive: boolean;
	plan: {
		phases: Array<{
			id: number;
			name: string;
			tasks: Array<{
				id: string;
				description: string;
				status: string;
				files_touched?: string[];
			}>;
		}>;
	} | null;
	pluginConfig: { turbo?: unknown };
	cochangeData: { pairs: unknown[]; commitsObserved: number };
	verdict: {
		decision: 'promote' | 'demote';
		p: number;
		rationale: unknown;
		blockingReasons: string[];
	};
	runnerResult: {
		ok: boolean;
		lanes?: unknown[];
		degradedTasks?: string[];
		serializedTasks?: string[];
	} | null;
	runnerThrows: boolean;
	evidenceAppends: number;
	decisionRecordings: number;
}

let stub: StubState;

beforeEach(() => {
	stub = {
		epicActive: true,
		plan: {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
						{
							id: '1.2',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
						},
					],
				},
			],
		},
		pluginConfig: {
			turbo: {
				strategy: 'lean',
				lean: { max_parallel_coders: 2 },
				epic: { mode: { enabled: true } },
			},
		},
		cochangeData: { pairs: [], commitsObserved: 50 },
		verdict: {
			decision: 'promote',
			p: 0,
			rationale: {
				pCheck: { passed: true, p: 0, threshold: 0.3 },
				hotModuleCheck: { passed: true, touchedHotModules: [] },
				greenfieldCheck: { passed: true, commitsObserved: 50, minCommits: 20 },
			},
			blockingReasons: [],
		},
		runnerResult: {
			ok: true,
			lanes: [],
			degradedTasks: [],
			serializedTasks: [],
		},
		runnerThrows: false,
		evidenceAppends: 0,
		decisionRecordings: 0,
	};

	_internals.isEpicModeActive = (() => stub.epicActive) as never;
	_internals.loadPlanJsonOnly = (async () => stub.plan) as never;
	_internals.loadPluginConfigWithMeta = (() => ({
		config: stub.pluginConfig,
		isUsingDefaults: false,
	})) as never;
	_internals.readTaskScopes = (() => null) as never;
	_internals.getCoChangeData = (async () => stub.cochangeData) as never;
	_internals.decideEpicActivation = (() => stub.verdict) as never;
	_internals.appendPromotionEvidence = (() => {
		stub.evidenceAppends += 1;
		return '/fake/evidence/path';
	}) as never;
	_internals.recordEpicDecision = (() => {
		stub.decisionRecordings += 1;
	}) as never;

	// Stub the LeanTurboRunner class.
	class FakeRunner {
		runPhase = async (_n: number) => {
			if (stub.runnerThrows) throw new Error('simulated runner failure');
			return stub.runnerResult!;
		};
		cleanupAfterSuccess = async () => {};
		cleanupAfterFailure = async () => {};
	}
	_internals.LeanTurboRunner = FakeRunner as never;
});

afterEach(() => {
	_internals.isEpicModeActive = realInternals.isEpicModeActive;
	_internals.loadPlanJsonOnly = realInternals.loadPlanJsonOnly;
	_internals.loadPluginConfigWithMeta = realInternals.loadPluginConfigWithMeta;
	_internals.readTaskScopes = realInternals.readTaskScopes;
	_internals.getCoChangeData = realInternals.getCoChangeData;
	_internals.decideEpicActivation = realInternals.decideEpicActivation;
	_internals.appendPromotionEvidence = realInternals.appendPromotionEvidence;
	_internals.recordEpicDecision = realInternals.recordEpicDecision;
	_internals.LeanTurboRunner = realInternals.LeanTurboRunner;
	_internals.loadCalibrationState = realInternals.loadCalibrationState;
	_internals.saveCalibrationState = realInternals.saveCalibrationState;
	_internals.applyCalibration = realInternals.applyCalibration;
	_internals.effectiveActivationThreshold =
		realInternals.effectiveActivationThreshold;
	_internals.effectiveHotModules = realInternals.effectiveHotModules;
	_internals.readDivergenceHistory = realInternals.readDivergenceHistory;
	// Phase 18 (δ HIGH): restore the Phase 12 additions to the seam.
	// Pre-Phase-18 the Phase 12 tests mutated `isGitRepo` and
	// `buildIsUpstreamCommittedWithStatus` without restoration — any test
	// added before them that needed the real implementation would silently
	// pick up the stubs.
	_internals.isGitRepo = realInternals.isGitRepo;
	_internals.buildIsUpstreamCommittedWithStatus =
		realInternals.buildIsUpstreamCommittedWithStatus;
	_internals.buildIsUpstreamCommitted = realInternals.buildIsUpstreamCommitted;
});

describe('executeEpicRunPhase — failure modes', () => {
	test('returns epic-mode-not-active when the session has not toggled on', async () => {
		stub.epicActive = false;
		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('epic-mode-not-active');
		expect(stub.evidenceAppends).toBe(0);
	});

	test('returns no-plan when plan.json is missing', async () => {
		stub.plan = null;
		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('no-plan');
		expect(stub.evidenceAppends).toBe(0);
	});
});

describe('executeEpicRunPhase — demotion path', () => {
	test('returns demoted without invoking LeanTurboRunner', async () => {
		stub.verdict = {
			...stub.verdict,
			decision: 'demote',
			p: 0.8,
			blockingReasons: ['p too high'],
		};
		let runnerInvoked = false;
		class TrackingRunner {
			runPhase = async () => {
				runnerInvoked = true;
				return { ok: true };
			};
			cleanupAfterSuccess = async () => {};
			cleanupAfterFailure = async () => {};
		}
		_internals.LeanTurboRunner = TrackingRunner as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(true);
		expect(result.reason).toBe('demoted');
		expect(result.verdict?.decision).toBe('demote');
		expect(runnerInvoked).toBe(false);
	});

	test('demotion still appends evidence and records the decision', async () => {
		stub.verdict = {
			...stub.verdict,
			decision: 'demote',
			p: 0.8,
			blockingReasons: ['x'],
		};
		await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(stub.evidenceAppends).toBe(1);
		expect(stub.decisionRecordings).toBe(1);
	});
});

describe('executeEpicRunPhase — promotion path', () => {
	test('invokes LeanTurboRunner and returns lane results', async () => {
		stub.runnerResult = {
			ok: true,
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					status: 'completed' as const,
				},
			],
			degradedTasks: [],
			serializedTasks: [],
		};
		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(true);
		expect(result.reason).toBe('promoted');
		expect(result.lanes).toHaveLength(1);
		expect(result.verdict?.decision).toBe('promote');
	});

	test('promotion appends evidence and records the decision exactly once', async () => {
		await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(stub.evidenceAppends).toBe(1);
		expect(stub.decisionRecordings).toBe(1);
	});

	test('lean runner exception surfaces as lean-runner-error', async () => {
		stub.runnerThrows = true;
		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('lean-runner-error');
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('simulated runner failure');
		// The verdict is still recorded even when execution fails.
		expect(result.verdict?.decision).toBe('promote');
	});
});

describe('executeEpicRunPhase — fail-closed on state-unreadable', () => {
	test('recordEpicDecision throw causes fail-closed before dispatch', async () => {
		let runnerInvoked = false;
		class TrackingRunner {
			runPhase = async () => {
				runnerInvoked = true;
				return { ok: true };
			};
			cleanupAfterSuccess = async () => {};
			cleanupAfterFailure = async () => {};
		}
		_internals.LeanTurboRunner = TrackingRunner as never;
		_internals.recordEpicDecision = (() => {
			throw new Error('Epic state is unreadable for /fake');
		}) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('epic-state-unreadable');
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('unreadable');
		// And critically: LeanTurboRunner was NOT invoked.
		expect(runnerInvoked).toBe(false);
		// The verdict is still returned (the decision was computed before
		// the state write attempted).
		expect(result.verdict?.decision).toBe('promote');
	});

	test('appendPromotionEvidence throw does NOT cause fail-closed (audit-only)', async () => {
		// Evidence-write failure is an audit-trail miss, not a safety
		// issue — execution still proceeds.
		let runnerInvoked = false;
		class TrackingRunner {
			runPhase = async () => {
				runnerInvoked = true;
				return { ok: true };
			};
			cleanupAfterSuccess = async () => {};
			cleanupAfterFailure = async () => {};
		}
		_internals.LeanTurboRunner = TrackingRunner as never;
		_internals.appendPromotionEvidence = (() => {
			throw new Error('simulated EROFS');
		}) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(true);
		expect(result.reason).toBe('promoted');
		expect(runnerInvoked).toBe(true);
	});
});

describe('executeEpicRunPhase — per-plan activation (Q1)', () => {
	test('decides over the whole plan, not just the requested phase', async () => {
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							id: '2.1',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
						},
					],
				},
				{
					id: 3,
					name: 'P3',
					tasks: [
						{
							id: '3.1',
							description: 'c',
							status: 'pending',
							files_touched: ['src/c.ts'],
						},
					],
				},
			],
		};
		let receivedTaskCount = 0;
		_internals.decideEpicActivation = ((tasks: unknown[]) => {
			receivedTaskCount = tasks.length;
			return stub.verdict;
		}) as never;

		await executeEpicRunPhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});
		// All 3 tasks from all 3 phases, not just the 1 task from phase 2.
		expect(receivedTaskCount).toBe(3);
	});
});

describe('executeEpicRunPhase — Capability D calibration wiring', () => {
	test('passes the calibration-effective threshold to decideEpicActivation', async () => {
		// Calibration says: override threshold to 0.10 and promote 'src/hot.ts'.
		_internals.loadCalibrationState = (() => ({
			version: 1 as const,
			updatedAt: 't',
			activationThresholdOverride: 0.1,
			hotModuleAdditions: ['src/hot.ts'],
			consecutiveCleanCount: 0,
			processedRecords: 0,
		})) as never;
		_internals.readDivergenceHistory = (() => []) as never;
		_internals.applyCalibration = ((s: unknown) => s) as never;
		_internals.saveCalibrationState = (() => {}) as never;
		_internals.effectiveActivationThreshold = (() => 0.1) as never;
		_internals.effectiveHotModules = (() => ['src/hot.ts']) as never;

		let capturedOptions: {
			activationThreshold: number;
			extraHotModules: string[];
		} | null = null;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			opts: unknown,
		) => {
			capturedOptions = opts as never;
			return stub.verdict;
		}) as never;

		await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(capturedOptions).not.toBeNull();
		expect(capturedOptions!.activationThreshold).toBe(0.1);
		expect(capturedOptions!.extraHotModules).toEqual(['src/hot.ts']);
	});

	test('runs applyCalibration when new divergence records exist and persists the result', async () => {
		const newRecord = {
			timestamp: 't',
			sessionID: 's',
			taskId: 'T-1',
			declaredScope: ['src/a.ts'],
			actualFiles: ['src/a.ts', 'src/b.ts'],
			undeclared: ['src/b.ts'],
			unused: [],
			divergenceRatio: 0.5,
			isClean: false,
		};
		_internals.loadCalibrationState = (() => ({
			version: 1 as const,
			updatedAt: 't',
			hotModuleAdditions: [],
			consecutiveCleanCount: 0,
			processedRecords: 0,
		})) as never;
		_internals.readDivergenceHistory = (() => [newRecord]) as never;
		let applyCalls = 0;
		_internals.applyCalibration = ((s: unknown) => {
			applyCalls += 1;
			return s;
		}) as never;
		let saveCalls = 0;
		_internals.saveCalibrationState = (() => {
			saveCalls += 1;
		}) as never;
		_internals.effectiveActivationThreshold = (() => 0.3) as never;
		_internals.effectiveHotModules = (() => []) as never;

		await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(applyCalls).toBe(1);
		expect(saveCalls).toBe(1);
	});

	test('calibration failure falls back to static knobs and does not block dispatch', async () => {
		_internals.loadCalibrationState = (() => {
			throw new Error('simulated calibration corruption');
		}) as never;

		let capturedOptions: {
			activationThreshold: number;
			extraHotModules?: string[];
		} | null = null;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			opts: unknown,
		) => {
			capturedOptions = opts as never;
			return stub.verdict;
		}) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		// Decision proceeds with the static default (0.3 — from the stub's plugin config).
		expect(capturedOptions).not.toBeNull();
		expect(capturedOptions!.activationThreshold).toBe(0.3);
		expect(capturedOptions!.extraHotModules).toEqual([]);
		expect(result.reason).toBe('promoted');
	});

	test('save-failure falls back to durable state for THIS run (adversarial H1 — prevents double-count drift)', async () => {
		// Records on disk that the engine would normally consume.
		const newRecord = {
			timestamp: 't',
			sessionID: 's',
			taskId: 'T-1',
			declaredScope: ['src/a.ts'],
			actualFiles: ['src/a.ts', 'src/b.ts'],
			undeclared: ['src/b.ts'],
			unused: [],
			divergenceRatio: 0.5,
			isClean: false,
		};
		const durable = {
			version: 1 as const,
			updatedAt: 't',
			hotModuleAdditions: ['src/durable.ts'],
			consecutiveCleanCount: 0,
			processedRecords: 0,
			activationThresholdOverride: 0.25,
		};
		const updated = {
			...durable,
			hotModuleAdditions: ['src/durable.ts', 'src/calibrated.ts'],
			activationThresholdOverride: 0.21,
			processedRecords: 1,
		};

		_internals.loadCalibrationState = (() => durable) as never;
		_internals.readDivergenceHistory = (() => [newRecord]) as never;
		_internals.applyCalibration = (() => updated) as never;
		_internals.saveCalibrationState = (() => {
			throw new Error('simulated EROFS');
		}) as never;
		_internals.effectiveActivationThreshold = ((
			_static: number,
			state: { activationThresholdOverride?: number },
		) => state.activationThresholdOverride ?? _static) as never;
		_internals.effectiveHotModules = ((
			_base: string[],
			state: { hotModuleAdditions: string[] },
		) => state.hotModuleAdditions) as never;

		let capturedOptions: {
			activationThreshold: number;
			extraHotModules?: string[];
		} | null = null;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			opts: unknown,
		) => {
			capturedOptions = opts as never;
			return stub.verdict;
		}) as never;

		await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		// MUST be durable values (0.25 / 'src/durable.ts'), NOT the in-memory
		// updated values (0.21 / 'src/calibrated.ts'). If save fails we ignore
		// this run's delta so next run won't re-apply the same records.
		expect(capturedOptions).not.toBeNull();
		expect(capturedOptions!.activationThreshold).toBe(0.25);
		expect(capturedOptions!.extraHotModules).toEqual(['src/durable.ts']);
	});

	test('honours turbo.epic.calibration.enabled=false by skipping the calibration step entirely', async () => {
		stub.pluginConfig = {
			turbo: {
				strategy: 'lean',
				lean: { max_parallel_coders: 2 },
				epic: {
					mode: { enabled: true },
					calibration: { enabled: false },
				},
			},
		};
		let loadCalls = 0;
		_internals.loadCalibrationState = (() => {
			loadCalls += 1;
			return null;
		}) as never;

		await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(loadCalls).toBe(0);
	});
});

describe('epic_decide_phase tool — ctx.sessionID precedence (Fix B)', () => {
	test('uses ctx.sessionID over args.sessionID when the framework supplies it', async () => {
		// Reproduce the live failure: weaker models hallucinate
		// sessionID="default" in args, while the framework supplies the
		// real session via ctx. The tool must prefer ctx.
		let observedSessionID: string | undefined;
		_internals.isEpicModeActive = ((_dir: string, sid: string) => {
			observedSessionID = sid;
			return true;
		}) as never;

		const def = epic_decide_phase as unknown as {
			execute: (
				args: unknown,
				ctx?: { sessionID?: string; directory?: string },
			) => Promise<unknown>;
		};
		await def.execute(
			{ phase: 1, sessionID: 'ses_defaultArg' },
			{ sessionID: 'ses_realCtxAbc123', directory: '/fake' },
		);
		expect(observedSessionID).toBe('ses_realCtxAbc123');
	});

	test('falls back to args.sessionID when ctx is missing', async () => {
		let observedSessionID: string | undefined;
		_internals.isEpicModeActive = ((_dir: string, sid: string) => {
			observedSessionID = sid;
			return true;
		}) as never;

		const def = epic_decide_phase as unknown as {
			execute: (
				args: unknown,
				ctx?: { sessionID?: string; directory?: string },
			) => Promise<unknown>;
		};
		// ctx with no sessionID — must use args.sessionID.
		await def.execute(
			{ phase: 1, sessionID: 'ses_fromArgs' },
			{ directory: '/fake' },
		);
		expect(observedSessionID).toBe('ses_fromArgs');
	});
});

describe('executeEpicRunPhase — scope-missing preflight (live-test escalation)', () => {
	test('refuses to dispatch when pending tasks have no declared scope AND no files_touched', async () => {
		// Plan with two pending tasks neither of which has scope data.
		// readTaskScopes returns null (no scope file) and files_touched is empty.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: [],
						},
						{
							id: '1.2',
							description: 'b',
							status: 'pending',
							files_touched: [],
						},
					],
				},
			],
		};
		_internals.readTaskScopes = (() => null) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('scopes-missing');
		expect(result.missingScopes).toEqual(['1.1', '1.2']);
		expect(result.message).toContain('declare_scope');
		expect(result.message).toContain('1.1, 1.2');
		expect(stub.evidenceAppends).toBe(0); // no decision happened
	});

	test('proceeds when scope file exists on disk (architect called declare_scope)', async () => {
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: [],
						},
					],
				},
			],
		};
		_internals.readTaskScopes = (() => ['src/a.ts']) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		// Reaches the decision and dispatches.
		expect(result.reason).not.toBe('scopes-missing');
		expect(stub.evidenceAppends).toBe(1);
	});

	test('proceeds when plan.files_touched is populated (no declare_scope needed)', async () => {
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
			],
		};
		_internals.readTaskScopes = (() => null) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.reason).not.toBe('scopes-missing');
		expect(stub.evidenceAppends).toBe(1);
	});

	test('completed tasks do NOT count toward missing-scope', async () => {
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'completed',
							files_touched: [],
						},
						{
							id: '1.2',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
						},
					],
				},
			],
		};
		_internals.readTaskScopes = (() => null) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.reason).not.toBe('scopes-missing');
	});

	test('reports only the truly-missing task ids in a mixed-state phase', async () => {
		stub.plan = {
			phases: [
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							id: '2.1',
							description: 'a',
							status: 'pending',
							files_touched: [],
						},
						{
							id: '2.2',
							description: 'b',
							status: 'pending',
							files_touched: [],
						},
						{
							id: '2.3',
							description: 'c',
							status: 'pending',
							files_touched: ['src/c.ts'],
						},
						{
							id: '2.4',
							description: 'd',
							status: 'completed',
							files_touched: [],
						},
					],
				},
			],
		};
		// 2.1 has on-disk scope; 2.2 has nothing; 2.3 has files_touched; 2.4 completed.
		_internals.readTaskScopes = ((_dir: string, taskId: string) =>
			taskId === '2.1' ? ['src/a.ts'] : null) as never;

		const result = await executeEpicRunPhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});
		expect(result.reason).toBe('scopes-missing');
		expect(result.missingScopes).toEqual(['2.2']);
	});
});

describe('executeEpicDecidePhase — transparent decide-only path', () => {
	test('returns reason="decided" on promote without dispatching Lean Turbo', async () => {
		let runnerInvoked = false;
		class TrackingRunner {
			runPhase = async () => {
				runnerInvoked = true;
				return { ok: true };
			};
			cleanupAfterSuccess = async () => {};
			cleanupAfterFailure = async () => {};
		}
		_internals.LeanTurboRunner = TrackingRunner as never;

		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(true);
		expect(result.reason).toBe('decided');
		expect(result.verdict?.decision).toBe('promote');
		// Critically: Lean Turbo was NOT invoked — the decide-only tool stops
		// before dispatch so the architect can dispatch via Task instead.
		expect(runnerInvoked).toBe(false);
		// Lane fields are absent because no dispatch happened.
		expect(result.lanes).toBeUndefined();
	});

	test('returns reason="demoted" on demote without dispatching', async () => {
		stub.verdict = {
			...stub.verdict,
			decision: 'demote',
			p: 0.8,
			blockingReasons: ['p too high'],
		};
		let runnerInvoked = false;
		class TrackingRunner {
			runPhase = async () => {
				runnerInvoked = true;
				return { ok: true };
			};
			cleanupAfterSuccess = async () => {};
			cleanupAfterFailure = async () => {};
		}
		_internals.LeanTurboRunner = TrackingRunner as never;

		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(true);
		expect(result.reason).toBe('demoted');
		expect(result.verdict?.decision).toBe('demote');
		expect(runnerInvoked).toBe(false);
	});

	test('still persists evidence + records decision (same audit trail as run_phase)', async () => {
		await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(stub.evidenceAppends).toBe(1);
		expect(stub.decisionRecordings).toBe(1);
	});

	test('propagates scope-missing error without ever computing the verdict', async () => {
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: [],
						},
					],
				},
			],
		};
		_internals.readTaskScopes = (() => null) as never;
		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.reason).toBe('scopes-missing');
		expect(stub.evidenceAppends).toBe(0);
	});
});

describe('executeEpicDecidePhase — Phase 12 fixes from adversarial review', () => {
	test('B11: requesting a phase number not in the plan returns reason="no-phase" instead of vacuously passing', async () => {
		// Pre-Phase-12 this slipped through silently — `currentPhaseTasks`
		// was empty, `crossPhaseUpstreams` empty, gate passed vacuously,
		// and the verdict was "promote" for a phase that doesn't exist.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
			],
		};
		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 99,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('no-phase');
		expect(result.message).toContain('99');
		expect(result.message).toContain('Available phases: 1');
		// Never reached the gate.
		expect(stub.evidenceAppends).toBe(0);
	});

	test('B9/B20: phantom dep IDs (architect typo) surface as phantomDeps NOT crossPhaseUpstreams', async () => {
		// Phase 13 refinement of B9: phantom deps were originally lumped
		// into `crossPhaseUpstreams`, which made the rationale claim a
		// missing cross-phase upstream even when the typo was for an
		// intra-phase dep. Now phantoms ride a separate `phantomDeps`
		// channel so the architect-facing reason can point at the
		// actual fix (correct the declaration), not a phantom upstream.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							id: '2.1',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
							// Phantom dep — task 1.7 does not exist.
							depends: ['1.7'],
						} as unknown as {
							id: string;
							description: string;
							status: string;
							files_touched: string[];
						},
					],
				},
			],
		};
		_internals.isGitRepo = (() => true) as never;
		_internals.buildIsUpstreamCommittedWithStatus = (() => ({
			predicate: () => false,
			gitFailed: false,
		})) as never;
		let capturedOptions: {
			crossPhaseUpstreams?: readonly string[];
			phantomDeps?: readonly string[];
		} | null = null;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			options: {
				crossPhaseUpstreams?: readonly string[];
				phantomDeps?: readonly string[];
			},
		) => {
			capturedOptions = options;
			return stub.verdict;
		}) as never;

		await executeEpicDecidePhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});

		expect(capturedOptions).not.toBeNull();
		// Phantom dep goes to phantomDeps, NOT crossPhaseUpstreams.
		expect(capturedOptions?.phantomDeps).toContain('1.7');
		expect(capturedOptions?.crossPhaseUpstreams).not.toContain('1.7');
	});

	test('B20: intra-phase phantom typo does NOT mislabel as a missing cross-phase upstream', async () => {
		// Concrete adversarial scenario: phase 2 task 2.1 declares
		// depends: ['2.99'] (typo for an intra-phase task that doesn't
		// exist). Pre-Phase-13: rationale would say "missing cross-phase
		// upstream 2.99" — sending the architect to commit a phantom in
		// an earlier phase. Post-Phase-13: phantomDeps contains 2.99
		// and the blocking reason cites it as a typo to fix.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							id: '2.1',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
							depends: ['2.99'], // intra-phase phantom typo
						} as unknown as {
							id: string;
							description: string;
							status: string;
							files_touched: string[];
						},
					],
				},
			],
		};
		_internals.isGitRepo = (() => true) as never;
		_internals.buildIsUpstreamCommittedWithStatus = (() => ({
			predicate: () => true,
			gitFailed: false,
		})) as never;
		let capturedOptions: {
			crossPhaseUpstreams?: readonly string[];
			phantomDeps?: readonly string[];
		} | null = null;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			options: {
				crossPhaseUpstreams?: readonly string[];
				phantomDeps?: readonly string[];
			},
		) => {
			capturedOptions = options;
			return stub.verdict;
		}) as never;

		await executeEpicDecidePhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});

		// The intra-phase phantom MUST NOT be reported as a
		// cross-phase upstream — that's the misattribution the B20
		// fix targets.
		expect(capturedOptions?.crossPhaseUpstreams).not.toContain('2.99');
		expect(capturedOptions?.phantomDeps).toContain('2.99');
	});

	test('B10: when git log read fails, executeEpicDecidePhase passes a fail-CLOSED predicate (not permissive)', async () => {
		// Pre-Phase-12 fix: `buildIsUpstreamCommitted` degraded to
		// `() => true` on git failure, silently admitting every phase as
		// "all upstreams committed". For Phase 10 (the only safety
		// signal post commit-floor retirement) this inverted the polarity.
		// Fix: detect the gitFailed flag and substitute `() => false` so
		// the rationale honestly reports the upstreams as missing.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							id: '2.1',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
							depends: ['1.1'],
						} as unknown as {
							id: string;
							description: string;
							status: string;
							files_touched: string[];
						},
					],
				},
			],
		};
		_internals.isGitRepo = (() => true) as never;
		// Simulate git breakage: status reports gitFailed: true, predicate
		// would have been the permissive `() => true` under old code.
		_internals.buildIsUpstreamCommittedWithStatus = (() => ({
			predicate: () => true,
			gitFailed: true,
		})) as never;
		let passedPredicate: ((id: string) => boolean) | undefined;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			options: { isUpstreamCommitted?: (id: string) => boolean },
		) => {
			passedPredicate = options.isUpstreamCommitted;
			return stub.verdict;
		}) as never;

		await executeEpicDecidePhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});

		// The predicate handed to the activation gate must NOT be the
		// permissive `() => true` from the broken git environment.
		expect(passedPredicate).toBeDefined();
		expect(passedPredicate?.('1.1')).toBe(false);
		expect(passedPredicate?.('anything')).toBe(false);
	});

	test('B10 happy path: when git log read succeeds, the real predicate is passed through unchanged', async () => {
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							id: '2.1',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
							depends: ['1.1'],
						} as unknown as {
							id: string;
							description: string;
							status: string;
							files_touched: string[];
						},
					],
				},
			],
		};
		_internals.isGitRepo = (() => true) as never;
		_internals.buildIsUpstreamCommittedWithStatus = (() => ({
			predicate: (id: string) => id === '1.1', // 1.1 IS committed, others not
			gitFailed: false,
		})) as never;
		let passedPredicate: ((id: string) => boolean) | undefined;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			options: { isUpstreamCommitted?: (id: string) => boolean },
		) => {
			passedPredicate = options.isUpstreamCommitted;
			return stub.verdict;
		}) as never;

		await executeEpicDecidePhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});

		expect(passedPredicate?.('1.1')).toBe(true);
		expect(passedPredicate?.('1.2')).toBe(false);
	});

	test('Phase 17 (E.1): a phase whose `tasks: []` is empty ⇒ reason="phase-empty", no verdict computed', async () => {
		// Pre-Phase-17 this slipped through: the B35 guard required
		// `phaseInPlan.tasks.length > 0`, so an empty `tasks: []` (an
		// architect-created phase header that was never populated)
		// fell through to a vacuous-pass `promote` — the same bug B35
		// was supposed to prevent. Phase 17 surfaces it as its own
		// reason so the architect either populates the phase or
		// removes the empty header.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [],
				},
			],
		};
		let decideCalled = false;
		_internals.decideEpicActivation = (() => {
			decideCalled = true;
			return stub.verdict;
		}) as never;

		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toBe('phase-empty');
		expect(result.message).toContain('no tasks');
		// The decision math was never invoked — the empty phase doesn't
		// silently produce a `promote`.
		expect(decideCalled).toBe(false);
	});

	test('B35: every task in the requested phase already completed ⇒ reason="phase-already-complete", no verdict computed', async () => {
		// Pre-Phase-15 this slipped through silently: B29's filter
		// produced an empty pending set → vacuous-pass on greenfield
		// (combined with p/hot passing on the whole-plan task set) →
		// verdict `promote`. The architect then called
		// `lean_turbo_plan_lanes` and got an empty lane plan with no
		// diagnostic. Correct answer is an explicit "phase is done".
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'completed',
							files_touched: ['src/a.ts'],
						},
						{
							id: '1.2',
							description: 'b',
							status: 'completed',
							files_touched: ['src/b.ts'],
						},
					],
				},
			],
		};
		let decideCalled = false;
		_internals.decideEpicActivation = (() => {
			decideCalled = true;
			return stub.verdict;
		}) as never;

		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toBe('phase-already-complete');
		expect(result.message).toContain('no pending tasks');
		// Decision math was never invoked — saves CPU and prevents the
		// misleading promote verdict.
		expect(decideCalled).toBe(false);
		// Never reached the evidence-append step.
		expect(stub.evidenceAppends).toBe(0);
	});

	test('B29: completed tasks in the current phase contribute NO deps to the activation gate', async () => {
		// A completed task whose `depends:` contains a phantom (typo
		// the architect never fixed) would, pre-Phase-14, keep the
		// gate failing for every future phase decision. The task is
		// already done — its declaration is no longer load-bearing.
		// Phase 14 filters to pending tasks before collecting deps.
		stub.plan = {
			phases: [
				{
					id: 1,
					name: 'P1',
					tasks: [
						{
							id: '1.1',
							description: 'a',
							status: 'pending',
							files_touched: ['src/a.ts'],
						},
					],
				},
				{
					id: 2,
					name: 'P2',
					tasks: [
						{
							// Completed task with a phantom dep — should
							// contribute NOTHING.
							id: '2.1',
							description: 'done',
							status: 'completed',
							files_touched: ['src/done.ts'],
							depends: ['1.7'],
						} as unknown as {
							id: string;
							description: string;
							status: string;
							files_touched: string[];
						},
						{
							// Pending task with a real cross-phase dep —
							// should be the only thing the gate sees.
							id: '2.2',
							description: 'b',
							status: 'pending',
							files_touched: ['src/b.ts'],
							depends: ['1.1'],
						} as unknown as {
							id: string;
							description: string;
							status: string;
							files_touched: string[];
						},
					],
				},
			],
		};
		_internals.isGitRepo = (() => true) as never;
		_internals.buildIsUpstreamCommittedWithStatus = (() => ({
			predicate: () => true,
			gitFailed: false,
		})) as never;
		let capturedOptions: {
			crossPhaseUpstreams?: readonly string[];
			phantomDeps?: readonly string[];
		} | null = null;
		_internals.decideEpicActivation = ((
			_tasks: unknown,
			_pairs: unknown,
			_commits: unknown,
			options: {
				crossPhaseUpstreams?: readonly string[];
				phantomDeps?: readonly string[];
			},
		) => {
			capturedOptions = options;
			return stub.verdict;
		}) as never;

		await executeEpicDecidePhase({
			directory: '/fake',
			phase: 2,
			sessionID: 's1',
		});

		// Phantom from completed 2.1 must NOT appear.
		expect(capturedOptions?.phantomDeps).not.toContain('1.7');
		// Real dep from pending 2.2 DOES appear.
		expect(capturedOptions?.crossPhaseUpstreams).toContain('1.1');
	});
});
