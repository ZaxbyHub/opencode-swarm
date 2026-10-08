/**
 * Epic phase review — provider-refusal retry.
 * File: tests/unit/epic/phase-readiness-provider-retry.test.ts
 *
 * OpenCode Zen's free tier refuses (HTTP 403) a session whose request
 * disables `bash`; the shared review dispatcher surfaces that as a
 * `completed` response with no text. runEpicPhaseReview retries such an
 * empty response exactly once with EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS (the
 * shared read-only map minus `bash`) and records the tool profile; a model
 * that answers — even without a verdict — and a failed dispatch are never
 * retried.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	EPIC_PHASE_REVIEW_BASH_RETRY_NOTE,
	EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS,
	EPIC_PHASE_REVIEW_FILENAME,
	runEpicPhaseReview,
	verifyEpicPhaseReadiness,
} from '../../../src/epic/phase-readiness';
import { DEFAULT_READ_ONLY_TOOLS } from '../../../src/evaluation/ephemeral-agent-dispatcher';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const originalInternals = { ..._internals };
const FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');
let restoreClock: Restore | null = null;

const APPROVED =
	'Looks good.\nVERDICT: APPROVED\nREASON: integrated change is sound';

function writePlan(root: string): void {
	fs.mkdirSync(path.join(root, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Retry Plan',
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

/**
 * Scripted dispatcher: each agent gets its responses in order (a string is a
 * `completed` response with that text, an Error is an `error` dispatch).
 */
type Scripted = string | Error | { text: string; durationMs: number };

function scriptedDispatcher(
	script: Record<string, Scripted[]>,
	calls: ReviewDispatchRequest[],
): ReviewModelDispatcher {
	const cursor: Record<string, number> = {};
	return {
		dispatch: async (request) => {
			calls.push(request);
			const index = cursor[request.agentName] ?? 0;
			cursor[request.agentName] = index + 1;
			const raw = script[request.agentName]?.[index] ?? '';
			const timed = typeof raw === 'object' && !(raw instanceof Error);
			const next = timed ? raw.text : raw;
			const base = {
				agentName: request.agentName,
				durationMs: timed ? raw.durationMs : 5,
				promptBytes: request.prompt.length,
			};
			return next instanceof Error
				? {
						...base,
						status: 'error' as const,
						text: '',
						error: next.message,
						responseBytes: 0,
					}
				: {
						...base,
						status: 'completed' as const,
						text: next,
						responseBytes: next.length,
					};
		},
	};
}

function stored(): Record<string, Record<string, unknown> | null> {
	return JSON.parse(
		fs.readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', EPIC_PHASE_REVIEW_FILENAME),
			'utf-8',
		),
	);
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW_MS });
	dir = canonicalMkdtemp('epic-phase-retry-');
	writePlan(dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, originalInternals);
	closeAllProjectDbs();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS', () => {
	test('is the shared read-only map with only bash re-enabled', () => {
		expect('bash' in EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS).toBe(false);
		const expected = Object.keys(DEFAULT_READ_ONLY_TOOLS).filter(
			(name) => name !== 'bash',
		);
		expect(Object.keys(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS).sort()).toEqual(
			expected.sort(),
		);
		expect(
			Object.values(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS).every(
				(v) => v === false,
			),
		).toBe(true);
		for (const mutating of ['write', 'edit', 'patch', 'shell', 'task']) {
			expect(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS[mutating]).toBe(false);
		}
		expect(Object.isFrozen(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS)).toBe(true);
	});
});

