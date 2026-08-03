/**
 * The curated-failure corpus arm (issue #1821, Workstream C — AC28).
 *
 * Workstream C names five corpus arms; the fifth, "curated failures", was lost
 * at intake and never received an AC number. These tests pin what the recovered
 * arm actually reads, what it deliberately does NOT read, and — the point of the
 * arm — that a failure it contributes survives all the way into an attribute's
 * `failureSupport` and `counterexampleRefs` rather than being a record nothing
 * consumes.
 *
 * The polarity assertions matter for the same reason they do in
 * `corpus-sources.test.ts`: every observation this arm emits is `success: false`,
 * so a single inverted comparison would turn the corpus's only pure source of
 * negative evidence into a source of manufactured agreement.
 */

import { describe, expect, test } from 'bun:test';
import type {
	CorpusObservation,
	CorpusReaders,
} from '../../../src/consensus/corpus';
import { loadConsensusCorpus } from '../../../src/consensus/corpus';
import { mineConsensus } from '../../../src/consensus/miner';
import { config, request } from './fixtures';

const DIRECTORY = '/virtual/project';

/** Readers that return nothing, so a test only wires the store it asserts on. */
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

async function load(readers: Partial<CorpusReaders>) {
	return loadConsensusCorpus(DIRECTORY, {
		maxEvidenceItems: 100,
		maxExcerptChars: 500,
		readers: { ...emptyReaders(), ...readers },
	});
}

function byRef(
	observations: CorpusObservation[],
	ref: string,
): CorpusObservation {
	const found = observations.find(
		(observation) => observation.evidenceRef === ref,
	);
	if (!found) throw new Error(`no observation with evidenceRef ${ref}`);
	return found;
}

/** A retro bundle wrapped in the `loadEvidence` envelope the corpus consumes. */
function retroBundle(entry: Record<string, unknown>) {
	return {
		listEvidenceTaskIds: async () => ['retro-3'],
		loadEvidence: async () => ({
			status: 'found',
			bundle: { entries: [entry] },
		}),
	} as unknown as Partial<CorpusReaders>;
}

describe('curated failures — rejected lessons', () => {
	const readers = {
		readRejectedLessons: async () => [
			{
				id: 'rl-1',
				lesson: 'always rerun the failing file',
				rejection_reason: 'not_generalizable',
				rejection_layer: 2,
			},
		],
	};

	test('a rejected lesson is a FAILURE — the arm has no success polarity', async () => {
		const { observations } = await load(readers);
		expect(
			byRef(observations, 'curated-failure:rejected-lesson:rl-1').success,
		).toBe(false);
	});

	test('the signal carries layer and reason, and NOT the lesson prose', async () => {
		// Two rejections agreeing on a reason is evidence; two rejections of
		// unrelated prose is not. Signals are compared for equality, so admitting
		// the lesson text would make every rejection its own singleton attribute.
		const { observations } = await load(readers);
		const rejected = byRef(
			observations,
			'curated-failure:rejected-lesson:rl-1',
		);
		expect(rejected.signals).toEqual([
			'skill:rejected-lesson:2:not_generalizable',
		]);
		expect(rejected.runId).toBe('rejected-lesson:rl-1');
		// No task attribution exists in this store; absent, never defaulted.
		expect(rejected.taskId).toBeUndefined();
		expect(rejected.modelId).toBeUndefined();
	});

	test('a secret in a rejection reason is redacted before it is retained', async () => {
		const { observations } = await load({
			readRejectedLessons: async () => [
				{
					id: 'rl-2',
					lesson: 'x',
					rejection_reason: 'used sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
					rejection_layer: 1,
				},
			],
		});
		const joined = observations.map((entry) => entry.signals.join()).join();
		expect(joined).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
	});
});

describe('curated failures — rejected skill edits', () => {
	const readers = {
		readRejectedSkillEdits: async () => [
			{
				slug: 'writing-tests',
				operation: 'skill_apply',
				reason: 'eval_regression',
				candidateHash: 'abc123',
			},
			{
				slug: 'writing-tests',
				operation: 'skill_regenerate',
				reason: 'eval_regression',
				candidateHash: 'def456',
			},
		],
	};

	test('the CANDIDATE HASH is the trial identity, not the slug', async () => {
		// One slug rejected over two distinct candidates is two independent
		// adjudications. Keying on the slug would collapse them into one run and
		// silently halve the support behind a real, repeated skill regression.
		const { observations } = await load(readers);
		expect(new Set(observations.map((entry) => entry.runId))).toEqual(
			new Set(['rejected-skill-edit:abc123', 'rejected-skill-edit:def456']),
		);
	});

	test('both edits are failures and share the slug+reason signal', async () => {
		const { observations } = await load(readers);
		for (const entry of observations) {
			expect(entry.success).toBe(false);
			expect(entry.signals).toEqual([
				'skill:rejected-edit:writing-tests:eval_regression',
			]);
		}
	});
});

