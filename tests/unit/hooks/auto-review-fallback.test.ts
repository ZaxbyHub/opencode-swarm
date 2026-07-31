/**
 * Issue #1905: the opt-in auto-review reviewer dispatch (`runAutoReview` in
 * `src/hooks/auto-review.ts`) now fails over to a configured `fallback_models`
 * entry on a transient/quota dispatch error instead of immediately writing a
 * `verdict: 'error'` event (a quota blip previously dropped the review pass
 * with no recovery). Mirrors `tests/unit/turbo/lean/reviewer-fallback.test.ts`
 * for the sibling lean-turbo reviewer site (PR #1901), plus the #1905-specific
 * envelope-preservation pin.
 *
 * Uses the `_internals` DI seam (no `mock.module`) per AGENTS.md invariant #7.
 * The APPROVED-recovery case needs a real tmp `.swarm` dir because
 * `persistReviewReceipt` / `parseReviewerOutput` are NOT in the `_internals`
 * seam — they hit the real filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import { runAutoReview } from '../../../src/hooks/auto-review';
import {
	createReviewModelDispatcher,
	type ReviewDispatchResult,
	type ReviewModelDispatcher,
} from '../../../src/review/contracts';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import { _internals as engineInternals } from '../../../src/review/engine';
import {
	captureReviewAgentModelRegistry,
	type ReviewAgentModelRegistry,
} from '../../../src/review/runtime';
import { resetSwarmState, swarmState } from '../../../src/state';
import { _internals as telemetryInternals } from '../../../src/telemetry';

const APPROVED = [
	'VERDICT: APPROVED',
	'RISK: LOW',
	'ISSUES: none (see structured findings)',
	'```json',
	'{"findings":[],"verdict":"APPROVED","overall_confidence":0.99}',
	'```',
].join('\n');

function reviewerRegistry(
	fallbackModels: string[] = ['prov/fb1', 'prov/fb2'],
): ReviewAgentModelRegistry {
	const config = {
		agents: {
			reviewer: {
				model: 'prov/primary-reviewer',
				fallback_models: fallbackModels,
			},
		},
	} as unknown as PluginConfig;
	return captureReviewAgentModelRegistry(config, [
		'reviewer',
		'critic_finding_validator',
	]);
}

let tmpDir: string;
let origClient: typeof swarmState.opencodeClient;
let agentModelRegistry: ReviewAgentModelRegistry;
const originalCollectReviewDiff = engineInternals.collectReviewDiff;

function diffResult(): Extract<ReviewDiffResult, { status: 'ok' }> {
	const canonicalText =
		'diff --git a/src/state.ts b/src/state.ts\n@@ -9,1 +10,1 @@\n-old\n+new\n';
	return {
		status: 'ok',
		selector: { kind: 'working-tree' },
		canonicalText,
		reviewTextBytes: canonicalText.length,
		scopeHash: 'a'.repeat(64),
		headSha: 'b'.repeat(40),
		baseRef: 'origin/main',
		baseSha: 'c'.repeat(40),
		mergeBase: 'c'.repeat(40),
		changedLines: new Map([['src/state.ts', [{ start: 10, end: 10 }]]]),
		deletedLines: new Map([['src/state.ts', [{ start: 9, end: 9 }]]]),
		files: new Map([
			[
				'src/state.ts',
				{ kind: 'modified', oldPath: 'src/state.ts', newPath: 'src/state.ts' },
			],
		]),
		completeness: { complete: true, truncated: false, skipReasons: [] },
		staleness: {
			collectedAt: new Date().toISOString(),
			headSha: 'b'.repeat(40),
			selectorKey: 'working-tree',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
		},
	};
}

function dispatchResult(
	request: Parameters<ReviewModelDispatcher['dispatch']>[0],
	status: ReviewDispatchResult['status'],
	text = '',
	error?: string,
): ReviewDispatchResult {
	return {
		status,
		text,
		error,
		agentName: request.agentName,
		durationMs: 1,
		promptBytes: request.prompt.length,
		responseBytes: text.length,
	};
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'auto-review-fb-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(tmpDir, 'src', 'state.ts'), 'line\n'.repeat(20));
	origClient = swarmState.opencodeClient;
	resetSwarmState();
	agentModelRegistry = reviewerRegistry();
	engineInternals.collectReviewDiff = async () => diffResult();
});

afterEach(() => {
	swarmState.opencodeClient = origClient;
	engineInternals.collectReviewDiff = originalCollectReviewDiff;
	resetSwarmState();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function runInput(
	advisories: string[],
	dispatcher: ReviewModelDispatcher,
	registry = agentModelRegistry,
) {
	return {
		directory: tmpDir,
		sessionID: 's1',
		trigger: 'task_completion' as const,
		config: resolveAutoReviewConfig({
			enabled: true,
			trigger: 'task_completion',
		}),
		dispatcher,
		generatedAgentNames: ['reviewer', 'critic_finding_validator'],
		agentModelRegistry: registry,
		injectAdvisory: (_sid: string, msg: string) => {
			advisories.push(msg);
		},
	};
}

function readEvents(): Array<Record<string, unknown>> {
	const p = path.join(tmpDir, '.swarm', 'events.jsonl');
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

describe('runAutoReview — model failover (#1905)', () => {
	test('fails over to a fallback model on a quota dispatch error and records APPROVED', async () => {
		const calls: Array<string | undefined> = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				const model = request.model;
				calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
				return !model
					? dispatchResult(
							request,
							'error',
							'',
							'429 insufficient_quota: usage limit exceeded',
						)
					: dispatchResult(request, 'completed', APPROVED);
			},
		};
		const advisories: string[] = [];

		await runAutoReview(runInput(advisories, dispatcher));

		// Recovered → APPROVED event, NOT verdict:'error'.
		const events = readEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.verdict).toBe('approved');
		// Primary attempted (undefined), then the first fallback.
		expect(calls[0]).toBeUndefined();
		expect(calls[1]).toBe('prov/fb1');
		// Advisory was pushed on the fallback (input.injectAdvisory channel).
		expect(advisories.some((m) => m.includes('MODEL FALLBACK'))).toBe(true);
	});

	test('a permanent dispatch error still fails open (verdict:error) with no failover', async () => {
		const calls: Array<string | undefined> = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				const model = request.model;
				calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
				return dispatchResult(
					request,
					'error',
					'',
					'401 unauthorized: invalid api key',
				);
			},
		};
		const advisories: string[] = [];

		await runAutoReview(runInput(advisories, dispatcher));

		const events = readEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.verdict).toBe('error');
		// Only the primary was attempted — no fallover on a permanent error.
		expect(calls).toEqual([undefined]);
		// No MODEL FALLBACK advisory.
		expect(advisories.some((m) => m.includes('MODEL FALLBACK'))).toBe(false);
	});

	test('an auto-review dispatch timeout is permanent (no failover) — pins the defense-in-depth carve-out', async () => {
		// The classify step explicitly treats "auto-review timed out" as
		// permanent. This pins the carve-out so a future classifier change
		// cannot silently start burning the fallback chain on a slow call.
		const calls: Array<string | undefined> = [];
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				const model = request.model;
				calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
				return dispatchResult(
					request,
					'timeout',
					'',
					'auto-review timed out after 30000ms',
				);
			},
		};

		await runAutoReview(runInput([], dispatcher));

		const events = readEvents();
		expect(events[0]?.verdict).toBe('error');
		// Only the primary attempted — timeout is permanent, no failover.
		expect(calls).toEqual([undefined]);
	});

	test('emits telemetry.modelFallback on a quota failover', async () => {
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				return !request.model
					? dispatchResult(
							request,
							'error',
							'',
							'429 insufficient_quota: usage limit exceeded',
						)
					: dispatchResult(request, 'completed', APPROVED);
			},
		};

		const emitted: Array<Record<string, unknown>> = [];
		const origEmit = telemetryInternals.emit;
		telemetryInternals.emit = ((
			event: string,
			payload: Record<string, unknown>,
		) => {
			if (event === 'model_fallback') emitted.push(payload);
		}) as typeof telemetryInternals.emit;

		try {
			await runAutoReview(runInput([], dispatcher));
		} finally {
			telemetryInternals.emit = origEmit;
		}

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.toModel).toBe('prov/fb1');
		expect(emitted[0]?.reason).toBe('transient_model_error');
	});

	test('quota-annotated error event detail when all fallbacks exhausted on a quota error', async () => {
		// Mirrors integration-fallback.test.ts case d. No fallback chain seeded
		// for THIS test — resolveFallbackModel returns null, so the primary is
		// the only attempt and the quota error exhausts the (empty) chain
		// immediately. The verdict:'error' event detail should carry the quota
		// annotation added by the isQuotaError branch.
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				return dispatchResult(
					request,
					'error',
					'',
					'429 insufficient_quota: usage limit exceeded',
				);
			},
		};

		await runAutoReview(runInput([], dispatcher, reviewerRegistry([])));

		const events = readEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.verdict).toBe('error');
		expect(events[0]?.detail).toContain('quota/usage limit exhausted');
	});

	test('envelope-shaped quota error via the real dispatchReviewer (data:null + error envelope) triggers failover — pins the #1905 envelope-preservation fix', async () => {
		// This is the Critical-finding test: drive the REAL dispatchReviewer
		// (not a throwing _internals mock) with a mock client returning
		// { data: null, error: { message: '429 ...' } }. Without the
		// envelope-preservation fix at the dispatch site, the classifier would
		// see only "auto-review session returned no data" with no quota token
		// → permanent → no failover. The fix embeds JSON.stringify(error).
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'review-session-1' } }),
				prompt: async (params: { body?: { model?: unknown } }) => {
					const override = params.body?.model;
					promptCalls.push(
						override
							? `${(override as any).providerID}/${(override as any).modelID}`
							: undefined,
					);
					if (!override) {
						return {
							data: null,
							error: {
								code: 'RATE_LIMITED',
								message: '429 rate_limit_exceeded: too many requests',
							},
						};
					}
					return { data: { parts: [{ type: 'text', text: APPROVED }] } };
				},
				delete: async () => ({}),
			},
		} as typeof swarmState.opencodeClient;

		await runAutoReview(
			runInput([], createReviewModelDispatcher(swarmState.opencodeClient)),
		);

		// Failover fired on the envelope-shaped error → APPROVED event.
		const events = readEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.verdict).toBe('approved');
		expect(promptCalls[0]).toBeUndefined();
		expect(promptCalls[1]).toBe('prov/fb1');
	});
});