describe('runEpicPhaseReview provider-refusal retry', () => {
	test('an empty response is retried once keeping bash, and the verdict is recorded', async () => {
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher(
				{ reviewer: ['', APPROVED], critic: [APPROVED] },
				calls,
			),
		});
		expect(result.success && result.ready).toBe(true);
		expect(calls.map((c) => c.agentName)).toEqual([
			'reviewer',
			'reviewer',
			'critic',
		]);
		expect(calls[0].tools).toBeUndefined();
		expect(calls[1].tools).toBe(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS);
		expect(calls[1].prompt).toBe(calls[0].prompt);
		expect(calls[1].system).toBe(
			`${calls[0].system}\n\n${EPIC_PHASE_REVIEW_BASH_RETRY_NOTE}`,
		);
		expect(calls[2].tools).toBeUndefined();
		const evidence = stored();
		expect(evidence.reviewer).toMatchObject({
			verdict: 'APPROVED',
			dispatch: 'completed',
			tool_profile: 'read-only-with-bash',
		});
		expect(evidence.critic).toMatchObject({
			verdict: 'APPROVED',
			tool_profile: 'read-only',
		});
		expect((await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).ok).toBe(
			true,
		);
		// An approved review hands off to the normal PHASE-WRAP (docs agent)
		// before phase_complete, which requires the docs role.
		expect(result.success && result.message).toContain('PHASE-WRAP');
		expect(result.success && result.message).toContain('docs agent');
	});

	test('a whitespace-only response counts as empty and is retried', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher(
				{ reviewer: ['  \n ', APPROVED], critic: [APPROVED] },
				calls,
			),
		});
		expect(calls.filter((c) => c.agentName === 'reviewer')).toHaveLength(2);
	});

	test('a model that answers without a verdict is not retried', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher(
				{ reviewer: ['I think it is fine.'] },
				calls,
			),
		});
		expect(calls).toHaveLength(1);
		expect(stored().reviewer).toMatchObject({
			verdict: 'REJECTED',
			dispatch: 'unparseable',
			tool_profile: 'read-only',
		});
	});

	test('two empty responses stay fail-closed after exactly one retry', async () => {
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher({ reviewer: ['', ''] }, calls),
		});
		expect(result.success && !result.ready).toBe(true);
		expect(calls).toHaveLength(2);
		expect(stored().reviewer).toMatchObject({
			verdict: 'REJECTED',
			dispatch: 'unparseable',
			tool_profile: 'read-only-with-bash',
		});
		expect(stored().critic).toBeNull();
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{ ok: false, code: 'EPIC_PHASE_REVIEWER_NOT_APPROVED' },
		);
	});

	test('a structured provider refusal (status error + providerError) is retried with bash', async () => {
		// A dispatcher that reads the assistant message's info.error reports
		// the Zen 403 as an error carrying providerError instead of an empty
		// completion; the retry must cover that shape too.
		const calls: ReviewDispatchRequest[] = [];
		const scripted = scriptedDispatcher(
			{ reviewer: [APPROVED], critic: [APPROVED] },
			calls,
		);
		let refused = false;
		const dispatcher: ReviewModelDispatcher = {
			dispatch: async (request) => {
				if (request.agentName === 'reviewer' && !refused) {
					refused = true;
					calls.push(request);
					return {
						agentName: request.agentName,
						status: 'error',
						text: '',
						error:
							'Ephemeral agent provider error: APIError (HTTP 403): free tier',
						providerError: {
							name: 'APIError',
							statusCode: 403,
							message: 'free tier',
							category: 'provider.authentication_configuration',
						},
						durationMs: 5,
						promptBytes: request.prompt.length,
						responseBytes: 0,
					};
				}
				return scripted.dispatch(request);
			},
		};
		const result = await runEpicPhaseReview(dir, 1, 'arch', { dispatcher });
		expect(result.success && result.ready).toBe(true);
		expect(calls.map((c) => c.agentName)).toEqual([
			'reviewer',
			'reviewer',
			'critic',
		]);
		expect(calls[1].tools).toBe(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS);
		expect(stored().reviewer).toMatchObject({
			verdict: 'APPROVED',
			tool_profile: 'read-only-with-bash',
		});
	});

	test('a rate-limit providerError is not retried with bash', async () => {
		// Re-enabling bash cannot cure a 429: the model-fallback chain owns it.
		const calls: ReviewDispatchRequest[] = [];
		const dispatcher: ReviewModelDispatcher = {
			dispatch: async (request) => {
				calls.push(request);
				return {
					agentName: request.agentName,
					status: 'error',
					text: '',
					error:
						'Ephemeral agent provider error: APIError (HTTP 429): slow down',
					providerError: {
						name: 'APIError',
						statusCode: 429,
						message: 'slow down',
						category: 'provider.rate_limit',
					},
					durationMs: 5,
					promptBytes: request.prompt.length,
					responseBytes: 0,
				};
			},
		};
		await runEpicPhaseReview(dir, 1, 'arch', { dispatcher });
		expect(calls.every((c) => c.tools === undefined)).toBe(true);
		expect(stored().reviewer).toMatchObject({
			dispatch: 'failed',
			tool_profile: 'read-only',
		});
	});

	test('a failed dispatch is not retried with bash', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher(
				{ reviewer: [new Error('provider exploded')] },
				calls,
			),
		});
		expect(calls.every((c) => c.tools === undefined)).toBe(true);
		expect(stored().reviewer).toMatchObject({
			dispatch: 'failed',
			tool_profile: 'read-only',
		});
	});
});

