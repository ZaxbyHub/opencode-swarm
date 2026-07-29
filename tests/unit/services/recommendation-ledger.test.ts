/**
 * Cross-producer recommendation dedup ledger (issue #1821 AC21) — identity
 * functions and the check/record semantics.
 *
 * Bounds, eviction, and resilience live in `recommendation-ledger-bounds.test.ts`;
 * emission-site behaviour for the curator / improver / miner producers lives in
 * `recommendation-dedup-curator.test.ts` and
 * `recommendation-dedup-improver.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import { computeRecommendationFingerprint } from '../../../src/learning/fingerprint.js';
import {
	_internals,
	checkRecommendations,
	computeCrossProducerKey,
	computeRecommendationIdentity,
	isRecommendationCrossKey,
	type RecommendationCandidate,
	readRecommendationLedger,
	recordEmittedRecommendations,
	resolveRecommendationLedgerPath,
} from '../../../src/services/recommendation-ledger.js';

const PRODUCED_AT = '2026-07-25T12:00:00.000Z';

function candidate(
	overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
	return {
		kind: 'curator',
		target: 'entry-1',
		statement: 'Prefer dependency injection over mock.module',
		scopeKeys: [],
		...overrides,
	};
}

describe('recommendation identity', () => {
	it('produces the same cross key for every producer kind', () => {
		const statement = 'Prefer dependency injection over mock.module';
		const fromCurator = computeRecommendationIdentity({
			kind: 'curator',
			target: 'knowledge-abc',
			statement,
		});
		const fromMiner = computeRecommendationIdentity({
			kind: 'miner',
			target: 'skill',
			statement,
		});
		const fromImprover = computeRecommendationIdentity({
			kind: 'improver',
			target: 'motif-test-bash',
			statement,
		});

		// The whole point: kind and target are producer vocabulary, not identity.
		expect(fromCurator.crossKey).toBe(fromMiner.crossKey);
		expect(fromCurator.crossKey).toBe(fromImprover.crossKey);
		// The producer-scoped fingerprint still separates them, unchanged.
		expect(fromCurator.fingerprint).not.toBe(fromMiner.fingerprint);
		expect(fromCurator.fingerprint).not.toBe(fromImprover.fingerprint);
	});

	it('keeps the fingerprint byte-identical to computeRecommendationFingerprint', () => {
		const input = {
			kind: 'miner' as const,
			target: 'tooling',
			statement: 'Runs that skip the lint gate fail more often',
			scopeKeys: ['refactor', 'bugfix'],
		};
		expect(computeRecommendationIdentity(input).fingerprint).toBe(
			computeRecommendationFingerprint(input),
		);
	});

	it('is stable across whitespace, casing, and trailing punctuation', () => {
		const base = computeCrossProducerKey({
			statement: 'Prefer dependency injection over mock.module',
		});
		expect(
			computeCrossProducerKey({
				statement: '  Prefer   dependency\tinjection over mock.module.  ',
			}),
		).toBe(base);
		expect(
			computeCrossProducerKey({
				statement: 'PREFER DEPENDENCY INJECTION OVER MOCK.MODULE!',
			}),
		).toBe(base);
	});

	it('is stable across scope-key order and duplicates', () => {
		const base = computeCrossProducerKey({
			statement: 'Archive the stale lesson',
			scopeKeys: ['archive', 'entry-9'],
		});
		expect(
			computeCrossProducerKey({
				statement: 'Archive the stale lesson',
				scopeKeys: ['entry-9', 'archive', 'entry-9', '  '],
			}),
		).toBe(base);
	});

	it('separates genuinely different statements and scopes', () => {
		const a = computeCrossProducerKey({ statement: 'Always run the linter' });
		const b = computeCrossProducerKey({ statement: 'Always run the tests' });
		expect(a).not.toBe(b);

		const scoped = computeCrossProducerKey({
			statement: 'Always run the linter',
			scopeKeys: ['archive', 'entry-1'],
		});
		expect(scoped).not.toBe(a);
	});

	it('emits a well-formed lxk_ key', () => {
		const key = computeCrossProducerKey({ statement: 'anything at all' });
		expect(isRecommendationCrossKey(key)).toBe(true);
		expect(isRecommendationCrossKey('lrec_0123456789abcdef')).toBe(false);
		expect(isRecommendationCrossKey('lxk_TOOSHORT')).toBe(false);
	});
});

describe('checkRecommendations / recordEmittedRecommendations', () => {
	let dir: string;
	const realNow = _internals.now;

	beforeEach(() => {
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rec-ledger-')),
		);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		_internals.now = () => new Date(PRODUCED_AT);
	});

	afterEach(() => {
		_internals.now = realNow;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('resolves the ledger under .swarm/learning/', () => {
		expect(resolveRecommendationLedgerPath(dir)).toBe(
			path.join(dir, '.swarm', 'learning', 'recommendation-ledger.jsonl'),
		);
	});

	it('roots the ledger in the same store directory as knowledge.jsonl', () => {
		// The ledger shadows the knowledge store, so it must follow the SAME
		// link-aware resolution. A hardcoded `<directory>/.swarm` would strand the
		// ledger per-worktree while the lessons it records pooled into the shared
		// cohort store.
		const ledgerDir = path.dirname(
			path.dirname(resolveRecommendationLedgerPath(dir)),
		);
		expect(ledgerDir).toBe(path.dirname(resolveSwarmKnowledgePath(dir)));
	});

	it('returns no-op results for an empty candidate list', async () => {
		const checked = await checkRecommendations(dir, []);
		expect(checked.decisions).toEqual([]);
		expect(checked.degraded).toBe(false);

		const recorded = await recordEmittedRecommendations(dir, []);
		expect(recorded).toEqual({
			recorded: 0,
			suppressed: 0,
			evicted: 0,
			degraded: false,
		});
		expect(fs.existsSync(resolveRecommendationLedgerPath(dir))).toBe(false);
	});

	it('never writes during a check', async () => {
		const result = await checkRecommendations(dir, [candidate()]);
		expect(result.accepted).toBe(1);
		expect(result.decisions[0]?.emit).toBe(true);
		// The read-only half must leave no trace — this is what makes a deferred
		// recommendation retryable on a later sweep.
		expect(fs.existsSync(resolveRecommendationLedgerPath(dir))).toBe(false);
	});

	it('persists an emitted recommendation and suppresses the repeat', async () => {
		const first = await recordEmittedRecommendations(dir, [candidate()]);
		expect(first.recorded).toBe(1);
		expect(first.suppressed).toBe(0);
		expect(first.degraded).toBe(false);

		const entries = await readRecommendationLedger(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe('curator');
		expect(entries[0]?.target).toBe('entry-1');
		expect(entries[0]?.emittedAt).toBe(PRODUCED_AT);

		const check = await checkRecommendations(dir, [candidate()]);
		expect(check.accepted).toBe(0);
		expect(check.decisions[0]?.suppressedBy).toBe('ledger');

		// The record half re-checks under the lock, so a caller that ignored the
		// check still cannot grow a duplicate entry.
		const second = await recordEmittedRecommendations(dir, [candidate()]);
		expect(second.recorded).toBe(0);
		expect(second.suppressed).toBe(1);
		expect(await readRecommendationLedger(dir)).toHaveLength(1);
	});

	it('suppresses a duplicate that appears twice within one batch', async () => {
		const result = await checkRecommendations(dir, [
			candidate(),
			candidate({ target: 'entry-2' }),
		]);
		// Same statement, same (empty) scope keys → same cross key despite the
		// different target.
		expect(result.accepted).toBe(1);
		expect(result.decisions[0]?.emit).toBe(true);
		expect(result.decisions[1]?.emit).toBe(false);
		expect(result.decisions[1]?.suppressedBy).toBe('batch');
	});

	it('accepts genuinely different recommendations', async () => {
		const candidates = [
			candidate({ statement: 'Always run the linter before pushing' }),
			candidate({ statement: 'Always run the tests before pushing' }),
			candidate({
				statement: 'Always run the linter before pushing',
				scopeKeys: ['archive', 'entry-7'],
			}),
		];
		const check = await checkRecommendations(dir, candidates);
		expect(check.accepted).toBe(3);
		expect(check.suppressed).toBe(0);

		const recorded = await recordEmittedRecommendations(dir, candidates);
		expect(recorded.recorded).toBe(3);
		expect(await readRecommendationLedger(dir)).toHaveLength(3);
	});

	it('suppresses across producer kinds', async () => {
		const statement = 'Skip the flaky retry loop in the test harness';
		await recordEmittedRecommendations(dir, [
			{ kind: 'miner', target: 'tooling', statement },
		]);
		const curatorTurn = await checkRecommendations(dir, [
			{ kind: 'curator', target: 'new-knowledge', statement },
		]);
		expect(curatorTurn.suppressed).toBe(1);
		expect(curatorTurn.decisions[0]?.suppressedBy).toBe('ledger');
	});

	it('never records or suppresses on a blank statement', async () => {
		// A statement that normalizes to nothing carries no identity; if it were
		// keyed, the first blank recommendation from any producer would suppress
		// every other blank recommendation forever.
		const blanks = [
			candidate({ statement: '   ' }),
			candidate({ statement: '', target: 'entry-2' }),
		];
		const check = await checkRecommendations(dir, blanks);
		expect(check.accepted).toBe(2);

		const recorded = await recordEmittedRecommendations(dir, blanks);
		expect(recorded.recorded).toBe(0);
		expect(await readRecommendationLedger(dir)).toHaveLength(0);
	});

	it('round-trips a LearningProvenanceV1 stamp on the recorded entry', async () => {
		await recordEmittedRecommendations(dir, [
			candidate({
				provenance: {
					mechanism: 'curator_sweep',
					sourceKnowledgeIds: ['k-2', 'k-1', 'k-1', '  '],
					sourceTaskIds: ['task-b', 'task-a'],
				},
				origin: { agentRole: 'curator', sessionId: 'sess-1' },
			}),
		]);

		const [entry] = await readRecommendationLedger(dir);
		const provenance = entry?.provenance;
		expect(provenance?.v).toBe(1);
		expect(provenance?.mechanism).toBe('curator_sweep');
		// Deduped, sorted, whitespace-only dropped by stampLearningProvenance.
		expect(provenance?.sourceKnowledgeIds).toEqual(['k-1', 'k-2']);
		expect(provenance?.sourceTaskIds).toEqual(['task-a', 'task-b']);
		expect(provenance?.sourceEvidenceRefs).toEqual([]);
		expect(provenance?.writeOrigin.agentRole).toBe('curator');
		expect(provenance?.writeOrigin.sessionId).toBe('sess-1');
		// The record clock supplies producedAt when the caller does not.
		expect(provenance?.writeOrigin.producedAt).toBe(PRODUCED_AT);
	});

	it('omits provenance when the candidate supplies none', async () => {
		await recordEmittedRecommendations(dir, [candidate()]);
		const [entry] = await readRecommendationLedger(dir);
		expect(entry?.provenance).toBeUndefined();
	});

	it('honours an explicit producedAt override', async () => {
		await recordEmittedRecommendations(dir, [candidate()], {
			producedAt: '2020-01-02T03:04:05.000Z',
		});
		const [entry] = await readRecommendationLedger(dir);
		expect(entry?.emittedAt).toBe('2020-01-02T03:04:05.000Z');
	});
});
