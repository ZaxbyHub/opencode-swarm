/**
 * Deterministic gating behaviour of the consensus miner (issue #1821, Lane C).
 *
 * Every test here runs with NO dispatcher, so the assertions cover pure
 * arithmetic: support counting, threshold enforcement, diversity gating, and
 * negative-evidence retention. LLM behaviour is covered separately in
 * `miner-summarization.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { MAX_CONSENSUS_REFS } from '../../../src/consensus/contracts';
import { mineConsensus } from '../../../src/consensus/miner';
import {
	config,
	corpusOf,
	fixedCorpusLoader,
	observation,
	request,
	twoRunAgreement,
} from './fixtures';

const DIRECTORY = '/virtual/project';

function mine(observations: ReturnType<typeof observation>[], overrides = {}) {
	return mineConsensus(DIRECTORY, request(overrides), {
		config: config(),
		loadCorpus: fixedCorpusLoader(corpusOf(observations)),
		now: () => new Date('2026-07-24T00:00:00.000Z'),
	});
}

describe('consensus miner — support counting', () => {
	test('support counts DISTINCT RUNS, not observations', async () => {
		// One chatty run emitting the same signal five times must contribute
		// exactly one to support; otherwise a single verbose trajectory could
		// manufacture consensus by itself.
		const chatty = Array.from({ length: 5 }, (_, index) =>
			observation({
				runId: 'task:t1',
				taskId: 't1',
				signals: ['orchestration:task-action:edit:success'],
				evidenceRef: `task-trajectory:t1:${index}`,
			}),
		);
		const result = await mine(chatty);
		const attribute = result.report.attributes[0];
		expect(attribute).toBeDefined();
		expect(attribute?.support).toBe(1);
		expect(attribute?.evidenceRefs).toHaveLength(5);
	});

	test('successSupport and failureSupport are both distinct-run counts', async () => {
		const result = await mine([
			observation({
				runId: 'task:t1',
				taskId: 't1',
				signals: ['orchestration:task-action:test:success'],
				evidenceRef: 'a',
			}),
			observation({
				runId: 'task:t1',
				taskId: 't1',
				success: false,
				signals: ['orchestration:task-action:test:success'],
				evidenceRef: 'b',
			}),
			observation({
				runId: 'task:t2',
				taskId: 't2',
				success: false,
				signals: ['orchestration:task-action:test:success'],
				evidenceRef: 'c',
			}),
		]);
		const attribute = result.report.attributes[0];
		// t1 appears in both success and failure; support stays 2 distinct runs.
		expect(attribute?.support).toBe(2);
		expect(attribute?.successSupport).toBe(1);
		expect(attribute?.failureSupport).toBe(2);
	});
});

describe('consensus miner — threshold enforcement', () => {
	test('drops an attribute below minSupport', async () => {
		const result = await mine(twoRunAgreement(), { minSupport: 3 });
		expect(result.report.attributes).toHaveLength(0);
		expect(result.report.proposals).toHaveLength(0);
	});

	test('emits an attribute at exactly minSupport', async () => {
		const result = await mine(twoRunAgreement(), { minSupport: 2 });
		expect(result.report.attributes).toHaveLength(1);
	});

	test('drops an attribute below minSuccessfulRuns', async () => {
		const failing = twoRunAgreement().map((entry) => ({
			...entry,
			success: false,
		}));
		const result = await mine(failing, {
			minSupport: 2,
			minSuccessfulRuns: 1,
		});
		expect(result.report.attributes).toHaveLength(0);
	});

	test('minSuccessfulRuns of 0 admits an all-failing attribute', async () => {
		const failing = twoRunAgreement().map((entry) => ({
			...entry,
			success: false,
		}));
		const result = await mine(failing, {
			minSupport: 2,
			minSuccessfulRuns: 0,
		});
		expect(result.report.attributes).toHaveLength(1);
		expect(result.report.attributes[0]?.failureSupport).toBe(2);
	});
});

describe('consensus miner — task diversity is the anecdote gate', () => {
	test('taskDiversity below 2 yields an investigation note, never a proposal', async () => {
		// Three runs, one task: plenty of support, but a single anecdote.
		const sameTask = ['r1', 'r2', 'r3'].map((run) =>
			observation({
				runId: `evaluation-run:${run}`,
				taskId: 'only-task',
				taskCategory: 'refactor',
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:${run}:only-task:0`,
			}),
		);
		const result = await mine(sameTask, { minSupport: 2 });
		const attribute = result.report.attributes[0];
		expect(attribute?.support).toBe(3);
		expect(attribute?.taskDiversity).toBe(1);
		expect(attribute?.proposedTarget).toBe('none');
		expect(result.report.proposals).toHaveLength(0);
		expect(result.investigationNoteCount).toBe(1);
	});

	test('support from a single run is a note even when diverse tasks appear', async () => {
		// One run touching two tasks is still one trial, not consensus.
		const oneRun = ['t1', 't2'].map((task) =>
			observation({
				runId: 'evaluation-run:solo',
				taskId: task,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:solo:${task}:0`,
			}),
		);
		const result = await mine(oneRun, { minSupport: 1 });
		const attribute = result.report.attributes[0];
		expect(attribute?.support).toBe(1);
		expect(attribute?.taskDiversity).toBe(2);
		expect(attribute?.proposedTarget).toBe('none');
		expect(result.report.proposals).toHaveLength(0);
	});

	test('two runs across two tasks qualify as a proposal', async () => {
		const result = await mine(twoRunAgreement(), { minSupport: 2 });
		const attribute = result.report.attributes[0];
		expect(attribute?.taskDiversity).toBe(2);
		expect(attribute?.proposedTarget).toBe('tooling');
		expect(result.report.proposals).toHaveLength(1);
		expect(result.report.proposals[0]?.target).toBe('tooling');
		expect(result.report.proposals[0]?.fingerprint).toMatch(
			/^lrec_[a-f0-9]{16}$/,
		);
	});

	test('taskCategory substitutes for a missing taskId when measuring diversity', async () => {
		const result = await mine(
			[
				observation({
					runId: 'evaluation-run:r1',
					taskCategory: 'refactor',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'a',
				}),
				observation({
					runId: 'evaluation-run:r2',
					taskCategory: 'bugfix',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'b',
				}),
			],
			{ minSupport: 2 },
		);
		expect(result.report.attributes[0]?.taskDiversity).toBe(2);
		expect(result.report.attributes[0]?.proposedTarget).toBe('tooling');
	});
});

describe('consensus miner — modelDiversity never gates emission', () => {
	test('modelDiversity is 0 when no observation carries a model id, and the attribute still qualifies', async () => {
		// Trajectory-derived evidence has no model attribution at all. Zero here
		// means "not measurable from this corpus", NOT "measured as none", so it
		// must not suppress a proposal that clears every real gate.
		const noModels = ['t1', 't2'].map((task) =>
			observation({
				runId: `task:${task}`,
				taskId: task,
				signals: ['orchestration:task-action:edit:success'],
				evidenceRef: `task-trajectory:${task}:0`,
			}),
		);
		const result = await mine(noModels, { minSupport: 2 });
		const attribute = result.report.attributes[0];
		expect(attribute?.modelDiversity).toBe(0);
		expect(attribute?.taskDiversity).toBe(2);
		expect(attribute?.proposedTarget).toBe('orchestration');
		expect(result.report.proposals).toHaveLength(1);
	});

	test('modelDiversity counts distinct model ids when they are present', async () => {
		const result = await mine(twoRunAgreement(), { minSupport: 2 });
		expect(result.report.attributes[0]?.modelDiversity).toBe(2);
	});

	test('a single model across many runs does not reduce below one', async () => {
		const sameModel = ['t1', 't2', 't3'].map((task) =>
			observation({
				runId: `evaluation-run:${task}`,
				taskId: task,
				modelId: 'anthropic/model-a',
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:${task}:0`,
			}),
		);
		const result = await mine(sameModel, { minSupport: 3 });
		expect(result.report.attributes[0]?.modelDiversity).toBe(1);
		expect(result.report.attributes[0]?.proposedTarget).toBe('tooling');
	});
});

describe('consensus miner — negative evidence is never dropped', () => {
	test('counterexample refs survive alongside supporting evidence', async () => {
		const mixed = [
			...twoRunAgreement(),
			observation({
				runId: 'evaluation-run:r3',
				taskId: 't3',
				modelId: 'anthropic/model-a',
				success: false,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: 'evaluation-run:r3:t3:0',
			}),
		];
		const result = await mine(mixed, { minSupport: 2 });
		const attribute = result.report.attributes[0];
		expect(attribute?.support).toBe(3);
		expect(attribute?.successSupport).toBe(2);
		expect(attribute?.failureSupport).toBe(1);
		expect(attribute?.counterexampleRefs).toEqual(['evaluation-run:r3:t3:0']);
		// And the proposal carries them forward rather than presenting only the
		// supporting half of the evidence.
		expect(result.report.proposals[0]?.counterexampleRefs).toEqual([
			'evaluation-run:r3:t3:0',
		]);
	});

	// #1821 F2 — the tally's ref collections are `Set`s, like every sibling
	// field, so the positional `MAX_CONSENSUS_REFS` cap is reached only by
	// DISTINCT refs. As plain arrays they were truncate-then-dedupe: a run of
	// repeats consumed every slot and evicted the distinct refs behind it.
	test('a repeated evidence ref cannot evict a distinct one at the cap', async () => {
		const chatty = Array.from({ length: MAX_CONSENSUS_REFS }, () =>
			observation({
				runId: 'evaluation-run:r1',
				taskId: 't1',
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: 'evaluation-run:r1:t1:0',
			}),
		);
		const result = await mine(
			[
				...chatty,
				observation({
					runId: 'evaluation-run:r2',
					taskId: 't2',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'evaluation-run:r2:t2:0',
				}),
			],
			{ minSupport: 2 },
		);
		const attribute = result.report.attributes[0];
		expect(attribute?.support).toBe(2);
		expect(attribute?.evidenceRefs).toEqual([
			'evaluation-run:r1:t1:0',
			'evaluation-run:r2:t2:0',
		]);
	});

	test('repeats of one counterexample ref cannot stand in for a second failing run', async () => {
		// `contracts.ts` enforces "non-zero failureSupport ⇒ non-empty
		// counterexampleRefs" as the negative-evidence guarantee. With a positional
		// cap over a plain array, MAX_CONSENSUS_REFS copies of a SINGLE ref
		// satisfied that check while the second failing run's evidence — the
		// evidence a reader would actually need — was dropped.
		const chattyFailure = Array.from({ length: MAX_CONSENSUS_REFS }, () =>
			observation({
				runId: 'evaluation-run:r3',
				taskId: 't3',
				success: false,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: 'evaluation-run:r3:t3:0',
			}),
		);
		const result = await mine(
			[
				...twoRunAgreement(),
				...chattyFailure,
				observation({
					runId: 'evaluation-run:r4',
					taskId: 't4',
					success: false,
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'evaluation-run:r4:t4:0',
				}),
			],
			{ minSupport: 2 },
		);
		const attribute = result.report.attributes[0];
		expect(attribute?.failureSupport).toBe(2);
		expect(attribute?.counterexampleRefs).toEqual([
			'evaluation-run:r3:t3:0',
			'evaluation-run:r4:t4:0',
		]);
	});

	test('failing runs lower confidence rather than being ignored', async () => {
		const clean = await mine(twoRunAgreement(), { minSupport: 2 });
		const contested = await mine(
			[
				...twoRunAgreement(),
				observation({
					runId: 'evaluation-run:r3',
					taskId: 't3',
					success: false,
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'evaluation-run:r3:t3:0',
				}),
			],
			{ minSupport: 2 },
		);
		const cleanConfidence = clean.report.attributes[0]?.confidence ?? 0;
		const contestedConfidence = contested.report.attributes[0]?.confidence ?? 0;
		expect(contestedConfidence).toBeLessThan(cleanConfidence);
		expect(contestedConfidence).toBeGreaterThan(0);
	});
});

describe('consensus miner — filtering', () => {
	test('runIds accepts both the raw and the namespaced id', async () => {
		const raw = await mine(twoRunAgreement(), {
			minSupport: 1,
			runIds: ['r1'],
		});
		const namespaced = await mine(twoRunAgreement(), {
			minSupport: 1,
			runIds: ['evaluation-run:r1'],
		});
		expect(raw.report.inputIds).toEqual(['evaluation-run:r1']);
		expect(namespaced.report.inputIds).toEqual(['evaluation-run:r1']);
	});

	test('a modelIds filter excludes observations with no model attribution', async () => {
		// "No model recorded" is not evidence that the requested model was used,
		// so it must be excluded rather than passed through.
		const result = await mine(
			[
				observation({
					runId: 'evaluation-run:r1',
					taskId: 't1',
					modelId: 'anthropic/model-a',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'a',
				}),
				observation({
					runId: 'task:t2',
					taskId: 't2',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'b',
				}),
			],
			{ minSupport: 1, modelIds: ['anthropic/model-a'] },
		);
		expect(result.report.inputIds).toEqual(['evaluation-run:r1']);
		expect(result.report.attributes[0]?.support).toBe(1);
	});

	test('taskCategories narrows the corpus deterministically', async () => {
		const result = await mine(
			[
				observation({
					runId: 'evaluation-run:r1',
					taskId: 't1',
					taskCategory: 'refactor',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'a',
				}),
				observation({
					runId: 'evaluation-run:r2',
					taskId: 't2',
					taskCategory: 'bugfix',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'b',
				}),
			],
			{ minSupport: 1, taskCategories: ['bugfix'] },
		);
		expect(result.report.inputIds).toEqual(['evaluation-run:r2']);
	});
});

describe('consensus miner — proposal deduplication', () => {
	test('a fingerprint present in a prior report suppresses the proposal', async () => {
		const first = await mine(twoRunAgreement(), { minSupport: 2 });
		const fingerprint = first.report.proposals[0]?.fingerprint;
		expect(fingerprint).toBeDefined();

		const second = await mineConsensus(DIRECTORY, request({ minSupport: 2 }), {
			config: config(),
			loadCorpus: fixedCorpusLoader(corpusOf(twoRunAgreement())),
			now: () => new Date('2026-07-24T00:00:00.000Z'),
			priorFingerprints: [fingerprint as string],
		});
		expect(second.report.proposals).toHaveLength(0);
		expect(second.dedupedProposalCount).toBe(1);
		// The attribute itself is still emitted — dedup suppresses the proposal,
		// not the evidence.
		expect(second.report.attributes).toHaveLength(1);
	});
});
