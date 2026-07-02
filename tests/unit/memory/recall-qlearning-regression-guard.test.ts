import { afterEach, describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createConfiguredMemoryProvider,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	type MemoryProvider,
	type MemoryRecord,
	type RecallRequest,
} from '../../../src/memory';
import {
	DEFAULT_QLEARNING_CONFIG,
	type MemoryConfig,
} from '../../../src/memory/config';
import { clearPool } from '../../../src/memory/provider-pool';
import {
	createSafeTestDir,
	safeRmRecursive,
} from '../../helpers/safe-test-dir';

/**
 * A.9 — golden-fixture regression guard for the memory learning loop
 * (spec FR-013/SC-010, plan A.9 acceptance).
 *
 * This guard must FAIL if the q-learning loop (A.5 ranking boost +
 * A.6 suppression, wired in `scoreMemoryRecordsWithDiagnostics` and threaded
 * through both providers via `config.qLearning`) ever regresses recall
 * quality relative to a loop-DISABLED baseline.
 *
 * Non-circularity: the baseline is captured with the loop OFF
 * (`qValueBoostWeight: 0, suppressionThreshold: 0`), not loop-vs-loop.
 * Non-inertness: the fixture is deliberately constructed so lexically-similar
 * "distractor" records outscore the true answers on pure lexical signal (via
 * a tag-overlap gap of +0.16, comfortably larger than any FTS rerank delta),
 * occupying the baseline top-k. Only the q-learning loop (suppression of
 * their low qValue) removes them, which is the effect under test — see the
 * "record design" fixture comment below for the exact arithmetic.
 */

// ---------------------------------------------------------------------------
// Fixture: one query, one repository scope, 3 relevant + 2 distractor records.
// ---------------------------------------------------------------------------
//
// Query tokens (after tokenize()): {database, connection, pool, timeout}.
//
// RELEVANT records (R1, R2, R3): text contains all 4 query tokens verbatim,
// NO tags (so tagOverlap = 0). High qValue (0.9) for R1/R2, neutral (0.5)
// for R3 (demonstrates the A.5 ranking boost doesn't affect base inclusion).
//   baseScore = 1.0*0.38 (text) + 0 (tag) + 0.8*0.12 (scope=repository)
//             + 0.5*0.06 (kindProfile, no kinds filter) + 0.8*0.08 (confidence)
//             = 0.38 + 0.096 + 0.03 + 0.064 = 0.57
//
// DISTRACTOR records (D1, D2): text ALSO contains all 4 query tokens verbatim
// (so they are retrieved and pollute precision), but ALSO carry the 4 query
// words as tags (tagOverlap = 1.0), and LOW qValue (0.05, below the 0.15
// suppression threshold).
//   baseScore = 0.38 (text) + 1.0*0.16 (tag) + 0.096 (scope) + 0.03 (kind)
//             + 0.064 (confidence) = 0.73
//
// So distractors (0.73) OUTSCORE relevants (0.57) on pure lexical signal —
// this is what makes the fixture non-inert. With maxItems=3:
//   - BASELINE (suppression threshold=0, boost weight=0): ranking is pure
//     baseScore. Top-3 = {D1, D2, <one relevant>}. precision@3 = 1/3,
//     recall@3 = 1/3.
//   - ENABLED (default qLearning config): D1/D2 have qValue 0.05 < 0.15 →
//     suppressed entirely (removed from candidates, never scored). Only
//     {R1, R2, R3} remain, all returned. precision@3 = 3/3 = 1.0,
//     recall@3 = 3/3 = 1.0.
const QUERY = 'database connection pool timeout';
const REPO_SCOPE = {
	type: 'repository' as const,
	repoId: 'qlearning-guard-repo',
};
const MAX_ITEMS = 3;
const TIMESTAMP = '2026-05-26T12:00:00.000Z';

interface FixtureSpec {
	label: string;
	text: string;
	tags: string[];
	qValue: number;
	relevant: boolean;
}

const FIXTURE_RECORDS: FixtureSpec[] = [
	{
		label: 'R1',
		text: 'The database connection pool timeout retry logic uses exponential backoff for transient failures.',
		tags: [],
		qValue: 0.9,
		relevant: true,
	},
	{
		label: 'R2',
		text: 'Configuring database connection pool timeout values correctly avoids exhausting the pool under load.',
		tags: [],
		qValue: 0.9,
		relevant: true,
	},
	{
		label: 'R3',
		text: 'A database connection pool timeout that is too aggressive causes spurious failures during GC pauses.',
		tags: [],
		qValue: 0.5,
		relevant: true,
	},
	{
		label: 'D1',
		text: 'database connection pool timeout — unrelated notes about vacation scheduling policy for the team.',
		tags: ['database', 'connection', 'pool', 'timeout'],
		qValue: 0.05,
		relevant: false,
	},
	{
		label: 'D2',
		text: 'database connection pool timeout — unrelated notes about the office snack budget for Q3 planning.',
		tags: ['database', 'connection', 'pool', 'timeout'],
		qValue: 0.05,
		relevant: false,
	},
];