describe('runEpicPhaseReview retry bounds and bookkeeping', () => {
	test('the retry only gets the time left of the per-role timeout, and durations add up', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			timeoutMs: 1_000,
			dispatcher: scriptedDispatcher(
				{
					reviewer: [
						{ text: '', durationMs: 400 },
						{ text: APPROVED, durationMs: 250 },
					],
					critic: [APPROVED],
				},
				calls,
			),
		});
		expect(calls[0].timeoutMs).toBe(1_000);
		expect(calls[1].timeoutMs).toBe(600);
		expect(stored().reviewer).toMatchObject({
			verdict: 'APPROVED',
			duration_ms: 650,
		});
	});

	test('no retry once the first attempt used up the timeout', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			timeoutMs: 1_000,
			dispatcher: scriptedDispatcher(
				{ reviewer: [{ text: '', durationMs: 1_000 }] },
				calls,
			),
		});
		expect(calls).toHaveLength(1);
		expect(stored().reviewer).toMatchObject({
			dispatch: 'unparseable',
			tool_profile: 'read-only',
		});
	});

	test('the tool profile is reset for a fallback model attempt', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 'arch', {
			agentModelRegistry: {
				reviewer: { fallbackModels: ['opencode/fallback-model'] },
			} as never,
			dispatcher: scriptedDispatcher(
				{
					reviewer: [
						'',
						new Error('429 Too Many Requests: rate limit'),
						APPROVED,
					],
					critic: [APPROVED],
				},
				calls,
			),
		});
		const reviewerCalls = calls.filter((c) => c.agentName === 'reviewer');
		expect(reviewerCalls).toHaveLength(3);
		expect(reviewerCalls[1].tools).toBe(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS);
		expect(reviewerCalls[2].tools).toBeUndefined();
		expect(reviewerCalls[2].model).toMatchObject({
			providerID: 'opencode',
			modelID: 'fallback-model',
		});
		expect(stored().reviewer).toMatchObject({
			verdict: 'APPROVED',
			tool_profile: 'read-only',
		});
	});

	test('the critic is retried the same way and the message says so', async () => {
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher(
				{ reviewer: [APPROVED], critic: ['', APPROVED] },
				calls,
			),
		});
		expect(calls.map((c) => c.agentName)).toEqual([
			'reviewer',
			'critic',
			'critic',
		]);
		expect(stored().critic).toMatchObject({
			verdict: 'APPROVED',
			tool_profile: 'read-only-with-bash',
		});
		expect(result.success && result.message).toContain('retried with bash');
	});
});

describe('tool_profile in stored evidence', () => {
	async function approvedEvidence(): Promise<string> {
		await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: scriptedDispatcher(
				{ reviewer: [APPROVED], critic: [APPROVED] },
				[],
			),
		});
		return path.join(
			dir,
			'.swarm',
			'evidence',
			'1',
			EPIC_PHASE_REVIEW_FILENAME,
		);
	}

	test('evidence written before the field existed is still valid', async () => {
		const file = await approvedEvidence();
		const evidence = JSON.parse(fs.readFileSync(file, 'utf-8'));
		delete evidence.reviewer.tool_profile;
		delete evidence.critic.tool_profile;
		fs.writeFileSync(file, JSON.stringify(evidence));
		expect((await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).ok).toBe(
			true,
		);
	});

	test('an unknown tool_profile makes the evidence invalid', async () => {
		const file = await approvedEvidence();
		const evidence = JSON.parse(fs.readFileSync(file, 'utf-8'));
		evidence.reviewer.tool_profile = 'full';
		fs.writeFileSync(file, JSON.stringify(evidence));
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{ ok: false, code: 'EPIC_PHASE_REVIEW_INVALID' },
		);
	});
});
