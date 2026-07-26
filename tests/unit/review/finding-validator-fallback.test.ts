import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	ReviewDispatchRequest,
	ReviewDispatchResult,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import {
	canonicalizeValidationCandidates,
	MAX_VALIDATOR_FALLBACK_MODELS,
	runFindingValidation,
} from '../../../src/review/finding-validator';

const FINDING = {
	title: 'State is lost',
	body: 'The assignment overwrites the only retained state.',
	severity: 'high' as const,
	confidence: 0.94,
	file: 'src/state.ts',
	line_start: 10,
	line_end: 11,
};

const PRIMARY = { providerID: 'openai', modelID: 'primary' };
const FALLBACK_ONE = { providerID: 'opencode', modelID: 'gpt-5-nano' };
const FALLBACK_TWO = { providerID: 'anthropic', modelID: 'fallback-two' };
const FALLBACK_THREE = { providerID: 'google', modelID: 'fallback-three' };
const FALLBACK_FOUR = { providerID: 'xai', modelID: 'must-not-run' };

function completedValidation(
	request: ReviewDispatchRequest,
	costUsd = 0.2,
): ReviewDispatchResult {
	const candidates = canonicalizeValidationCandidates([FINDING]);
	const text = JSON.stringify({
		validations: candidates.map((candidate) => ({
			finding_id: candidate.finding_id,
			disposition: 'DISPROVED',
			confidence: 0.98,
			evidence: 'The retained state remains reachable.',
		})),
	});
	return {
		status: 'completed',
		agentName: request.agentName,
		modelId: request.model
			? `${request.model.providerID}/${request.model.modelID}`
			: undefined,
		text,
		durationMs: 2,
		promptBytes: request.prompt.length,
		responseBytes: text.length,
		costFields: {
			tokens_input: 20,
			tokens_output: 10,
			tokens_reasoning: 2,
			tokens_cache: 1,
			cost_usd: costUsd,
			cost_source: 'reported',
		},
	};
}

function failedDispatch(
	request: ReviewDispatchRequest,
	error: string,
	status: 'error' | 'timeout' = 'error',
	costUsd = 0.1,
): ReviewDispatchResult {
	return {
		status,
		agentName: request.agentName,
		modelId: request.model
			? `${request.model.providerID}/${request.model.modelID}`
			: undefined,
		text: '',
		error,
		durationMs: 1,
		promptBytes: request.prompt.length,
		responseBytes: 0,
		costFields: {
			tokens_input: 5,
			tokens_output: 0,
			tokens_reasoning: 0,
			tokens_cache: 0,
			cost_usd: costUsd,
			cost_source: 'reported',
		},
	};
}

function modelId(request: ReviewDispatchRequest): string | undefined {
	return request.model
		? `${request.model.providerID}/${request.model.modelID}`
		: undefined;
}

function baseInput(dispatcher: ReviewModelDispatcher) {
	return {
		dispatcher,
		directory: path.join(os.tmpdir(), 'validator-fallback-repo'),
		parentSessionId: 'parent',
		agentName: 'critic_finding_validator',
		model: PRIMARY,
		fallbackModels: [FALLBACK_ONE, FALLBACK_TWO],
		timeoutMs: 30_000,
		findings: [FINDING],
	};
}

describe('finding validator fallback chain', () => {
	test('429 rejection advances from primary to fallback and records both attempts', async () => {
		const requests: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				requests.push(request);
				if (requests.length === 1) {
					throw new Error('HTTP 429 rate limit exceeded');
				}
				return completedValidation(request);
			},
		};

		const result = await runFindingValidation(baseInput(dispatcher));

		expect(result.complete).toBe(true);
		expect(requests.map(modelId)).toEqual([
			'openai/primary',
			'opencode/gpt-5-nano',
		]);
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]).toMatchObject({
			status: 'error',
			modelId: 'openai/primary',
			error: 'HTTP 429 rate limit exceeded',
		});
		expect(result.dispatch).toBe(result.attempts[1]);
	});

	test('preserves per-attempt cost fields for caller aggregation', async () => {
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				return request.model?.modelID === 'primary'
					? failedDispatch(request, '503 service unavailable', 'error', 0.1)
					: completedValidation(request, 0.2);
			},
		};

		const result = await runFindingValidation(baseInput(dispatcher));
		const totalInputTokens = result.attempts.reduce(
			(sum, attempt) => sum + (attempt.costFields?.tokens_input ?? 0),
			0,
		);
		const totalCost = result.attempts.reduce(
			(sum, attempt) => sum + (attempt.costFields?.cost_usd ?? 0),
			0,
		);

		expect(result.complete).toBe(true);
		expect(result.attempts).toHaveLength(2);
		expect(totalInputTokens).toBe(25);
		expect(totalCost).toBeCloseTo(0.3);
	});

	test('permanent dispatch failure is single-shot', async () => {
		const requests: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				requests.push(request);
				return failedDispatch(request, 'invalid request schema');
			},
		};

		const result = await runFindingValidation(baseInput(dispatcher));

		expect(result.complete).toBe(false);
		expect(requests.map(modelId)).toEqual(['openai/primary']);
		expect(result.attempts).toHaveLength(1);
		expect(result.error).toBe('invalid request schema');
	});

	test('timeout advances to the next configured model', async () => {
		const requests: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				requests.push(request);
				return requests.length === 1
					? failedDispatch(request, 'deadline reached', 'timeout')
					: completedValidation(request);
			},
		};

		const result = await runFindingValidation(baseInput(dispatcher));

		expect(result.complete).toBe(true);
		expect(requests.map(modelId)).toEqual([
			'openai/primary',
			'opencode/gpt-5-nano',
		]);
	});

	test('transient exhaustion preserves model order and caps fallbacks at three', async () => {
		const requests: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				requests.push(request);
				return failedDispatch(request, '503 provider temporarily unavailable');
			},
		};

		const result = await runFindingValidation({
			...baseInput(dispatcher),
			fallbackModels: [
				FALLBACK_ONE,
				FALLBACK_TWO,
				FALLBACK_THREE,
				FALLBACK_FOUR,
			],
		});

		expect(MAX_VALIDATOR_FALLBACK_MODELS).toBe(3);
		expect(requests.map(modelId)).toEqual([
			'openai/primary',
			'opencode/gpt-5-nano',
			'anthropic/fallback-two',
			'google/fallback-three',
		]);
		expect(result.complete).toBe(false);
		expect(result.attempts).toHaveLength(4);
		expect(result.dispatch).toBe(result.attempts[3]);
	});

	test('completed malformed output does not fall back', async () => {
		const requests: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				requests.push(request);
				return {
					...completedValidation(request),
					text: 'not the validator contract',
				};
			},
		};

		const result = await runFindingValidation(baseInput(dispatcher));

		expect(result.complete).toBe(false);
		expect(result.error).toMatch(/malformed/i);
		expect(requests.map(modelId)).toEqual(['openai/primary']);
		expect(result.attempts).toHaveLength(1);
	});
});
