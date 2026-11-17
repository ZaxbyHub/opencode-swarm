/**
 * #3724 item 2 (AC3/AC4 durable pins): the provider-message carrier must reach
 * the epic fallback classifier.
 *
 * Root cause: `src/epic/phase-readiness.ts` rethrew
 * `new Error(response.error ?? ...)` — dropping `response.providerError` — so a
 * deterministic 403 whose flattened text carries rate-limit words classified as
 * transient and advanced the epic fallback_models chain (burning every fallback
 * on an authorization failure). The fix rethrows the carrier
 * (`providerMessageErrorToError`); `dispatchWithModelFallback`'s own
 * carrier-aware gate does the classification. Harness mirrors
 * phase-readiness-provider-retry.test.ts / the #3177 runner-carrier analogue.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	EPIC_PHASE_REVIEW_FILENAME,
	runEpicPhaseReview,
} from '../../../src/epic/phase-readiness';
import type {
	ReviewDispatchRequest,
	ReviewDispatchResult,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FALLBACK_MODEL = 'opencode/fallback-model';
const APPROVED =
	'Looks good.\nVERDICT: APPROVED\nREASON: integrated change is sound';

interface ScriptedError {
	statusCode: number;
	message: string;
	category: string;
	retryClass: string;
	risk: string;
	prefix: string;
}

const ERROR_403_RATE_LIMIT_TEXT: ScriptedError = {
	statusCode: 403,
	message: 'rate limit exceeded',
	category: 'provider.authentication_configuration',
	retryClass: 'operator_action',
	risk: 'high',
	prefix: 'Epic phase reviewer dispatch error',
};

const ERROR_429: ScriptedError = {
	statusCode: 429,
	message: 'rate limit exceeded',
	category: 'provider.rate_limit',
	retryClass: 'retry_same',
	risk: 'medium',
	prefix: 'Epic phase reviewer dispatch error',
};

function writePlan(root: string): void {
	fs.mkdirSync(path.join(root, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Carrier Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: ['1.1', '1.2'].map((id) => ({
						id,
						phase: 1,
						status: 'completed',
						description: `Task ${id}`,
						files_touched: [`src/${id}.ts`],
					})),
				},
			],
		}),
	);
	for (const id of ['1.1', '1.2']) {
		fs.writeFileSync(
			path.join(root, '.swarm', 'evidence', `${id}.json`),
			JSON.stringify({ taskId: id }),
		);
	}
}

function scriptedErrorDispatcher(
	scripted: ScriptedError | null,
	structureLessError: string | null,
	calls: ReviewDispatchRequest[],
): ReviewModelDispatcher {
	return {
		dispatch: async (request) => {
			calls.push(request);
			if (request.agentName !== 'reviewer') {
				return {
					agentName: request.agentName,
					status: 'completed',
					text: APPROVED,
					durationMs: 5,
					promptBytes: request.prompt.length,
					responseBytes: APPROVED.length,
				} as ReviewDispatchResult;
			}
			if (structureLessError !== null) {
				return {
					agentName: request.agentName,
					status: 'error',
					text: '',
					error: structureLessError,
					durationMs: 5,
					promptBytes: request.prompt.length,
					responseBytes: 0,
				} as ReviewDispatchResult;
			}
			return {
				agentName: request.agentName,
				status: 'error',
				text: '',
				error: `${scripted?.prefix}: APIError (HTTP ${scripted?.statusCode}): ${scripted?.message}`,
				providerError: {
					name: 'APIError',
					statusCode: scripted?.statusCode,
					message: scripted?.message,
					category: scripted?.category,
					retryClass: scripted?.retryClass,
					risk: scripted?.risk,
				},
				durationMs: 5,
				promptBytes: request.prompt.length,
				responseBytes: 0,
			} as ReviewDispatchResult;
		},
	};
}

interface LegResult {
	fallbackDispatched: boolean;
	reviewerDispatches: number;
}

async function runLeg(options: {
	scripted?: ScriptedError;
	structureLessError?: string;
	label: string;
}): Promise<LegResult> {
	const dir = canonicalMkdtemp(`epic-carrier-3724-${options.label}-`);
	try {
		writePlan(dir);
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			agentModelRegistry: {
				reviewer: { fallbackModels: [FALLBACK_MODEL] },
			} as never,
			dispatcher: scriptedErrorDispatcher(
				options.scripted ?? null,
				options.structureLessError ?? null,
				calls,
			),
		});
		const reviewerCalls = calls.filter((c) => c.agentName === 'reviewer');
		const fallbackDispatched = reviewerCalls.some(
			(c) =>
				(c as { model?: { providerID?: string; modelID?: string } }).model
					?.modelID === 'fallback-model',
		);
		return { fallbackDispatched, reviewerDispatches: reviewerCalls.length };
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}

describe('epic phase-review fallback carrier (#3724 item 2)', () => {
	test('a deterministic HTTP 403 whose text says "rate limit exceeded" does NOT advance the fallback chain', async () => {
		const leg = await runLeg({
			scripted: ERROR_403_RATE_LIMIT_TEXT,
			label: '403',
		});
		expect(leg.fallbackDispatched).toBe(false);
	}, 30_000);

	test('a genuine HTTP 429 carrier still fails over (the fallback model is dispatched)', async () => {
		const leg = await runLeg({ scripted: ERROR_429, label: '429' });
		expect(leg.fallbackDispatched).toBe(true);
		expect(leg.reviewerDispatches).toBeGreaterThanOrEqual(2);
	}, 30_000);

	test('a structure-less transient error (no providerError carrier) still fails over from raw text', async () => {
		const padding = 'x'.repeat(600);
		const leg = await runLeg({
			structureLessError: `Epic phase reviewer dispatch error: ${padding} HTTP 503 Service Unavailable`,
			label: '503-text',
		});
		expect(leg.fallbackDispatched).toBe(true);
	}, 30_000);
});