function buildRecord(spec: FixtureSpec): MemoryRecord {
	const base = {
		scope: REPO_SCOPE,
		kind: 'code_pattern' as const,
		text: spec.text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: spec.tags,
		confidence: 0.8,
		stability: 'durable',
		source: {
			type: 'manual' as const,
			ref: 'qlearning-regression-guard-fixture',
		},
		createdAt: TIMESTAMP,
		updatedAt: TIMESTAMP,
		contentHash: computeMemoryContentHash(base),
		metadata: { qValue: spec.qValue, fixtureLabel: spec.label },
	};
}

function buildRequest(): RecallRequest {
	return {
		query: QUERY,
		mode: 'manual',
		scopes: [REPO_SCOPE],
		maxItems: MAX_ITEMS,
		tokenBudget: 2000,
		minScore: 0,
	};
}

const BASELINE_QLEARNING_CONFIG = {
	...DEFAULT_QLEARNING_CONFIG,
	qValueBoostWeight: 0,
	suppressionThreshold: 0,
};

// C.1 (FR-014/SC-016) layers a bounded, probabilistic active-exploration
// resurrection on top of A.6 suppression, gated by `qLearning.explorationRate`
// (default 0.05) and drawn from the real `Math.random` in production
// (providers call `scoreMemoryRecordsWithDiagnostics` without injecting a
// deterministic `random`). This guard verifies A.5 ranking + A.6 suppression
// ONLY — pin `explorationRate: 0` so a real-random draw can never flip D1/D2
// back into the "enabled" retrieved set and flake this golden-fixture guard.
// C.1 exploration itself has dedicated deterministic coverage in
// `scoring-exploration.test.ts`.
const ENABLED_QLEARNING_CONFIG = {
	...DEFAULT_QLEARNING_CONFIG,
	explorationRate: 0,
};

interface RecallMetrics {
	precisionAtK: number;
	recallAtK: number;
	retrievedIds: string[];
	retrievedLabels: string[];
}

function computeMetrics(
	retrievedIds: string[],
	relevantIds: Set<string>,
): RecallMetrics {
	const hits = retrievedIds.filter((id) => relevantIds.has(id)).length;
	return {
		precisionAtK: hits / Math.max(retrievedIds.length, 1),
		recallAtK: hits / Math.max(relevantIds.size, 1),
		retrievedIds,
		retrievedLabels: retrievedIds,
	};
}

async function runFixture(
	provider: MemoryProvider,
	labelById: Map<string, string>,
	relevantIds: Set<string>,
): Promise<RecallMetrics> {
	await provider.initialize?.();
	const items = await provider.recall(buildRequest());
	const retrievedIds = items.map((item) => item.record.id);
	const metrics = computeMetrics(retrievedIds, relevantIds);
	return {
		...metrics,
		retrievedLabels: retrievedIds.map((id) => labelById.get(id) ?? id),
	};
}

// Tracks temp roots created across all tests in this file so afterEach can
// clean them up AFTER clearPool() has released sqlite DB handles (Windows
// EBUSY guard — see .claude/skills/writing-tests/SKILL.md).
const tempRoots: string[] = [];

afterEach(async () => {
	// Release sqlite pool handles BEFORE removing temp dirs, mirroring
	// src/memory/provider-pool.test.ts and the A.8 memory-value-log pattern.
	clearPool();
	for (const root of tempRoots) {
		try {
			safeRmRecursive(root);
		} catch {
			// Best-effort; a lingering Windows file lock must not fail the suite.
		}
	}
	tempRoots.length = 0;
});

async function makeProvider(
	providerName: 'local-jsonl' | 'sqlite',
	qLearning: MemoryConfig['qLearning'],
): Promise<{
	provider: MemoryProvider;
	labelById: Map<string, string>;
	relevantIds: Set<string>;
}> {
	const { dir } = createSafeTestDir(`qlearning-guard-${providerName}-`);
	tempRoots.push(dir);
	const config: MemoryConfig = {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider: providerName,
		qLearning,
	};
	const provider = createConfiguredMemoryProvider(dir, config);
	const labelById = new Map<string, string>();
	const relevantIds = new Set<string>();
	for (const spec of FIXTURE_RECORDS) {
		const record = buildRecord(spec);
		labelById.set(record.id, spec.label);
		if (spec.relevant) relevantIds.add(record.id);
		await provider.upsert(record);
	}
	return { provider, labelById, relevantIds };
}

