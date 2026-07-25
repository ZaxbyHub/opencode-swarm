/**
 * Shared builders for the consensus-miner unit tests.
 *
 * Not a test file (no `.test.ts` suffix, so Bun does not collect it). Everything
 * here is a plain value builder: the tests inject these through the miner's and
 * corpus's dependency seams rather than reaching for `mock.module`, which leaks
 * across files in Bun's shared test-runner process (AGENTS.md invariant 7).
 */

import {
	type ConsensusConfig,
	ConsensusConfigSchema,
} from '../../../src/config/schema';
import type { ConsensusMineRequest } from '../../../src/consensus/contracts';
import type {
	ConsensusCorpus,
	CorpusObservation,
} from '../../../src/consensus/corpus';
import type {
	EvaluationModelDispatcher,
	EvaluationModelDispatchResult,
} from '../../../src/evaluation/model-dispatcher';

/** One observation with sensible defaults; override only what a test asserts. */
export function observation(
	overrides: Partial<CorpusObservation> &
		Pick<CorpusObservation, 'runId' | 'signals' | 'evidenceRef'>,
): CorpusObservation {
	return { success: true, ...overrides };
}

/** Wrap observations in the corpus envelope the miner consumes. */
export function corpusOf(
	observations: CorpusObservation[],
	overrides: Partial<Omit<ConsensusCorpus, 'observations'>> = {},
): ConsensusCorpus {
	return {
		observations,
		hashes: [],
		truncated: false,
		unreadableSources: [],
		...overrides,
	};
}

/** A fully-defaulted consensus config with optional overrides. */
export function config(
	overrides: Partial<ConsensusConfig> = {},
): ConsensusConfig {
	return ConsensusConfigSchema.parse({ ...overrides });
}

/** A request with permissive thresholds unless a test tightens them. */
export function request(
	overrides: Partial<ConsensusMineRequest> = {},
): ConsensusMineRequest {
	return {
		minSupport: 1,
		minSuccessfulRuns: 0,
		maxEvidenceItems: 100,
		...overrides,
	};
}

/** A corpus loader that always returns the supplied corpus. */
export function fixedCorpusLoader(corpus: ConsensusCorpus) {
	return async () => corpus;
}

/**
 * A well-formed restatement, in the envelope the miner's guard requires.
 *
 * The miner accepts model output ONLY through a single-sentence `FINDING:` line
 * (issue #1821 AC18), so a fixture that returns bare prose is testing rejection,
 * not summarization. Tests that want a successful restatement must go through
 * this shape.
 */
export function finding(sentence: string): string {
	return `FINDING: ${sentence}`;
}

/** A dispatcher returning a fixed result; records every request it received. */
export function recordingDispatcher(
	result: Partial<EvaluationModelDispatchResult> = {},
): {
	dispatcher: EvaluationModelDispatcher;
	calls: Array<{ prompt: string; timeoutMs: number; agentName: string }>;
} {
	const calls: Array<{
		prompt: string;
		timeoutMs: number;
		agentName: string;
	}> = [];
	const dispatcher: EvaluationModelDispatcher = async (input) => {
		calls.push({
			prompt: input.prompt,
			timeoutMs: input.timeoutMs,
			agentName: input.agentName,
		});
		return {
			status: 'completed',
			modelId: input.modelId,
			text: finding('Restated finding.'),
			durationMs: 1,
			...result,
		};
	};
	return { dispatcher, calls };
}

/**
 * Two runs agreeing on one signal across two distinct tasks — the minimal
 * corpus that clears both the support and task-diversity gates.
 */
export function twoRunAgreement(signal = 'tooling:evaluation-outcome:scored') {
	return [
		observation({
			runId: 'evaluation-run:r1',
			taskId: 't1',
			taskCategory: 'refactor',
			modelId: 'anthropic/model-a',
			signals: [signal],
			evidenceRef: 'evaluation-run:r1:t1:0',
		}),
		observation({
			runId: 'evaluation-run:r2',
			taskId: 't2',
			taskCategory: 'refactor',
			modelId: 'anthropic/model-b',
			signals: [signal],
			evidenceRef: 'evaluation-run:r2:t2:0',
		}),
	];
}
