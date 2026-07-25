/**
 * Per-source field mapping for the consensus corpus (issue #1821, Lane C).
 *
 * `corpus.test.ts` covers assembly — redaction, caps, degradation, namespacing —
 * but exercised none of the four per-source loaders directly. That left every
 * outcome mapping unpinned: inverting `success: cell.outcome === 'caught'`
 * (`corpus.ts`, gate audit) flipped every gate observation from pass to fail and
 * the whole suite still passed. Outcome polarity is the input to `successSupport`
 * / `failureSupport` / `confidence`, so an inversion silently reverses every
 * conclusion the miner draws.
 *
 * Each block below therefore asserts BOTH polarities of the mapping, not just
 * the happy one, plus the run-id namespace and evidence-ref format the miner's
 * support counting depends on.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
	CorpusObservation,
	CorpusReaders,
} from '../../../src/consensus/corpus';
import { loadConsensusCorpus } from '../../../src/consensus/corpus';
import type { EvaluationRunV1 } from '../../../src/evaluation/contracts';
import { loadEvidence } from '../../../src/evidence/manager';

const DIRECTORY = '/virtual/project';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-sources-')),
	);
	roots.push(root);
	return root;
}

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
	};
}

async function load(
	readers: Partial<CorpusReaders>,
): Promise<CorpusObservation[]> {
	const corpus = await loadConsensusCorpus(DIRECTORY, {
		maxEvidenceItems: 100,
		maxExcerptChars: 500,
		readers: { ...emptyReaders(), ...readers },
	});
	return corpus.observations;
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

describe('corpus source — evaluation runs', () => {
	// The loader reads runId, both candidate descriptors, and each result row.
	// A full `EvaluationRunV1` fixture would add ~60 lines of unread fields, so
	// the reader is injected with exactly the shape the loader consumes.
	function run(): EvaluationRunV1 {
		return {
			runId: 'r1',
			baseline: { id: 'base', model: 'anthropic/model-a', agent: 'coder' },
			candidate: { id: 'cand', model: 'anthropic/model-b', agent: 'reviewer' },
			results: [
				{
					taskId: 't1',
					category: 'refactor',
					candidateId: 'cand',
					seed: 'seed-1',
					outcome: 'scored',
				},
				{
					taskId: 't2',
					category: 'bugfix',
					candidateId: 'base',
					seed: 'seed-2',
					outcome: 'errored',
					failureCode: 'TIMEOUT',
				},
			],
		} as unknown as EvaluationRunV1;
	}

	const readers = {
		listEvaluationRunIds: async () => ['r1'],
		readEvaluationRun: async () => run(),
	};

	test("outcome 'scored' is the ONLY success — anything else is a failure", async () => {
		const observations = await load(readers);
		expect(byRef(observations, 'evaluation-run:r1:t1:0').success).toBe(true);
		expect(byRef(observations, 'evaluation-run:r1:t2:1').success).toBe(false);
	});

	test('attribution is resolved per result through its own candidateId', async () => {
		const observations = await load(readers);
		const scored = byRef(observations, 'evaluation-run:r1:t1:0');
		expect(scored.modelId).toBe('anthropic/model-b');
		expect(scored.agentRole).toBe('reviewer');
		expect(scored.taskCategory).toBe('refactor');
		expect(scored.seed).toBe('seed-1');
		// The baseline row must NOT inherit the candidate's model.
		expect(byRef(observations, 'evaluation-run:r1:t2:1').modelId).toBe(
			'anthropic/model-a',
		);
	});

	test('the run — not the task — is the support unit, and it is namespaced', async () => {
		const observations = await load(readers);
		expect(new Set(observations.map((entry) => entry.runId))).toEqual(
			new Set(['evaluation-run:r1']),
		);
	});

	test('a failure code becomes a second signal beside the outcome signal', async () => {
		const observations = await load(readers);
		expect(byRef(observations, 'evaluation-run:r1:t1:0').signals).toEqual([
			'tooling:evaluation-outcome:scored',
		]);
		expect(byRef(observations, 'evaluation-run:r1:t2:1').signals).toEqual([
			'tooling:evaluation-outcome:errored',
			'tooling:evaluation-failure:TIMEOUT',
		]);
	});

	test('a run id that resolves to nothing is skipped, not defaulted', async () => {
		expect(
			await load({
				listEvaluationRunIds: async () => ['missing'],
				readEvaluationRun: async () => undefined,
			}),
		).toEqual([]);
	});
});

describe('corpus source — gate audit', () => {
	const readers = {
		listGateAuditResults: async () => ({
			results: [
				{
					runId: 'ga1',
					cells: [
						{
							taskId: 't1',
							gate: 'review',
							model: 'anthropic/model-a',
							outcome: 'caught',
						},
						{
							taskId: 't2',
							gate: 'review',
							model: 'anthropic/model-a',
							outcome: 'missed',
							failureClassification: 'new_regression',
						},
					],
				},
			],
			corruptRunIds: [],
		}),
	} as unknown as Partial<CorpusReaders>;

	test("outcome 'caught' is success and 'missed' is failure — the polarity is not symmetric", async () => {
		// Inverting this comparison flips every gate observation, which flips
		// successSupport/failureSupport and therefore confidence, on evidence a
		// human would never re-derive by hand.
		const observations = await load(readers);
		expect(byRef(observations, 'gate-audit:ga1:t1:0').success).toBe(true);
		expect(byRef(observations, 'gate-audit:ga1:t2:1').success).toBe(false);
	});

	test('the gate is carried as the agent role and the model is retained', async () => {
		const caught = byRef(await load(readers), 'gate-audit:ga1:t1:0');
		expect(caught.agentRole).toBe('review');
		expect(caught.modelId).toBe('anthropic/model-a');
		expect(caught.runId).toBe('gate-audit:ga1');
		// Gate audit carries no task category or seed; absent, never defaulted.
		expect(caught.taskCategory).toBeUndefined();
		expect(caught.seed).toBeUndefined();
	});

	test('a failure classification becomes a second signal', async () => {
		const missed = byRef(await load(readers), 'gate-audit:ga1:t2:1');
		expect(missed.signals).toEqual([
			'tooling:gate:review:missed',
			'tooling:gate-failure:review:new_regression',
		]);
	});
});

describe('corpus source — gate ground truth', () => {
	const readers = {
		listGateAuditResults: async () => ({
			results: [{ runId: 'ga1', cells: [] }],
			corruptRunIds: [],
		}),
		readGateGroundTruth: async () => ({
			events: [
				{
					runId: 'ga1',
					taskId: 't1',
					gate: 'review',
					model: 'anthropic/model-a',
					source: 'integration',
					classification: 'clean',
				},
				{
					runId: 'ga1',
					taskId: 't2',
					gate: 'review',
					model: 'anthropic/model-a',
					source: 'test-impact',
					classification: 'new_regression',
				},
			],
			malformed: 0,
		}),
	} as unknown as Partial<CorpusReaders>;

	test("only 'clean' is success — every other classification is a failure", async () => {
		const observations = await load(readers);
		expect(byRef(observations, 'gate-ground-truth:ga1:t1:0').success).toBe(
			true,
		);
		expect(byRef(observations, 'gate-ground-truth:ga1:t2:1').success).toBe(
			false,
		);
	});

	test('ground truth shares the gate-audit run identity so it cannot double support', async () => {
		// Two views of one audit run must count as one trial.
		const observations = await load(readers);
		expect(new Set(observations.map((entry) => entry.runId))).toEqual(
			new Set(['gate-audit:ga1']),
		);
	});

	test('the signal carries gate, source, and classification', async () => {
		expect(
			byRef(await load(readers), 'gate-ground-truth:ga1:t2:1').signals,
		).toEqual(['tooling:gate-truth:review:test-impact:new_regression']);
	});
});

describe('corpus source — PRM sessions', () => {
	const readers = {
		listTrajectorySessions: async () => ['ses-a'],
		readTrajectory: async () => [
			{
				step: 1,
				agent: 'coder',
				action: 'edit',
				target: 'task-7',
				intent: 'fix',
				timestamp: '2026-07-24T00:00:00.000Z',
				result: 'success' as const,
			},
			{
				step: 2,
				agent: 'reviewer',
				action: 'review',
				target: '',
				intent: 'check',
				timestamp: '2026-07-24T00:00:01.000Z',
				result: 'failure' as const,
			},
		],
	};

	test("result 'success' is the ONLY success — 'failure' and 'pending' are not", async () => {
		const observations = await load(readers);
		expect(byRef(observations, 'prm-session:ses-a:0').success).toBe(true);
		expect(byRef(observations, 'prm-session:ses-a:1').success).toBe(false);
	});

	test('an empty target yields NO task attribution rather than an empty-string task', async () => {
		// An empty-string task id would be counted as a distinct task identity and
		// would inflate taskDiversity past the anecdote gate.
		const observations = await load(readers);
		expect(byRef(observations, 'prm-session:ses-a:0').taskId).toBe('task-7');
		expect(byRef(observations, 'prm-session:ses-a:1').taskId).toBeUndefined();
	});

	test('the session is the support unit and the agent is retained', async () => {
		const observations = await load(readers);
		expect(new Set(observations.map((entry) => entry.runId))).toEqual(
			new Set(['prm-session:ses-a']),
		);
		expect(byRef(observations, 'prm-session:ses-a:0').agentRole).toBe('coder');
		expect(byRef(observations, 'prm-session:ses-a:0').signals).toEqual([
			'orchestration:session-action:edit:success',
		]);
	});
});
