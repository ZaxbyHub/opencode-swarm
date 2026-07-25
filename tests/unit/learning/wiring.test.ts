/**
 * End-to-end wiring for Workstream B (issue #1821, Task 5).
 *
 * Covers the three seams that would otherwise be unwired code: the PRM
 * `toolAfter` placement, the micro-reflector enqueue alongside its durable
 * append, and the nudge suppression that keeps the architect from being told to
 * hand-curate lessons an automatic loop is already admitting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	LearningConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema.js';
import {
	resolveInsightCandidatesPath,
	runMicroReflection,
} from '../../../src/hooks/micro-reflector.js';
import {
	recordRealtimeLearningToolCall,
	resetRealtimeLearningNudgeState,
	shouldInjectRealtimeLearningNudge,
} from '../../../src/hooks/realtime-learning-nudge.js';
import {
	getQueueDepth,
	getQueueStats,
	resetSessionQueue,
	takeDrainBatch,
} from '../../../src/learning/candidate-queue.js';
import {
	getTrackedPrmSessionCount,
	resetPrmPatternSupport,
} from '../../../src/learning/prm-pattern-support.js';
import { _internals, createPrmHook } from '../../../src/prm/index.js';
import type { PatternMatch, PrmConfig } from '../../../src/prm/types.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// ============================================================================
// Nudge supersession
// ============================================================================

describe('shouldInjectRealtimeLearningNudge — supersede_nudge', () => {
	beforeEach(() => {
		resetRealtimeLearningNudgeState();
		// Cross the default first_after_tool_calls threshold of 10.
		for (let i = 0; i < 12; i++) recordRealtimeLearningToolCall('s1');
	});

	afterEach(() => resetRealtimeLearningNudgeState());

	it('still nudges when real-time admission is absent (default behaviour)', () => {
		expect(shouldInjectRealtimeLearningNudge({ sessionID: 's1' })).toBe(true);
	});

	it('still nudges when admission is explicitly DISABLED', () => {
		expect(
			shouldInjectRealtimeLearningNudge({
				sessionID: 's1',
				realtimeAdmission: { enabled: false, supersede_nudge: true },
			}),
		).toBe(true);
	});

	it('suppresses the nudge when admission is enabled and supersedes', () => {
		expect(
			shouldInjectRealtimeLearningNudge({
				sessionID: 's1',
				realtimeAdmission: { enabled: true, supersede_nudge: true },
			}),
		).toBe(false);
	});

	it('keeps nudging when admission is enabled but supersede_nudge is off', () => {
		expect(
			shouldInjectRealtimeLearningNudge({
				sessionID: 's1',
				realtimeAdmission: { enabled: true, supersede_nudge: false },
			}),
		).toBe(true);
	});

	it('treats an absent supersede_nudge as "supersede" (schema default is true)', () => {
		expect(
			shouldInjectRealtimeLearningNudge({
				sessionID: 's1',
				realtimeAdmission: { enabled: true },
			}),
		).toBe(false);
	});

	it('never nudges without a session id, regardless of admission state', () => {
		expect(
			shouldInjectRealtimeLearningNudge({
				realtimeAdmission: { enabled: false },
			}),
		).toBe(false);
	});
});

describe('shouldInjectRealtimeLearningNudge — default plugin config', () => {
	beforeEach(() => {
		resetRealtimeLearningNudgeState();
		for (let i = 0; i < 12; i++) recordRealtimeLearningToolCall('s1');
	});

	afterEach(() => resetRealtimeLearningNudgeState());

	it('suppresses the nudge for a project with NO explicit learning block', () => {
		// Regression: `PluginConfigSchema` declares `learning` as `.optional()`
		// with no `.prefault({})`, so `PluginConfigSchema.parse({}).learning` is
		// undefined. Reading it raw at the call site left admission running (its
		// own default is enabled) while the nudge still fired — exactly the
		// duplicated work `supersede_nudge` exists to remove.
		const rawPluginConfig = PluginConfigSchema.parse({});
		expect(rawPluginConfig.learning).toBeUndefined();

		const effective = LearningConfigSchema.parse(
			rawPluginConfig.learning ?? {},
		).realtime_admission;
		expect(effective.enabled).toBe(true);
		expect(effective.supersede_nudge).toBe(true);

		expect(
			shouldInjectRealtimeLearningNudge({
				sessionID: 's1',
				realtimeAdmission: effective,
			}),
		).toBe(false);
	});
});

// ============================================================================
// PRM toolAfter placement
// ============================================================================

function prmConfig(): PrmConfig {
	return {
		enabled: true,
		pattern_thresholds: {} as PrmConfig['pattern_thresholds'],
		max_trajectory_lines: 100,
		escalation_enabled: false,
		detection_timeout_ms: 1_000,
	};
}

function patternMatch(overrides: Partial<PatternMatch> = {}): PatternMatch {
	return {
		pattern: 'repetition_loop',
		severity: 'medium',
		category: 'process',
		stepRange: [1, 5],
		description: 'same edit repeated',
		affectedAgents: ['coder'],
		affectedTargets: ['src/a.ts'],
		occurrenceCount: 3,
		...overrides,
	} as PatternMatch;
}

function fakeSession() {
	return {
		delegationActive: true,
		prmTrajectoryStep: 0,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmHardStopPending: false,
		pendingAdvisoryMessages: [] as string[],
	};
}

// PRM I/O seams are all stubbed below, but the directory must still not be a
// hardcoded POSIX path (AGENTS.md invariant 7).
const prmDir = canonicalMkdtemp('prm-placement-');
fs.mkdirSync(path.join(prmDir, '.swarm'), { recursive: true });

describe('createPrmHook — pattern persistence placement', () => {
	const saved = {
		getAgentSession: _internals.getAgentSession,
		getInMemoryTrajectory: _internals.getInMemoryTrajectory,
		readTrajectory: _internals.readTrajectory,
		detectPatterns: _internals.detectPatterns,
		startReplayRecording: _internals.startReplayRecording,
		cleanupOldTrajectoryFiles: _internals.cleanupOldTrajectoryFiles,
		recordReplayEntry: _internals.recordReplayEntry,
		recordPatternObservation: _internals.recordPatternObservation,
		enqueueCandidate: _internals.enqueueCandidate,
	};

	beforeEach(() => {
		resetSessionQueue();
		resetPrmPatternSupport();
		fs.rmSync(resolveInsightCandidatesPath(prmDir), { force: true });
		_internals.getAgentSession = (() => fakeSession()) as never;
		_internals.getInMemoryTrajectory = (() => [{ step: 1 }]) as never;
		_internals.readTrajectory = (async () => []) as never;
		_internals.startReplayRecording = (async () => null) as never;
		_internals.cleanupOldTrajectoryFiles = (async () => {}) as never;
		_internals.recordReplayEntry = (async () => {}) as never;
	});

	afterEach(() => {
		Object.assign(_internals, saved);
		resetSessionQueue();
		resetPrmPatternSupport();
	});

	const persistence = {
		enabled: true,
		min_support: 1,
		cooldown_ms: 0,
		// #1821 F3: real-time admission gates ONLY the enqueue. The durable
		// backstop's independence from it is covered in
		// `prm-durable-backstop.test.ts`.
		admission_enabled: true,
		max_queue_size: 50,
	};

	it('does NOT record an observation when no pattern matched (hot path)', async () => {
		let observed = 0;
		_internals.detectPatterns = (() => ({ matches: [] })) as never;
		_internals.recordPatternObservation = ((...args: never[]) => {
			observed++;
			return saved.recordPatternObservation(
				...(args as Parameters<typeof saved.recordPatternObservation>),
			);
		}) as never;

		const hook = createPrmHook(prmConfig(), prmDir, persistence);
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });

		// The no-match path — every tool call in a healthy session — must create
		// NOTHING: no observation, no queue entry, and no module-level support
		// state for the session. Note this asserts the observable contract, not the
		// source position: the persistence block iterates `detectionResult.matches`,
		// so it is already a no-op for an empty match list. Its placement after the
		// `matches.length === 0` early return keeps that true by construction
		// rather than by the loop happening to be empty.
		expect(observed).toBe(0);
		expect(getQueueDepth('s1')).toBe(0);
		expect(getTrackedPrmSessionCount()).toBe(0);
	});

	it('records an observation and enqueues once support is met', async () => {
		_internals.detectPatterns = (() => ({
			matches: [patternMatch()],
		})) as never;

		const hook = createPrmHook(prmConfig(), prmDir, persistence);
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });

		// H1b: the DURABLE backstop must be written too. Without it a PRM
		// candidate lost to a drain failure, queue overflow, or process death is
		// gone for good — and `recordPatternObservation` starts the cooldown at
		// hand-over, so the same pattern is suppressed for 15 minutes afterwards.
		// The micro-reflector producer has had this backstop from the start.
		const durable = fs
			.readFileSync(resolveInsightCandidatesPath(prmDir), 'utf-8')
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as { source: { kind: string } });
		expect(durable).toHaveLength(1);
		expect(durable[0].source.kind).toBe('prm_pattern');

		expect(getQueueDepth('s1')).toBe(1);
		const [queued] = takeDrainBatch('s1', 1);
		expect(queued.candidate.source.kind).toBe('prm_pattern');
		expect(queued.candidate.applies_to_agents).toEqual(['coder']);
		// Evidence pointers only — no transcript or reasoning text.
		expect(queued.candidate.source_refs).toEqual([
			'prm:s1:repetition_loop:1-5',
		]);
	});

	it('does nothing when pattern persistence is disabled', async () => {
		_internals.detectPatterns = (() => ({
			matches: [patternMatch()],
		})) as never;

		const hook = createPrmHook(prmConfig(), prmDir, {
			...persistence,
			enabled: false,
		});
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });
		expect(getQueueDepth('s1')).toBe(0);
	});

	it('does nothing when the options argument is omitted entirely', async () => {
		_internals.detectPatterns = (() => ({
			matches: [patternMatch()],
		})) as never;

		const hook = createPrmHook(prmConfig(), prmDir);
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });
		expect(getQueueDepth('s1')).toBe(0);
	});

	it('withholds the candidate until min_support distinct ranges are seen', async () => {
		_internals.detectPatterns = (() => ({
			matches: [patternMatch()],
		})) as never;

		const hook = createPrmHook(prmConfig(), prmDir, {
			...persistence,
			min_support: 3,
		});
		// The SAME step range repeated is one observation, not three.
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });
		await hook.toolAfter({ sessionID: 's1', tool: 'bash' });
		expect(getQueueDepth('s1')).toBe(0);
	});
});

// ============================================================================
// Micro-reflector enqueue
// ============================================================================

describe('runMicroReflection — enqueue alongside the durable append', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('micro-enqueue-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		resetSessionQueue();
	});

	afterEach(() => {
		resetSessionQueue();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const llmResponse = JSON.stringify([
		{
			lesson: 'Re-run the failing test file before declaring the fix complete',
			applies_to_agents: ['coder'],
			required_actions: ['run the failing test before finishing'],
		},
	]);

	function reflectionParams(extra: Record<string, unknown> = {}) {
		return {
			directory: dir,
			taskId: 't-1',
			agent: 'coder',
			transcript: '3 failed tests remain',
			trajectory: [],
			llmDelegate: async () => llmResponse,
			...extra,
		};
	}

	function durableLines(): unknown[] {
		const p = resolveInsightCandidatesPath(dir);
		if (!fs.existsSync(p)) return [];
		return fs
			.readFileSync(p, 'utf-8')
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}

	it('writes the durable backstop AND enqueues for same-session admission', async () => {
		const result = await runMicroReflection(
			reflectionParams({ sessionID: 's1', admission: { enabled: true } }),
		);
		expect(result.candidates).toBe(1);
		// The durable append is the crash backstop (AC8) and must be unchanged.
		expect(durableLines()).toHaveLength(1);
		expect(getQueueDepth('s1')).toBe(1);
	});

	it('still writes the durable backstop when admission is disabled', async () => {
		const result = await runMicroReflection(
			reflectionParams({ sessionID: 's1', admission: { enabled: false } }),
		);
		expect(result.candidates).toBe(1);
		expect(durableLines()).toHaveLength(1);
		expect(getQueueDepth('s1')).toBe(0);
	});

	it('still writes the durable backstop when there is no session id', async () => {
		const result = await runMicroReflection(reflectionParams());
		expect(result.candidates).toBe(1);
		expect(durableLines()).toHaveLength(1);
	});

	it('honours the queue cap passed from config', async () => {
		for (let i = 0; i < 4; i++) {
			await runMicroReflection(
				reflectionParams({
					sessionID: 's1',
					admission: { enabled: true, maxQueueSize: 2 },
					transcript: `${i} failed tests remain`,
				}),
			);
		}
		expect(getQueueDepth('s1')).toBe(2);
		expect(getQueueStats('s1').dropped).toBe(2);
	});

	it('stamps a deterministic id on every enqueued candidate', async () => {
		await runMicroReflection(
			reflectionParams({ sessionID: 's1', admission: { enabled: true } }),
		);
		const [queued] = takeDrainBatch('s1', 1);
		expect(queued.candidate.id).toMatch(/^ic_[a-f0-9]{16}$/);
		// The durable line carries the identical id.
		expect((durableLines()[0] as { id: string }).id).toBe(
			queued.candidate.id as string,
		);
	});
});
