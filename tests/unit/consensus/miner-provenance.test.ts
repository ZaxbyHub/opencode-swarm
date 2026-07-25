/**
 * Proposal provenance, producer-side bounds, and the truncation record.
 *
 * Three separate ways a report could previously mislead its reader:
 *
 * - **Provenance was corpus-wide, not attribute-scoped** (#1821 AC23). Run,
 *   model, task, and category lists were computed once over every filtered
 *   observation and stamped identically onto every proposal, so each proposal
 *   claimed provenance it did not have and no two proposals in a report were
 *   distinguishable.
 * - **The array caps lived only in the schema.** With no producer-side bound, a
 *   large `max_evidence_items` (the tool allows 10 000) made the final
 *   `ConsensusReportV1Schema.parse` throw, so NO report was written at all — the
 *   caller lost every finding rather than the weakest tail.
 * - **Truncation was invisible.** `inputIds` was silently cut, and the corpus cap
 *   was returned to the caller but never persisted, so a stored report could not
 *   be distinguished from a complete one.
 */

import { describe, expect, test } from 'bun:test';
import { MAX_CONSENSUS_ATTRIBUTES } from '../../../src/consensus/contracts';
import { mineConsensus } from '../../../src/consensus/miner';
import {
	config,
	corpusOf,
	fixedCorpusLoader,
	observation,
	request,
} from './fixtures';

const DIRECTORY = '/virtual/project';
const AT = () => new Date('2026-07-24T00:00:00.000Z');

function mine(
	observations: ReturnType<typeof observation>[],
	overrides: Record<string, unknown> = {},
	corpusOverrides: Record<string, unknown> = {},
) {
	return mineConsensus(DIRECTORY, request(overrides), {
		config: config(),
		loadCorpus: fixedCorpusLoader(corpusOf(observations, corpusOverrides)),
		now: AT,
	});
}

/**
 * Two independent findings drawn from DISJOINT observation sets: one tooling
 * signal over `refactor` tasks on model A, one skill signal over `bugfix` tasks
 * on model B. Nothing overlaps, so corpus-wide provenance is trivially
 * distinguishable from attribute-scoped provenance.
 */
