/**
 * Epic phase review — which structured provider errors earn the bash retry.
 * File: tests/unit/epic/phase-readiness-provider-retry-arms.test.ts
 *
 * The retry condition is an OR: the authentication/configuration category,
 * HTTP 403, or the host's statusless `ProviderAuthError`. Each arm is pinned
 * on its own here (phase-readiness-provider-retry.test.ts supplies all of
 * them at once), and a statusless error of no auth class is not retried.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS,
	EPIC_PHASE_REVIEW_FILENAME,
	runEpicPhaseReview,
} from '../../../src/epic/phase-readiness';
import type { EphemeralProviderError } from '../../../src/evaluation/ephemeral-agent-dispatcher';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const originalInternals = { ..._internals };
let restoreClock: Restore | null = null;

const APPROVED =
	'Looks good.\nVERDICT: APPROVED\nREASON: integrated change is sound';

function writePlan(root: string): void {
	fs.mkdirSync(path.join(root, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Retry Arms Plan',
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

/** The reviewer's first dispatch fails with `providerError`; all else approves. */
async function reviewWithFirstError(
	providerError: EphemeralProviderError,
): Promise<ReviewDispatchRequest[]> {
	const calls: ReviewDispatchRequest[] = [];
	let refused = false;
	const dispatcher: ReviewModelDispatcher = {
		dispatch: async (request) => {
			calls.push(request);
			const base = {
				agentName: request.agentName,
				durationMs: 5,
				promptBytes: request.prompt.length,
			};
			if (request.agentName === 'reviewer' && !refused) {
				refused = true;
				return {
					...base,
					status: 'error' as const,
					text: '',
					error: `Ephemeral agent provider error: ${providerError.name}`,
					providerError,
					responseBytes: 0,
				};
			}
			return {
				...base,
				status: 'completed' as const,
				text: APPROVED,
				responseBytes: APPROVED.length,
			};
		},
	};
	await runEpicPhaseReview(dir, 1, 'arch', { dispatcher });
	return calls;
}

function storedReviewer(): Record<string, unknown> | null {
	return JSON.parse(
		fs.readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', EPIC_PHASE_REVIEW_FILENAME),
			'utf-8',
		),
	).reviewer;
}

beforeEach(() => {
	restoreClock = freezeClock({
		fixedNow: Date.parse('2026-06-01T12:00:00.000Z'),
	});
	dir = canonicalMkdtemp('epic-phase-retry-arms-');
	writePlan(dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, originalInternals);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('epic phase review bash retry: each refusal arm alone', () => {
	const RETRIED: Array<[string, EphemeralProviderError]> = [
		[
			'auth category with no status',
			{
				name: 'APIError',
				message: 'forbidden',
				category: 'provider.authentication_configuration',
			},
		],
		[
			'HTTP 403 with a non-auth category',
			{
				name: 'APIError',
				statusCode: 403,
				message: 'free tier',
				category: 'provider.unknown',
			},
		],
		[
			'statusless ProviderAuthError with a non-auth category',
			{
				name: 'ProviderAuthError',
				message: 'no credentials',
				category: 'provider.unknown',
			},
		],
	];
	for (const [label, providerError] of RETRIED) {
		test(`${label}: retried once with bash`, async () => {
			const calls = await reviewWithFirstError(providerError);
			expect(calls.map((c) => c.agentName)).toEqual([
				'reviewer',
				'reviewer',
				'critic',
			]);
			expect(calls[1].tools).toBe(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS);
			expect(storedReviewer()).toMatchObject({
				verdict: 'APPROVED',
				tool_profile: 'read-only-with-bash',
			});
		});
	}

	test('a statusless provider error of no auth class is not retried', async () => {
		const calls = await reviewWithFirstError({
			name: 'APIError',
			message: 'upstream exploded',
			category: 'provider.unknown',
		});
		// Exactly one dispatch: no bash retry, and a failed reviewer ends the review.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.agentName).toBe('reviewer');
		expect(calls.every((c) => c.tools === undefined)).toBe(true);
		expect(storedReviewer()).toMatchObject({
			dispatch: 'failed',
			tool_profile: 'read-only',
		});
	});
});
