/**
 * `LoadCorpusOptions.filter` — narrowing a request must WIDEN its budget.
 *
 * The bug this file pins: `maxEvidenceItems` truncated the corpus first and the
 * miner's request filters ran second, so "narrow with `run_ids` /
 * `task_categories` when you need a conclusion the cut cannot have shaped" was
 * exactly backwards. Narrowing to the only category that mattered took a
 * 50-observation corpus to 0, because the 50 slots had already been filled with
 * observations the filter then removed.
 *
 * Readers are injected rather than mocked at module scope (AGENTS.md invariant
 * 7). The wiring half — that `mineConsensus` actually hands its predicate to the
 * loader — is asserted against the real miner, because a filter the loader
 * accepts but nothing supplies is unwired code.
 */

import { describe, expect, test } from 'bun:test';
import type {
	CorpusObservation,
	CorpusReaders,
} from '../../../src/consensus/corpus';
import { loadConsensusCorpus } from '../../../src/consensus/corpus';
import { mineConsensus } from '../../../src/consensus/miner';
import { config, corpusOf, request } from './fixtures';

const DIRECTORY = '/virtual/project';

/** Readers that return nothing, so a test only wires the source it asserts on. */
function emptyReaders(): CorpusReaders {
	return {
		listEvaluationRunIds: async () => [],
		readEvaluationRun: async () => undefined,
		listGateAuditResults: async () => ({ results: [], corruptRunIds: [] }),
		readGateGroundTruth: async () => ({ events: [], malformed: 0 }),
		listEvidenceTaskIds: async () => [],
		readTaskTrajectory: async () => [],
		listTrajectorySessions: async () => [],
		readTrajectory: async () => [],
		readSkillUsageEntries: () => [],
		readKnowledgeEntries: async () => [],
		loadEvidence: async () => ({ status: 'not_found' }),
		readRejectedLessons: async () => [],
		readRejectedSkillEdits: async () => [],
	};
}

/**
 * One knowledge entry per id. Knowledge sits LATE in `SOURCE_ORDER` (seventh of
 * nine), so a test can starve it by filling the budget from an earlier source.
 */
