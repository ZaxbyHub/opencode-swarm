/**
 * LLM summarization behaviour of the consensus miner (issue #1821, Lane C).
 *
 * The load-bearing property under test is ORDER: every deterministic figure —
 * support, diversity, confidence, target, and above all the proposal
 * fingerprint — must already be final before a model is consulted, and the
 * model may only replace `statement`. If summarization ran earlier, a model
 * rewording the same conclusion would mint a new fingerprint on every run and
 * silently defeat deduplication.
 */

import { describe, expect, test } from 'bun:test';
import { mineConsensus } from '../../../src/consensus/miner';
import type { EvaluationModelDispatcher } from '../../../src/evaluation/model-dispatcher';
import { computeRecommendationFingerprint } from '../../../src/learning/fingerprint';
import {
	config,
	corpusOf,
	fixedCorpusLoader,
	recordingDispatcher,
	request,
	twoRunAgreement,
} from './fixtures';

const DIRECTORY = '/virtual/project';
const AT = () => new Date('2026-07-24T00:00:00.000Z');

function mine(deps: Record<string, unknown> = {}) {
	return mineConsensus(DIRECTORY, request({ minSupport: 2 }), {
		config: config(),
		loadCorpus: fixedCorpusLoader(corpusOf(twoRunAgreement())),
		now: AT,
		...deps,
	});
}

describe('consensus miner — graceful degradation without a dispatcher', () => {
	test('keeps the deterministic statement and reports why', async () => {
		const result = await mine();
		expect(result.summarizationSkippedReason).toBe('no_dispatcher');
		expect(result.summarizedCount).toBe(0);
		// The deterministic statement is the rendered arithmetic, not a model's
		// prose — assert on its structure rather than on truthiness.
		expect(result.report.attributes[0]?.statement).toContain(
			'recurs across 2 independent run(s)',
		);
		expect(result.report.attributes[0]?.statement).toContain(
			'2 distinct tasks',
		);
	});

	test('proposals are still produced without any model', async () => {
		const result = await mine();
		expect(result.report.proposals).toHaveLength(1);
		expect(result.report.proposals[0]?.expectedMetric).toBe(
			'evaluation.scored_outcome_rate',
		);
	});

	test('disabled summarization is distinguishable from an absent dispatcher', async () => {
		const { dispatcher, calls } = recordingDispatcher();
		const result = await mine({
			config: config({ llm_summarization_enabled: false }),
			dispatcher,
		});
		expect(result.summarizationSkippedReason).toBe('disabled_by_config');
		expect(calls).toHaveLength(0);
	});

	test('an empty attribute set skips summarization without dispatching', async () => {
		const { dispatcher, calls } = recordingDispatcher();
		const result = await mine({ dispatcher, config: config() });
		expect(result.report.attributes.length).toBeGreaterThan(0);
		const empty = await mineConsensus(DIRECTORY, request({ minSupport: 99 }), {
			config: config(),
			loadCorpus: fixedCorpusLoader(corpusOf(twoRunAgreement())),
			now: AT,
			dispatcher,
		});
		expect(empty.summarizationSkippedReason).toBe('no_attributes');
		// Only the first (successful) mine dispatched.
		expect(calls).toHaveLength(1);
	});
});

describe('consensus miner — summarization replaces only the statement', () => {
	test('a completed dispatch restates the statement and nothing else', async () => {
		const baseline = await mine();
		const { dispatcher } = recordingDispatcher({
			text: 'Scoring succeeds consistently across both refactor tasks.',
		});
		const summarized = await mine({ dispatcher });

		expect(summarized.summarizedCount).toBe(1);
		expect(summarized.report.attributes[0]?.statement).toBe(
			'Scoring succeeds consistently across both refactor tasks.',
		);
		expect(summarized.report.attributes[0]?.statement).not.toBe(
			baseline.report.attributes[0]?.statement,
		);

		// Every deterministic field is byte-identical to the un-summarized run.
		const baseAttribute = baseline.report.attributes[0];
		const summarizedAttribute = summarized.report.attributes[0];
		expect(summarizedAttribute?.id).toBe(baseAttribute?.id as string);
		expect(summarizedAttribute?.support).toBe(baseAttribute?.support as number);
		expect(summarizedAttribute?.successSupport).toBe(
			baseAttribute?.successSupport as number,
		);
		expect(summarizedAttribute?.failureSupport).toBe(
			baseAttribute?.failureSupport as number,
		);
		expect(summarizedAttribute?.taskDiversity).toBe(
			baseAttribute?.taskDiversity as number,
		);
		expect(summarizedAttribute?.modelDiversity).toBe(
			baseAttribute?.modelDiversity as number,
		);
		expect(summarizedAttribute?.confidence).toBe(
			baseAttribute?.confidence as number,
		);
		expect(summarizedAttribute?.proposedTarget).toBe(
			baseAttribute?.proposedTarget as string,
		);
	});

	test('the proposal fingerprint derives from the DETERMINISTIC statement', async () => {
		// This is the ordering guarantee. If summarization ran before proposal
		// construction, this fingerprint would be computed over the model's
		// wording and would change every time the model reworded the finding.
		const baseline = await mine();
		const deterministicStatement = baseline.report.attributes[0]
			?.statement as string;
		const { dispatcher } = recordingDispatcher({
			text: 'A completely different wording of the same finding.',
		});
		const summarized = await mine({ dispatcher });

		const expected = computeRecommendationFingerprint({
			kind: 'miner',
			target: 'tooling',
			statement: deterministicStatement,
			scopeKeys: ['refactor'],
		});
		expect(summarized.report.proposals[0]?.fingerprint).toBe(expected);
		expect(summarized.report.proposals[0]?.fingerprint).toBe(
			baseline.report.proposals[0]?.fingerprint as string,
		);
	});

	test('the dispatch receives the configured timeout and a read-only agent', async () => {
		const { dispatcher, calls } = recordingDispatcher();
		await mine({ dispatcher, config: config({ llm_timeout_ms: 1234 }) });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.timeoutMs).toBe(1234);
		expect(calls[0]?.agentName).toBe('curator_postmortem');
	});
});

describe('consensus miner — dispatcher failures never fail the run', () => {
	test('a thrown dispatcher leaves the deterministic statement intact', async () => {
		const throwing: EvaluationModelDispatcher = async () => {
			throw new Error('provider exploded');
		};
		const baseline = await mine();
		const result = await mine({ dispatcher: throwing });
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.statement).toBe(
			baseline.report.attributes[0]?.statement as string,
		);
		expect(result.report.proposals).toHaveLength(1);
	});

	test('a timeout status leaves the deterministic statement intact', async () => {
		const { dispatcher } = recordingDispatcher({
			status: 'timeout',
			text: 'partial output that must not be used',
		});
		const baseline = await mine();
		const result = await mine({ dispatcher });
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.statement).toBe(
			baseline.report.attributes[0]?.statement as string,
		);
	});

	test('an empty completed response leaves the deterministic statement intact', async () => {
		const { dispatcher } = recordingDispatcher({ text: '   \n  ' });
		const baseline = await mine();
		const result = await mine({ dispatcher });
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.statement).toBe(
			baseline.report.attributes[0]?.statement as string,
		);
	});

	test('a secret in the model response is redacted before it is retained', async () => {
		const { dispatcher } = recordingDispatcher({
			text: 'Use the key AKIAIOSFODNN7EXAMPLE to reproduce.',
		});
		const result = await mine({ dispatcher });
		const statement = result.report.attributes[0]?.statement as string;
		expect(statement).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(statement).toContain('[REDACTED:aws_access_key_id]');
	});
});
