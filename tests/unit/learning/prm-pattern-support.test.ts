/**
 * PRM pattern persistence support tracking (issue #1821, AC10).
 *
 * The load-bearing property here is that support counts DISTINCT step ranges.
 * PRM re-reports a live pattern on every subsequent tool call, so a naive
 * observation count would let ONE long pattern self-confirm to the threshold
 * within seconds and mint a durable knowledge entry from a single incident.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { computeInsightCandidateId } from '../../../src/hooks/micro-reflector.js';
import {
	_internals,
	buildPrmEvidenceRef,
	buildPrmPatternCandidate,
	computePatternIdentity,
	getPatternSupport,
	getTrackedPrmIdentityCount,
	getTrackedPrmSessionCount,
	MAX_IDENTITIES_PER_SESSION,
	MAX_OCCURRENCES_PER_IDENTITY,
	MAX_TRACKED_SESSIONS,
	recordPatternObservation,
	resetPrmPatternSupport,
} from '../../../src/learning/prm-pattern-support.js';
import type { PatternMatch } from '../../../src/prm/types.js';

function match(overrides: Partial<PatternMatch> = {}): PatternMatch {
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

const limits = { minSupport: 3, cooldownMs: 900_000 };
const realNow = _internals.now;

beforeEach(() => {
	resetPrmPatternSupport();
	_internals.now = realNow;
});

afterEach(() => {
	resetPrmPatternSupport();
	_internals.now = realNow;
});

describe('computePatternIdentity', () => {
	it('is order-insensitive across agents and targets', () => {
		const a = computePatternIdentity({
			pattern: 'ping_pong',
			affectedAgents: ['coder', 'reviewer'],
			affectedTargets: ['b.ts', 'a.ts'],
		});
		const b = computePatternIdentity({
			pattern: 'ping_pong',
			affectedAgents: ['reviewer', 'coder'],
			affectedTargets: ['a.ts', 'b.ts'],
		});
		expect(a).toBe(b);
	});

	it('separates the same pattern on different targets', () => {
		expect(
			computePatternIdentity({
				pattern: 'repetition_loop',
				affectedAgents: ['coder'],
				affectedTargets: ['a.ts'],
			}),
		).not.toBe(
			computePatternIdentity({
				pattern: 'repetition_loop',
				affectedAgents: ['coder'],
				affectedTargets: ['b.ts'],
			}),
		);
	});
});

describe('recordPatternObservation — distinct occurrence support', () => {
	it('does NOT let ONE GROWING window self-confirm (regression: advancing endStep)', () => {
		// This is the shape `pattern-detector.ts` actually emits: `stepRange` is
		// `[startStep, endStep]` and `endStep` ADVANCES on every tool call while
		// the pattern stays live, so a single continuous incident produces
		// [1,2], [1,3], [1,4], ... Keying support on the whole range would count
		// each of those as a new observation and cross min_support=3 within one
		// four-step loop, minting a durable cross-session entry from ONE incident.
		for (let end = 2; end <= 8; end++) {
			const result = recordPatternObservation(
				's1',
				match({ stepRange: [1, end] }),
				limits,
			);
			expect(result.support).toBe(1);
			expect(result.persistable).toBe(false);
			expect(result.reason).toBe('below_support');
		}
	});

	it('does NOT let one repeated identical range self-confirm either', () => {
		for (let i = 0; i < 5; i++) {
			const result = recordPatternObservation('s1', match(), limits);
			expect(result.support).toBe(1);
			expect(result.persistable).toBe(false);
		}
	});

	it('reaches the threshold only after min_support separate occurrences', () => {
		expect(
			recordPatternObservation('s1', match({ stepRange: [1, 5] }), limits)
				.persistable,
		).toBe(false);
		expect(
			recordPatternObservation('s1', match({ stepRange: [6, 10] }), limits)
				.persistable,
		).toBe(false);
		const third = recordPatternObservation(
			's1',
			match({ stepRange: [11, 15] }),
			limits,
		);
		expect(third.support).toBe(3);
		expect(third.persistable).toBe(true);
		expect(third.candidate).toBeDefined();
	});

	it('keeps one evidence pointer per occurrence, widened as the window grows', () => {
		recordPatternObservation('s1', match({ stepRange: [1, 5] }), limits);
		// Same occurrence, wider window — the pointer must track the widest end
		// rather than adding a second pointer for the same incident.
		recordPatternObservation('s1', match({ stepRange: [1, 9] }), limits);
		const result = recordPatternObservation(
			's1',
			match({ stepRange: [12, 16] }),
			limits,
		);
		expect(result.support).toBe(2);
		expect(result.evidenceRefs).toEqual([
			'prm:s1:repetition_loop:1-9',
			'prm:s1:repetition_loop:12-16',
		]);
	});

	it('honours a min_support of 1 for a single decisive observation', () => {
		const result = recordPatternObservation('s1', match(), {
			...limits,
			minSupport: 1,
		});
		expect(result.persistable).toBe(true);
	});
});

describe('recordPatternObservation — cooldown', () => {
	function reachThreshold(session = 's1'): void {
		recordPatternObservation(session, match({ stepRange: [1, 5] }), limits);
		recordPatternObservation(session, match({ stepRange: [6, 10] }), limits);
		recordPatternObservation(session, match({ stepRange: [11, 15] }), limits);
	}

	it('suppresses a second persist inside the cooldown window', () => {
		let clock = 1_000_000;
		_internals.now = () => clock;
		reachThreshold();

		clock += 60_000; // 1 minute later, well inside the 15-minute cooldown
		const again = recordPatternObservation(
			's1',
			match({ stepRange: [16, 20] }),
			limits,
		);
		expect(again.support).toBe(4);
		expect(again.persistable).toBe(false);
		expect(again.reason).toBe('cooling_down');
	});

	it('allows a persist again once the cooldown has elapsed', () => {
		let clock = 1_000_000;
		_internals.now = () => clock;
		reachThreshold();

		clock += 900_001; // just past cooldown_ms
		const again = recordPatternObservation(
			's1',
			match({ stepRange: [16, 20] }),
			limits,
		);
		expect(again.persistable).toBe(true);
		expect(again.candidate).toBeDefined();
	});

	it('applies the cooldown PER IDENTITY, not per session', () => {
		let clock = 1_000_000;
		_internals.now = () => clock;
		reachThreshold();

		clock += 1_000;
		// A DIFFERENT identity (different target) is unaffected by the first
		// identity's cooldown.
		const other = () => match({ affectedTargets: ['src/other.ts'] });
		recordPatternObservation('s1', { ...other(), stepRange: [1, 5] }, limits);
		recordPatternObservation('s1', { ...other(), stepRange: [6, 10] }, limits);
		const third = recordPatternObservation(
			's1',
			{ ...other(), stepRange: [11, 15] },
			limits,
		);
		expect(third.persistable).toBe(true);
	});
});

describe('buildPrmPatternCandidate', () => {
	it('emits an actionable candidate carrying evidence POINTERS only', () => {
		const candidate = buildPrmPatternCandidate(
			match(),
			['prm:s1:repetition_loop:1-5'],
			'2026-01-01T00:00:00.000Z',
		);
		expect(candidate).toBeDefined();
		expect(candidate?.applies_to_agents).toEqual(['coder']);
		expect(candidate?.required_actions?.length).toBeGreaterThan(0);
		expect(candidate?.source.kind).toBe('prm_pattern');
		expect(candidate?.source_refs).toEqual(['prm:s1:repetition_loop:1-5']);
		// Nothing resembling transcript or reasoning text may appear anywhere.
		const serialized = JSON.stringify(candidate);
		expect(serialized).not.toContain('same edit repeated');
	});

	it('normalizes agent labels into the validator NAME_PATTERN shape', () => {
		const candidate = buildPrmPatternCandidate(
			match({ affectedAgents: ['Swarm Coder'] }),
			[],
			'2026-01-01T00:00:00.000Z',
		);
		expect(candidate?.applies_to_agents).toEqual(['swarm_coder']);
	});

	it('returns undefined when no usable scope survives normalization', () => {
		// An entry with no scope fails the Layer-5 gate, so emitting it would only
		// create quarantine churn.
		expect(
			buildPrmPatternCandidate(
				match({ affectedAgents: [] }),
				[],
				'2026-01-01T00:00:00.000Z',
			),
		).toBeUndefined();
		expect(
			buildPrmPatternCandidate(
				match({ affectedAgents: ['***'] }),
				[],
				'2026-01-01T00:00:00.000Z',
			),
		).toBeUndefined();
	});

	it('keeps the lesson inside the 280-char knowledge limit', () => {
		const candidate = buildPrmPatternCandidate(
			match({ pattern: 'x'.repeat(400) as PatternMatch['pattern'] }),
			[],
			'2026-01-01T00:00:00.000Z',
		);
		expect(candidate?.lesson.length).toBeLessThanOrEqual(280);
	});
});

describe('recordPatternObservation — unactionable pattern', () => {
	it('reports "unactionable" instead of emitting a scope-less candidate', () => {
		const scopeless = () => match({ affectedAgents: [] });
		recordPatternObservation(
			's1',
			{ ...scopeless(), stepRange: [1, 5] },
			limits,
		);
		recordPatternObservation(
			's1',
			{ ...scopeless(), stepRange: [6, 10] },
			limits,
		);
		const third = recordPatternObservation(
			's1',
			{ ...scopeless(), stepRange: [11, 15] },
			limits,
		);
		expect(third.persistable).toBe(false);
		expect(third.reason).toBe('unactionable');
		expect(third.candidate).toBeUndefined();
	});
});

describe('bounded module state (invariant 8)', () => {
	it('FIFO-evicts the oldest session key past MAX_TRACKED_SESSIONS', () => {
		for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
			recordPatternObservation(`s-${i}`, match(), limits);
		}
		expect(getTrackedPrmSessionCount()).toBe(MAX_TRACKED_SESSIONS);
		expect(
			getPatternSupport('s-0', computePatternIdentity(match())).support,
		).toBe(1);

		recordPatternObservation('overflow', match(), limits);
		expect(getTrackedPrmSessionCount()).toBe(MAX_TRACKED_SESSIONS);
		expect(
			getPatternSupport('s-0', computePatternIdentity(match())).support,
		).toBe(0);
		expect(
			getPatternSupport('overflow', computePatternIdentity(match())).support,
		).toBe(1);
	});

	it('FIFO-evicts the oldest identity past MAX_IDENTITIES_PER_SESSION', () => {
		for (let i = 0; i < MAX_IDENTITIES_PER_SESSION + 5; i++) {
			recordPatternObservation(
				's1',
				match({ affectedTargets: [`file-${i}.ts`] }),
				limits,
			);
		}
		expect(getTrackedPrmIdentityCount('s1')).toBe(MAX_IDENTITIES_PER_SESSION);
	});

	it('isolates support between sessions', () => {
		recordPatternObservation('a', match({ stepRange: [1, 5] }), limits);
		recordPatternObservation('a', match({ stepRange: [6, 10] }), limits);
		const bFirst = recordPatternObservation(
			'b',
			match({ stepRange: [1, 5] }),
			limits,
		);
		expect(bFirst.support).toBe(1);
		expect(
			getPatternSupport('a', computePatternIdentity(match())).support,
		).toBe(2);
	});

	it('rejects an empty session id without creating state', () => {
		const result = recordPatternObservation('', match(), limits);
		expect(result.persistable).toBe(false);
		expect(getTrackedPrmSessionCount()).toBe(0);
	});
});

describe('buildPrmEvidenceRef', () => {
	it('encodes only session, pattern, and step window', () => {
		expect(buildPrmEvidenceRef('sess-1', 'ping_pong', [3, 9])).toBe(
			'prm:sess-1:ping_pong:3-9',
		);
	});
});

describe('PRM candidate identity is STABLE across cooldown re-emissions (M1)', () => {
	function reachThreshold(): void {
		recordPatternObservation('s1', match({ stepRange: [1, 5] }), limits);
		recordPatternObservation('s1', match({ stepRange: [6, 10] }), limits);
		recordPatternObservation('s1', match({ stepRange: [11, 15] }), limits);
	}

	it('re-emits the SAME candidate id after the cooldown elapses', () => {
		// Regression: `created_at` was `new Date(now)` and the lesson embedded the
		// running support count, so every cooldown-spaced re-emission of the SAME
		// pattern minted a NEW candidate id — and therefore a new `insight:` marker.
		// D1 keys on that marker, so the same recurring incident would be confirmed
		// again every 15 minutes, inflating confidence toward hive auto-promotion.
		let clock = 1_000_000;
		_internals.now = () => clock;

		reachThreshold();
		const first = recordPatternObservation(
			's1',
			match({ stepRange: [16, 20] }),
			{ ...limits, cooldownMs: 0 },
		);
		expect(first.persistable).toBe(true);

		clock += 900_001;
		const second = recordPatternObservation(
			's1',
			match({ stepRange: [30, 35] }),
			limits,
		);
		expect(second.persistable).toBe(true);

		// Same identity => same lesson, same created_at => same candidate id.
		expect(second.candidate?.lesson).toBe(first.candidate?.lesson as string);
		expect(second.candidate?.created_at).toBe(
			first.candidate?.created_at as string,
		);
		expect(computeInsightCandidateId(second.candidate!)).toBe(
			computeInsightCandidateId(first.candidate!),
		);
	});

	it('gives a DIFFERENT identity a different candidate id', () => {
		let clock = 1_000_000;
		_internals.now = () => clock;
		reachThreshold();
		const a = recordPatternObservation('s1', match({ stepRange: [16, 20] }), {
			...limits,
			cooldownMs: 0,
		});

		clock += 10;
		const other = () => match({ affectedTargets: ['src/other.ts'] });
		recordPatternObservation('s1', { ...other(), stepRange: [1, 5] }, limits);
		recordPatternObservation('s1', { ...other(), stepRange: [6, 10] }, limits);
		const b = recordPatternObservation(
			's1',
			{ ...other(), stepRange: [11, 15] },
			limits,
		);
		expect(b.persistable).toBe(true);
		expect(computeInsightCandidateId(b.candidate!)).not.toBe(
			computeInsightCandidateId(a.candidate!),
		);
	});
});

describe('MAX_OCCURRENCES_PER_IDENTITY saturates support (V6)', () => {
	it('stops counting new occurrences past the per-identity cap', () => {
		for (let i = 0; i < MAX_OCCURRENCES_PER_IDENTITY + 25; i++) {
			recordPatternObservation(
				's1',
				match({ stepRange: [i * 10 + 1, i * 10 + 5] }),
				{ ...limits, cooldownMs: 0 },
			);
		}
		const state = getPatternSupport('s1', computePatternIdentity(match()));
		expect(state.support).toBe(MAX_OCCURRENCES_PER_IDENTITY);
		expect(state.occurrenceStarts).toHaveLength(MAX_OCCURRENCES_PER_IDENTITY);
	});
});