function knowledgeEntries(count: number, prefix: string) {
	return Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-${index}`,
		category: 'other',
		lesson: `lesson ${prefix} ${index}`,
		retrieval_outcomes: undefined,
	}));
}

/** Skill-usage entries, the source immediately BEFORE knowledge. */
function usageEntries(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `u${index}`,
		skillPath: '.claude/skills/example/SKILL.md',
		agentName: 'coder',
		taskID: `task-${index}`,
		timestamp: '2026-07-24T00:00:00.000Z',
		complianceVerdict: 'compliant' as const,
		sessionID: `s${index}`,
	}));
}

describe('loadConsensusCorpus — the filter runs before the budget', () => {
	test('without a filter, an early source can starve a later one', async () => {
		// The baseline the fix has to change: 10 skill-usage observations consume
		// the whole budget, so the knowledge source contributes nothing at all.
		const corpus = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 10,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				readSkillUsageEntries: () => usageEntries(10),
				readKnowledgeEntries: async () => knowledgeEntries(5, 'k'),
			},
		});
		expect(corpus.observations).toHaveLength(10);
		expect(
			corpus.observations.filter((observation) =>
				observation.runId.startsWith('knowledge:'),
			),
		).toHaveLength(0);
		expect(corpus.truncated).toBe(true);
	});

	test('a filter frees the budget for the observations that survive it', async () => {
		// Same corpus, same budget — but now the caller has declared it only wants
		// knowledge observations. Before the filter reached the loader this
		// returned ZERO observations: the 10 slots went to skill-usage and the
		// miner then discarded all of them.
		const corpus = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 10,
			maxExcerptChars: 500,
			filter: (observation: CorpusObservation) =>
				observation.runId.startsWith('knowledge:'),
			readers: {
				...emptyReaders(),
				readSkillUsageEntries: () => usageEntries(10),
				readKnowledgeEntries: async () => knowledgeEntries(5, 'k'),
			},
		});
		expect(corpus.observations).toHaveLength(5);
		expect(
			corpus.observations.every((observation) =>
				observation.runId.startsWith('knowledge:'),
			),
		).toBe(true);
		// Nothing was cut: everything the filter kept fitted in the budget.
		expect(corpus.truncated).toBe(false);
	});

	test('corpusHashes still describe the SOURCE, not the request', async () => {
		// The predicate is applied after the per-source hash on purpose. A hash
		// that moved with each caller's filters would stop being a fingerprint of
		// what the source contained — and it is hashed into `integrityHash`.
		const readers = {
			...emptyReaders(),
			readSkillUsageEntries: () => usageEntries(4),
		};
		const unfiltered = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 50,
			maxExcerptChars: 500,
			readers,
		});
		const filtered = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 50,
			maxExcerptChars: 500,
			filter: (observation: CorpusObservation) =>
				observation.evidenceRef.endsWith(':u0'),
			readers,
		});
		expect(filtered.observations).toHaveLength(1);
		expect(unfiltered.observations).toHaveLength(4);
		const usageHash = (
			corpus: Awaited<ReturnType<typeof loadConsensusCorpus>>,
		) => corpus.hashes.find((entry) => entry.source === 'skill-usage');
		expect(usageHash(filtered)).toEqual(
			usageHash(unfiltered) as { source: string; hash: string },
		);
		expect(usageHash(filtered)?.observations).toBe(4);
	});

	test('a filter that keeps nothing does not report a truncated corpus', async () => {
		const corpus = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 2,
			maxExcerptChars: 500,
			filter: () => false,
			readers: {
				...emptyReaders(),
				readSkillUsageEntries: () => usageEntries(10),
			},
		});
		expect(corpus.observations).toHaveLength(0);
		// `truncated` means "the cap removed evidence you asked for". Nothing was
		// asked for here, so claiming a cut would be a false partial-view warning.
		expect(corpus.truncated).toBe(false);
	});
});

describe('mineConsensus — the request predicate reaches the loader', () => {
	test('the loader is handed a predicate that implements the request filters', async () => {
		let received: ((observation: CorpusObservation) => boolean) | undefined;
		await mineConsensus(
			DIRECTORY,
			request({ minSupport: 1, taskCategories: ['refactor'] }),
			{
				config: config(),
				loadCorpus: async (_directory, options) => {
					received = options.filter;
					return corpusOf([]);
				},
				now: () => new Date('2026-07-24T00:00:00.000Z'),
			},
		);
		expect(received).toBeDefined();
		expect(
			received?.({
				runId: 'evaluation-run:r1',
				taskCategory: 'refactor',
				success: true,
				signals: ['tooling:x'],
				evidenceRef: 'evaluation-run:r1:t1:0',
			}),
		).toBe(true);
		// An observation with no category at all is excluded, not passed through:
		// "no category recorded" is not evidence of the requested one.
		expect(
			received?.({
				runId: 'knowledge:k1',
				success: true,
				signals: ['skill:x'],
				evidenceRef: 'knowledge:k1',
			}),
		).toBe(false);
	});

	test('an injected loader that ignores the filter is still filtered', async () => {
		// `deps.loadCorpus` is a test/DI seam, so the miner cannot assume the
		// predicate was honoured. Dropping its own second pass would let any
		// injected loader smuggle unrequested observations into the tally.
		const result = await mineConsensus(
			DIRECTORY,
			request({ minSupport: 1, taskCategories: ['refactor'] }),
			{
				config: config(),
				loadCorpus: async () =>
					corpusOf([
						{
							runId: 'evaluation-run:r1',
							taskId: 't1',
							taskCategory: 'refactor',
							success: true,
							signals: ['tooling:kept'],
							evidenceRef: 'evaluation-run:r1:t1:0',
						},
						{
							runId: 'evaluation-run:r2',
							taskId: 't2',
							taskCategory: 'bugfix',
							success: true,
							signals: ['tooling:dropped'],
							evidenceRef: 'evaluation-run:r2:t2:0',
						},
					]),
				now: () => new Date('2026-07-24T00:00:00.000Z'),
			},
		);
		expect(result.report.attributes).toHaveLength(1);
		expect(result.report.attributes[0]?.statement).toContain('kept');
		expect(result.report.truncation.observations).toBe(1);
	});
});