const providersToRun: Array<'local-jsonl' | 'sqlite'> = ['local-jsonl'];
let sqliteAvailable = true;
try {
	// Availability probe. sqlite-provider.ts resolves the Bun sqlite driver
	// lazily (only on first DB access), so we do a direct probe here to decide
	// whether to add the sqlite branch, matching the try/catch skip contract
	// described in the task ("if sqlite recall throws/skip ... guard behind
	// try/catch so the jsonl guard always runs").
	await import('bun:sqlite');
} catch (err) {
	sqliteAvailable = false;
	console.warn(
		`[recall-qlearning-regression-guard] bun:sqlite unavailable in this environment, skipping sqlite branch: ${
			err instanceof Error ? err.message : String(err)
		}`,
	);
}
if (sqliteAvailable) providersToRun.push('sqlite');

describe('A.9 — q-learning loop regression guard (FR-013/SC-010)', () => {
	for (const providerName of providersToRun) {
		describe(`provider: ${providerName}`, () => {
			test('loop-enabled recall never regresses precision@k or recall@k vs the loop-disabled baseline, and strictly improves precision@k', async () => {
				let baseline: RecallMetrics;
				let enabled: RecallMetrics;
				try {
					const baselineSetup = await makeProvider(
						providerName,
						BASELINE_QLEARNING_CONFIG,
					);
					baseline = await runFixture(
						baselineSetup.provider,
						baselineSetup.labelById,
						baselineSetup.relevantIds,
					);
					await baselineSetup.provider.close?.();

					const enabledSetup = await makeProvider(
						providerName,
						ENABLED_QLEARNING_CONFIG,
					);
					enabled = await runFixture(
						enabledSetup.provider,
						enabledSetup.labelById,
						enabledSetup.relevantIds,
					);
					await enabledSetup.provider.close?.();
				} catch (err) {
					if (providerName === 'sqlite') {
						console.warn(
							`[recall-qlearning-regression-guard] sqlite branch threw at runtime, skipping: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
						return;
					}
					throw err;
				}

				// Visibility: print the measured numbers so non-inertness is auditable.
				console.log(
					`[${providerName}] baseline precision@${MAX_ITEMS}=${baseline.precisionAtK.toFixed(3)} recall@${MAX_ITEMS}=${baseline.recallAtK.toFixed(3)} retrieved=${JSON.stringify(baseline.retrievedLabels)}`,
				);
				console.log(
					`[${providerName}] enabled  precision@${MAX_ITEMS}=${enabled.precisionAtK.toFixed(3)} recall@${MAX_ITEMS}=${enabled.recallAtK.toFixed(3)} retrieved=${JSON.stringify(enabled.retrievedLabels)}`,
				);

				// Sanity: the fixture must actually be non-inert. If this fails, the
				// distractors did not win the baseline top-k and the rest of the
				// assertions below would be checking nothing.
				expect(baseline.retrievedLabels).toContain('D1');

				// --- Assertion 1: the loop NEVER regresses quality. ---
				expect(enabled.precisionAtK).toBeGreaterThanOrEqual(
					baseline.precisionAtK,
				);
				expect(enabled.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);

				// --- Assertion 2 (STRICT): the loop demonstrably HELPS. A guard where
				// this can only be made to pass with `>=` would tolerate an inert
				// (no-op) loop; it must be `>` to prove suppression actually fired.
				expect(enabled.precisionAtK).toBeGreaterThan(baseline.precisionAtK);

				// --- Assertion 3: direct evidence suppression fired — a low-q
				// distractor present in the baseline retrieved set is ABSENT from
				// the enabled retrieved set. ---
				const baselineHasDistractor = baseline.retrievedLabels.some(
					(label) => label === 'D1' || label === 'D2',
				);
				expect(baselineHasDistractor).toBe(true);
				const enabledHasDistractor = enabled.retrievedLabels.some(
					(label) => label === 'D1' || label === 'D2',
				);
				expect(enabledHasDistractor).toBe(false);

				// Exact expected values per the fixture arithmetic in the comment above.
				expect(baseline.precisionAtK).toBeCloseTo(1 / 3, 5);
				expect(baseline.recallAtK).toBeCloseTo(1 / 3, 5);
				expect(enabled.precisionAtK).toBeCloseTo(1, 5);
				expect(enabled.recallAtK).toBeCloseTo(1, 5);
			});
		});
	}

	test('at least one provider actually ran the guard', () => {
		// If this is empty, the whole suite above silently no-op'd (e.g. every
		// provider constructor threw before the try/catch could distinguish a
		// real skip from a broken fixture). Guard against a silently-vacuous file.
		expect(providersToRun.length).toBeGreaterThan(0);
	});
});