function twoDisjointFindings() {
	return [
		...['r1', 'r2'].map((run, index) =>
			observation({
				runId: `evaluation-run:${run}`,
				taskId: `t${index + 1}`,
				taskCategory: 'refactor',
				modelId: 'anthropic/model-a',
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:${run}:t${index + 1}:0`,
			}),
		),
		...['s1', 's2'].map((session, index) =>
			observation({
				runId: `skill-usage:${session}`,
				taskId: `t${index + 3}`,
				taskCategory: 'bugfix',
				modelId: 'anthropic/model-b',
				signals: ['skill:usage:writing-tests:compliant'],
				evidenceRef: `skill-usage:${session}:${index}`,
			}),
		),
	];
}

describe('proposal provenance is scoped to its own attribute (AC23)', () => {
	async function proposals() {
		const result = await mine(twoDisjointFindings(), { minSupport: 2 });
		expect(result.report.proposals).toHaveLength(2);
		const tooling = result.report.proposals.find((p) => p.target === 'tooling');
		const skill = result.report.proposals.find((p) => p.target === 'skill');
		if (!tooling || !skill) throw new Error('expected one proposal per target');
		return { tooling, skill, report: result.report };
	}

	test('sourceRunIds name only the runs that carried the signal', async () => {
		const { tooling, skill } = await proposals();
		expect(tooling.provenance.sourceRunIds).toEqual([
			'evaluation-run:r1',
			'evaluation-run:r2',
		]);
		expect(skill.provenance.sourceRunIds).toEqual([
			'skill-usage:s1',
			'skill-usage:s2',
		]);
	});

	test('sourceModelIds and sourceTaskIds are likewise scoped', async () => {
		const { tooling, skill } = await proposals();
		expect(tooling.provenance.sourceModelIds).toEqual(['anthropic/model-a']);
		expect(skill.provenance.sourceModelIds).toEqual(['anthropic/model-b']);
		expect(tooling.provenance.sourceTaskIds).toEqual(['t1', 't2']);
		expect(skill.provenance.sourceTaskIds).toEqual(['t3', 't4']);
	});

	test('two proposals in one report never carry identical provenance', async () => {
		// The regression in one assertion: corpus-wide stamping made these equal.
		const { tooling, skill } = await proposals();
		expect(tooling.provenance).not.toEqual(skill.provenance);
	});

	test('validationSelector names the slice that actually produced the finding', async () => {
		const { tooling, skill } = await proposals();
		expect(tooling.validationSelector).toBe('taskCategories=refactor');
		expect(skill.validationSelector).toBe('taskCategories=bugfix');
	});

	test('a proposal-eligible attribute yields at most one proposal, never more', async () => {
		const result = await mine(twoDisjointFindings(), { minSupport: 2 });
		const perAttribute = new Map<string, number>();
		for (const proposal of result.report.proposals) {
			perAttribute.set(
				proposal.sourceAttributeId,
				(perAttribute.get(proposal.sourceAttributeId) ?? 0) + 1,
			);
		}
		expect([...perAttribute.values()].every((count) => count === 1)).toBe(true);
	});

	test('the selector falls back to task ids, then run ids, never to a constant', async () => {
		const noCategories = ['t1', 't2'].map((task) =>
			observation({
				runId: `task:${task}`,
				taskId: task,
				signals: ['orchestration:task-action:edit:success'],
				evidenceRef: `task-trajectory:${task}:0`,
			}),
		);
		const byTask = await mine(noCategories, { minSupport: 2 });
		expect(byTask.report.proposals[0]?.validationSelector).toBe(
			'taskIds=t1,t2',
		);
	});

	test('a selector too long for the bound drops whole ids and says how many', async () => {
		// Truncating mid-identifier would name a slice that does not exist, so the
		// renderer drops entire entries and declares the omission instead.
		const wide = Array.from({ length: 60 }, (_, index) =>
			observation({
				runId: `evaluation-run:r${index}`,
				taskId: `t${index}`,
				taskCategory: `category-${String(index).padStart(2, '0')}-${'x'.repeat(20)}`,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:r${index}:t${index}:0`,
			}),
		);
		const result = await mine(wide, { minSupport: 2 });
		const selector = result.report.proposals[0]?.validationSelector as string;
		expect(selector.length).toBeLessThanOrEqual(1024);
		expect(selector).toContain(';omitted=');
		// Every retained entry is a whole category, never a fragment.
		const listed = selector.slice('taskCategories='.length).split(';')[0] ?? '';
		for (const entry of listed.split(',')) {
			expect(entry).toMatch(/^category-\d{2}-x{20}$/);
		}
	});

	test('an identifier longer than the per-entry bound is dropped, not clipped', async () => {
		// Clipping one huge id would produce exactly the mid-identifier fragment
		// the renderer exists to avoid, so it is omitted whole.
		const huge = `t-${'y'.repeat(400)}`;
		const observations = [
			observation({
				runId: 'evaluation-run:r1',
				taskId: huge,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: 'evaluation-run:r1:a:0',
			}),
			observation({
				runId: 'evaluation-run:r2',
				taskId: 't-short',
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: 'evaluation-run:r2:b:0',
			}),
		];
		const result = await mine(observations, { minSupport: 2 });
		const selector = result.report.proposals[0]?.validationSelector as string;
		expect(selector).toBe('taskIds=t-short;omitted=1');
		expect(selector).not.toContain('yyy');
	});

	test('a key that can name nothing falls through instead of emitting an empty slice', async () => {
		// Every task id over the per-entry bound would render `taskIds=;omitted=2`
		// — syntactically valid, and designating the empty set. The renderer must
		// fall through to a key that can actually name the slice.
		const observations = ['r1', 'r2'].map((run, index) =>
			observation({
				runId: `evaluation-run:${run}`,
				taskId: `t-${'y'.repeat(400)}-${index}`,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:${run}:${index}:0`,
			}),
		);
		const result = await mine(observations, { minSupport: 2 });
		const selector = result.report.proposals[0]?.validationSelector as string;
		expect(selector).toBe('runIds=evaluation-run:r1,evaluation-run:r2');
	});

	test('the last-resort selector names the attribute itself, never an empty set', async () => {
		// Contrived but reachable: every identifier class over the per-entry bound.
		const huge = (prefix: string) => `${prefix}-${'z'.repeat(400)}`;
		const observations = [0, 1].map((index) =>
			observation({
				runId: huge(`run${index}`),
				taskId: huge(`task${index}`),
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evidence:${index}`,
			}),
		);
		const result = await mine(observations, { minSupport: 2 });
		const proposal = result.report.proposals[0];
		expect(proposal?.validationSelector).toBe(
			`attributeId=${proposal?.sourceAttributeId}`,
		);
		expect(proposal?.validationSelector.length).toBeGreaterThan(0);
	});
});

describe('proposals carry an auditable back-reference to their attribute', () => {
	test('every proposal names an attribute present in the same report', async () => {
		const result = await mine(twoDisjointFindings(), { minSupport: 2 });
		const attributeIds = new Set(
			result.report.attributes.map((attribute) => attribute.id),
		);
		expect(result.report.proposals.length).toBeGreaterThan(0);
		for (const proposal of result.report.proposals) {
			expect(attributeIds.has(proposal.sourceAttributeId)).toBe(true);
		}
	});

	test('the back-reference points at the attribute whose numbers it inherited', async () => {
		const result = await mine(twoDisjointFindings(), { minSupport: 2 });
		for (const proposal of result.report.proposals) {
			const source = result.report.attributes.find(
				(attribute) => attribute.id === proposal.sourceAttributeId,
			);
			expect(source?.proposedTarget).toBe(proposal.target);
			expect(source?.confidence).toBe(proposal.confidence);
			expect(source?.evidenceRefs).toEqual(proposal.evidenceRefs);
			expect(source?.counterexampleRefs).toEqual(proposal.counterexampleRefs);
		}
	});

	test('an investigation note never appears as any proposal source', async () => {
		const mixed = [
			...twoDisjointFindings(),
			// One task, one run: an anecdote, forced to `proposedTarget: 'none'`.
			observation({
				runId: 'evaluation-run:solo',
				taskId: 'only',
				signals: ['prompt:evidence:note:pass'],
				evidenceRef: 'evidence-bundle:only:0',
			}),
		];
		const result = await mine(mixed, { minSupport: 1 });
		const noteIds = new Set(
			result.report.attributes
				.filter((attribute) => attribute.proposedTarget === 'none')
				.map((attribute) => attribute.id),
		);
		expect(noteIds.size).toBeGreaterThan(0);
		for (const proposal of result.report.proposals) {
			expect(noteIds.has(proposal.sourceAttributeId)).toBe(false);
		}
	});
});

