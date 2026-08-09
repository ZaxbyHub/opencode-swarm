/**
 * The PRM producer's durable AC8 backstop (issue #1821 F3).
 *
 * AC8 says disabled or crashed real-time work loses nothing. The phase-boundary
 * drain can only see candidates that reached `.swarm/insight-candidates.jsonl`,
 * so the durable `appendInsightCandidates` must run whenever
 * `learning.prm_persistence.enabled` — independently of
 * `learning.realtime_admission.enabled`, which governs only the in-memory
 * enqueue. `src/index.ts` used to AND the two flags together, which switched the
 * durable write off with real-time admission and lost every PRM candidate
 * silently.
 *
 * NOTHING in the suite pinned that coupling: mutating the condition away left
 * `wiring.test.ts`, `prm-pattern-support.test.ts`,
 * `config/learning-consensus-config.test.ts` and `admission-hot-path.test.ts`
 * all green. This file is that pin, from both ends — the config mapping
 * `src/index.ts` hands the hook, and the hook's own behaviour under it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LearningConfigSchema } from '../../../src/config/schema.js';
import { resolveInsightCandidatesPath } from '../../../src/hooks/micro-reflector.js';
import {
	getQueueDepth,
	resetSessionQueue,
} from '../../../src/learning/candidate-queue.js';
import { resetPrmPatternSupport } from '../../../src/learning/prm-pattern-support.js';
import {
	_internals,
	createPrmHook,
	resolvePrmPatternPersistenceOptions,
} from '../../../src/prm/index.js';
import type { PatternMatch, PrmConfig } from '../../../src/prm/types.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// ============================================================================
// The mapping src/index.ts hands createPrmHook
// ============================================================================

describe('resolvePrmPatternPersistenceOptions', () => {
	it('keeps durable persistence ON when real-time admission is OFF', () => {
		// The regression, stated directly: `enabled` (which gates the durable
		// append inside the hook) must come from `prm_persistence.enabled` ALONE.
		const learning = LearningConfigSchema.parse({
			realtime_admission: { enabled: false },
		});
		const options = resolvePrmPatternPersistenceOptions(learning);

		expect(learning.prm_persistence.enabled).toBe(true);
		expect(options.enabled).toBe(true);
		expect(options.admission_enabled).toBe(false);
	});

	it('turns the whole producer off when prm_persistence is disabled', () => {
		const options = resolvePrmPatternPersistenceOptions(
			LearningConfigSchema.parse({ prm_persistence: { enabled: false } }),
		);
		expect(options.enabled).toBe(false);
		expect(options.admission_enabled).toBe(true);
	});

	it('carries the budgets from the block that owns each of them', () => {
		const options = resolvePrmPatternPersistenceOptions(
			LearningConfigSchema.parse({
				prm_persistence: { min_support: 7, cooldown_ms: 1234 },
				realtime_admission: { max_queue_size: 9 },
			}),
		);
		expect(options.min_support).toBe(7);
		expect(options.cooldown_ms).toBe(1234);
		expect(options.max_queue_size).toBe(9);
	});
});

// ============================================================================
// The hook's behaviour under that mapping
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

function patternMatch(): PatternMatch {
	return {
		pattern: 'repetition_loop',
		severity: 'medium',
		category: 'process',
		stepRange: [1, 5],
		description: 'same edit repeated',
		affectedAgents: ['coder'],
		affectedTargets: ['src/a.ts'],
		occurrenceCount: 3,
	} as PatternMatch;
}

const dir = canonicalMkdtemp('prm-durable-backstop-');
fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });

describe('createPrmHook — durable backstop is independent of admission', () => {
	const saved = {
		getAgentSession: _internals.getAgentSession,
		getInMemoryTrajectory: _internals.getInMemoryTrajectory,
		readTrajectory: _internals.readTrajectory,
		detectPatterns: _internals.detectPatterns,
		startReplayRecording: _internals.startReplayRecording,
		cleanupOldTrajectoryFiles: _internals.cleanupOldTrajectoryFiles,
		recordReplayEntry: _internals.recordReplayEntry,
		appendInsightCandidates: _internals.appendInsightCandidates,
	};

	/** The single session object the hook mutates, so a test can inspect it. */
	let session: {
		delegationActive: boolean;
		prmTrajectoryStep: number;
		prmPatternCounts: Map<string, number>;
		prmEscalationLevel: number;
		prmLastPatternDetected: unknown;
		prmHardStopPending: boolean;
		pendingAdvisoryMessages: string[];
	};

	beforeEach(() => {
		resetSessionQueue();
		resetPrmPatternSupport();
		fs.rmSync(resolveInsightCandidatesPath(dir), { force: true });
		session = {
			delegationActive: true,
			prmTrajectoryStep: 0,
			prmPatternCounts: new Map(),
			prmEscalationLevel: 0,
			prmLastPatternDetected: null,
			prmHardStopPending: false,
			pendingAdvisoryMessages: [],
		};
		_internals.getAgentSession = (() => session) as never;
		_internals.getInMemoryTrajectory = (() => [{ step: 4 }]) as never;
		_internals.readTrajectory = (async () => []) as never;
		_internals.startReplayRecording = (async () => null) as never;
		_internals.cleanupOldTrajectoryFiles = (async () => {}) as never;
		_internals.recordReplayEntry = (async () => {}) as never;
		_internals.detectPatterns = (() => ({
			matches: [patternMatch()],
		})) as never;
	});

	afterEach(() => {
		Object.assign(_internals, saved);
		resetSessionQueue();
		resetPrmPatternSupport();
	});

	const options = {
		enabled: true,
		min_support: 1,
		cooldown_ms: 0,
		admission_enabled: true,
		max_queue_size: 50,
	};

	function durableLines(): Array<{ source: { kind: string } }> {
		const p = resolveInsightCandidatesPath(dir);
		if (!fs.existsSync(p)) return [];
		return fs
			.readFileSync(p, 'utf-8')
			.split('\n')
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as { source: { kind: string } });
	}

	it('writes the durable candidate even when real-time admission is DISABLED', async () => {
		const hook = createPrmHook(prmConfig(), dir, {
			...options,
			admission_enabled: false,
		});
		await hook.toolAfter({ sessionID: 's-off', tool: 'bash' });

		// The whole point of AC8: the phase-boundary backstop still sees it.
		expect(durableLines()).toHaveLength(1);
		expect(durableLines()[0]?.source.kind).toBe('prm_pattern');
		// ...and only the in-memory queue is suppressed.
		expect(getQueueDepth('s-off')).toBe(0);
	});

	it('writes the durable candidate AND enqueues when admission is enabled', async () => {
		const hook = createPrmHook(prmConfig(), dir, options);
		await hook.toolAfter({ sessionID: 's-on', tool: 'bash' });

		expect(durableLines()).toHaveLength(1);
		expect(getQueueDepth('s-on')).toBe(1);
	});

	it('writes nothing durable when prm_persistence itself is disabled', async () => {
		const hook = createPrmHook(prmConfig(), dir, {
			...options,
			enabled: false,
		});
		await hook.toolAfter({ sessionID: 's-none', tool: 'bash' });

		expect(durableLines()).toHaveLength(0);
		expect(getQueueDepth('s-none')).toBe(0);
	});

	it('continues the tool-after pass when the durable append throws', async () => {
		// `appendInsightCandidates` rethrows a non-ENOENT failure (EACCES, a lock
		// timeout) under its `transactFile` lock. Left to the shared outer catch,
		// that throw skipped the course-correction push and the trajectory-cursor
		// advance below it — while `recordPatternObservation` had already started
		// the 15-minute cooldown, so the pattern was suppressed AND unreported.
		_internals.appendInsightCandidates = (async () => {
			throw Object.assign(new Error('EACCES: permission denied'), {
				code: 'EACCES',
			});
		}) as never;

		const hook = createPrmHook(prmConfig(), dir, options);
		await hook.toolAfter({ sessionID: 's-throw', tool: 'bash' });

		// The enqueue, the advisory injection, and the cursor advance all survive.
		expect(getQueueDepth('s-throw')).toBe(1);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.prmTrajectoryStep).toBe(4);
	});
});