describe('curated failures — retrospective failure content', () => {
	test("a retro's error taxonomy and rejection reasons become failures on the task run", async () => {
		// `loadEvidenceBundles` reads only a retro's `verdict`, and write-retro
		// hardcodes that to 'pass' — so before this arm existed, a phase reporting
		// gate evasion entered the corpus as one clean passing observation.
		const { observations } = await load(
			retroBundle({
				type: 'retrospective',
				verdict: 'pass',
				error_taxonomy: ['gate_evasion', 'scope_creep'],
				top_rejection_reasons: ['missing tests'],
			}),
		);
		const curated = observations.filter((entry) =>
			entry.evidenceRef.startsWith('curated-failure:'),
		);
		expect(curated).toHaveLength(3);
		for (const entry of curated) {
			expect(entry.success).toBe(false);
			// Shares `task:<id>` with the trajectory and evidence-bundle views of the
			// same trial, so the retro cannot double its own apparent support.
			expect(entry.runId).toBe('task:retro-3');
			expect(entry.taskId).toBe('retro-3');
		}
		expect(curated.map((entry) => entry.signals[0]).sort()).toEqual([
			'orchestration:retro-error:gate_evasion',
			'orchestration:retro-error:scope_creep',
			'orchestration:retro-rejection:missing tests',
		]);
		// Both views are kept on purpose. The `evidence-bundle` arm still records
		// the retro as the passing artifact it is; the curated-failure arm records
		// what it says went wrong. One run, in both success and failure support.
		const bundle = observations.filter((entry) =>
			entry.evidenceRef.startsWith('evidence-bundle:'),
		);
		expect(bundle).toHaveLength(1);
		expect(bundle[0]?.success).toBe(true);
		expect(bundle[0]?.runId).toBe('task:retro-3');
	});

	test('a non-retrospective evidence entry contributes NOTHING to this arm', async () => {
		// A failing test-run entry is already the `evidence-bundle` arm's job. The
		// curated-failure arm reads adjudicated retro content only, so it must not
		// re-emit an outcome another source already counts on the same run id.
		const { observations, hashes } = await load(
			retroBundle({
				type: 'test_run',
				verdict: 'fail',
				error_taxonomy: ['logic_error'],
			}),
		);
		expect(
			observations.filter((entry) =>
				entry.evidenceRef.startsWith('curated-failure:'),
			),
		).toEqual([]);
		expect(
			hashes.find((entry) => entry.source === 'curated-failure')?.observations,
		).toBe(0);
	});

	test('an empty or blank reason is skipped rather than becoming a bare signal', async () => {
		const { observations } = await load(
			retroBundle({
				type: 'retrospective',
				error_taxonomy: [],
				top_rejection_reasons: ['   ', 'real reason'],
			}),
		);
		expect(
			observations
				.filter((entry) => entry.evidenceRef.startsWith('curated-failure:'))
				.map((entry) => entry.signals[0]),
		).toEqual(['orchestration:retro-rejection:real reason']);
	});
});

describe('curated failures — arm wiring', () => {
	test('the source contributes a corpusHashes row like every other source', async () => {
		const { hashes } = await load({
			readRejectedLessons: async () => [
				{ id: 'rl-1', lesson: 'x', rejection_reason: 'r', rejection_layer: 1 },
			],
		});
		const row = hashes.find((entry) => entry.source === 'curated-failure');
		expect(row?.observations).toBe(1);
		expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test('a throwing store degrades to unreadableSources, not to a failed mine', async () => {
		const { observations, unreadableSources } = await load({
			readRejectedSkillEdits: async () => {
				throw new Error('corrupt jsonl');
			},
		});
		expect(unreadableSources).toEqual(['curated-failure']);
		expect(observations).toEqual([]);
	});

	test('the arm participates in the maxEvidenceItems budget', async () => {
		const corpus = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 2,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				readRejectedLessons: async () =>
					Array.from({ length: 5 }, (_, index) => ({
						id: `rl-${index}`,
						lesson: 'x',
						rejection_reason: 'r',
						rejection_layer: 1,
					})),
			},
		});
		expect(corpus.observations).toHaveLength(2);
		expect(corpus.truncated).toBe(true);
		// The hash still records what the SOURCE held, before the cut.
		expect(
			corpus.hashes.find((entry) => entry.source === 'curated-failure')
				?.observations,
		).toBe(5);
	});
});

describe('curated failures — the arm reaches failureSupport', () => {
	test('a retro failure becomes counterexample evidence on a real attribute', async () => {
		// The whole point of the arm: a curated failure must be able to CONTEST a
		// finding, not merely be recorded. Two tasks succeed on a signal and both
		// also report the same retro error code, so the error attribute clears the
		// task-diversity gate and must ship counterexamples.
		const readers: Partial<CorpusReaders> = {
			listEvidenceTaskIds: async () => ['retro-1', 'retro-2'],
			loadEvidence: async (_directory: string, taskId: string) =>
				({
					status: 'found',
					bundle: {
						entries: [
							{
								type: 'retrospective',
								verdict: 'pass',
								error_taxonomy: ['gate_evasion'],
								top_rejection_reasons: [],
								taskId,
							},
						],
					},
				}) as never,
		};
		const result = await mineConsensus(DIRECTORY, request(), {
			config: config(),
			loadCorpus: (directory, options) =>
				loadConsensusCorpus(directory, {
					...options,
					readers: { ...emptyReaders(), ...readers },
				}),
			now: () => new Date('2026-07-24T00:00:00.000Z'),
		});
		const attribute = result.report.attributes.find((entry) =>
			entry.counterexampleRefs.some((ref) =>
				ref.startsWith('curated-failure:retro-error:'),
			),
		);
		expect(attribute).toBeDefined();
		expect(attribute?.failureSupport).toBe(2);
		expect(attribute?.successSupport).toBe(0);
		expect(attribute?.taskDiversity).toBe(2);
		expect(attribute?.counterexampleRefs).toEqual([
			'curated-failure:retro-error:retro-1:0:0',
			'curated-failure:retro-error:retro-2:0:0',
		]);
	});
});