describe('producer-side caps degrade the report instead of destroying it', () => {
	/** One distinct signal, run, and task per observation. */
	function manySignals(count: number) {
		return Array.from({ length: count }, (_, index) =>
			observation({
				runId: `evaluation-run:r${String(index).padStart(5, '0')}`,
				taskId: `t${index}`,
				signals: [`tooling:evaluation-outcome:code-${index}`],
				evidenceRef: `evaluation-run:r${String(index).padStart(5, '0')}:t${index}:0`,
			}),
		);
	}

	test('a corpus over the attribute cap still yields a report', async () => {
		// Before the producer cap existed this path threw inside
		// `ConsensusReportV1Schema.parse` and no report was written at all.
		const result = await mine(manySignals(MAX_CONSENSUS_ATTRIBUTES + 1), {
			minSupport: 1,
		});
		expect(result.report.attributes).toHaveLength(MAX_CONSENSUS_ATTRIBUTES);
		expect(result.report.truncation.attributesDropped).toBe(1);
	});

	test('the cap is a total, deterministic order — two runs drop the same one', async () => {
		const observations = manySignals(MAX_CONSENSUS_ATTRIBUTES + 5);
		const first = await mine(observations, { minSupport: 1 });
		const second = await mine(observations, { minSupport: 1 });
		expect(second.report.attributes.map((a) => a.id)).toEqual(
			first.report.attributes.map((a) => a.id),
		);
		expect(first.report.truncation.attributesDropped).toBe(5);
	});

	test('proposals are transitively bounded by the attribute cap', async () => {
		// Why there is no separate `proposalsDropped`: at most one proposal per
		// attribute, and dedup only removes.
		const result = await mine(manySignals(MAX_CONSENSUS_ATTRIBUTES + 1), {
			minSupport: 1,
		});
		expect(result.report.proposals.length).toBeLessThanOrEqual(
			result.report.attributes.length,
		);
	});

	test('an under-cap corpus reports nothing dropped', async () => {
		const result = await mine(twoDisjointFindings(), { minSupport: 2 });
		expect(result.report.truncation.attributesDropped).toBe(0);
	});
});

describe('the report declares every cut it made', () => {
	test('an inputIds cut is visible, with the pre-cut total', async () => {
		const many = Array.from({ length: 250 }, (_, index) =>
			observation({
				runId: `evaluation-run:r${String(index).padStart(4, '0')}`,
				taskId: `t${index}`,
				signals: ['tooling:evaluation-outcome:scored'],
				evidenceRef: `evaluation-run:r${String(index).padStart(4, '0')}:t${index}:0`,
			}),
		);
		const result = await mine(many, { minSupport: 1 });
		expect(result.report.inputIds).toHaveLength(200);
		expect(result.report.truncation.inputIds).toBe(true);
		expect(result.report.truncation.totalInputIds).toBe(250);
		expect(result.report.truncation.observations).toBe(250);
	});

	test('a corpus cut is persisted on the report, not only returned', async () => {
		// `result.truncated` is ephemeral; a stored report must be able to say so
		// on its own, or `failureSupport: 0` cannot be interpreted.
		const result = await mine(
			twoDisjointFindings(),
			{ minSupport: 2 },
			{ truncated: true },
		);
		expect(result.truncated).toBe(true);
		expect(result.report.truncation.corpus).toBe(true);
	});

	test('an untruncated report says so on every axis', async () => {
		const result = await mine(twoDisjointFindings(), { minSupport: 2 });
		expect(result.report.truncation).toEqual({
			corpus: false,
			observations: 4,
			inputIds: false,
			totalInputIds: 4,
			attributesDropped: 0,
		});
	});

	test('the truncation record is covered by the integrity hash', async () => {
		// It is content: a report that dropped evidence is not the same artifact as
		// one that did not, even with identical attributes.
		const clean = await mine(twoDisjointFindings(), { minSupport: 2 });
		const cut = await mine(
			twoDisjointFindings(),
			{ minSupport: 2 },
			{ truncated: true },
		);
		expect(cut.report.integrityHash).not.toBe(clean.report.integrityHash);
		expect(cut.report.reportId).not.toBe(clean.report.reportId);
	});
});
