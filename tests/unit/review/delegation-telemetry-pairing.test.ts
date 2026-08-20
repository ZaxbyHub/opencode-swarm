import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AutoReviewConfig,
	AutoReviewConfigSchema,
} from '../../../src/config/schema';
import type {
	ReviewDispatchResult,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import {
	_internals,
	type RunReviewEngineInput,
	runReviewEngine,
} from '../../../src/review/engine';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
	type TelemetryEvent,
} from '../../../src/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Regression coverage for the delegation lifecycle contract in the review
 * engine's ephemeral-agent dispatches.
 *
 * CONTRACT (SCOPED TO THE REVIEW-ENGINE DISPATCH PATHS): every
 * `delegation_end` emitted by `src/review/engine.ts` or
 * `src/hooks/review-receipt-collector.ts` MUST be preceded by a
 * `delegation_begin` carrying an identical (sessionId, agentName, taskId)
 * triple. The converse is deliberately NOT required — a begin with no end is
 * the legitimate signal that a delegation started and never completed (thrown
 * dispatch, killed session).
 *
 * This triple equality is NOT a system-wide invariant and must never be
 * asserted globally: the Task-tool path deliberately breaks it at
 * `src/index.ts:3587`, which resolves the end's task id as
 * `beganDelegation?.taskId || taskSession.currentTaskId || ''`. A Task
 * delegation dispatched with no current task therefore emits
 * `begin(sess, agent, '')` and an end carrying the task id populated during
 * that same completion. Session and agent still match; the task id
 * legitimately may not.
 *
 * Previously the engine emitted `delegation_end` per dispatch attempt with no
 * begin at all (src/review/engine.ts dispatchReviewerWithFallback and the
 * finding-validation replay loop), so every review dispatch appeared in the
 * event stream as a phantom completion that no consumer could pair or attribute
 * to a start.
 */

let tmpDir: string;
const originalCollect = _internals.collectReviewDiff;

type CapturedEvent = { event: TelemetryEvent; data: Record<string, unknown> };
let events: CapturedEvent[] = [];

function config(overrides: Record<string, unknown> = {}): AutoReviewConfig {
	return AutoReviewConfigSchema.parse({ enabled: true, ...overrides });
}

function structured(findings: unknown[], verdict = 'REJECTED'): string {
	return [
		`VERDICT: ${verdict}`,
		'RISK: HIGH',
		'ISSUES: none',
		'```json',
		JSON.stringify({ findings, verdict, overall_confidence: 0.95 }),
		'```',
	].join('\n');
}

function finding(overrides: Record<string, unknown> = {}) {
	return {
		title: 'Incorrect state transition',
		body: 'The changed assignment skips the required pending state.',
		severity: 'high',
		confidence: 0.95,
		file: 'src/state.ts',
		line_start: 10,
		line_end: 10,
		...overrides,
	};
}

function diffResult(): Extract<ReviewDiffResult, { status: 'ok' }> {
	const canonicalText =
		'diff --git a/src/state.ts b/src/state.ts\n@@ -9,1 +10,1 @@\n-old\n+new\n';
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText,
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
			// Fixed instant: this fixture's timestamp is never asserted on, and a
			// real-clock read here would make the file time-sensitive for no gain
			// (FR / issue #1782, scripts/check-test-clock.sh).
			collectedAt: '2026-01-01T00:00:00.000Z',
			headSha: 'b'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
		},
	};
}

function completedDispatch(
	agentName: string,
	text: string,
): ReviewDispatchResult {
	return {
		status: 'completed',
		text,
		agentName,
		durationMs: 1,
		promptBytes: 1,
		responseBytes: text.length,
		costFields: {
			tokens_input: 10,
			tokens_output: 5,
			tokens_reasoning: 0,
			tokens_cache: 0,
			cost_usd: null,
			cost_source: 'unavailable',
		},
	};
}

/** Dispatcher returning a scripted outcome per call, in order. */
function scriptedDispatcher(
	outcomes: Array<'timeout' | string>,
): ReviewModelDispatcher {
	let index = 0;
	return {
		async dispatch(request) {
			const outcome = outcomes[index++] ?? '';
			if (outcome === 'timeout') {
				return {
					status: 'timeout',
					text: '',
					agentName: request.agentName,
					durationMs: 1,
					promptBytes: request.prompt.length,
					responseBytes: 0,
					error: 'dispatch timed out',
					costFields: {
						tokens_input: 0,
						tokens_output: 0,
						tokens_reasoning: 0,
						tokens_cache: 0,
						cost_usd: null,
						cost_source: 'unavailable',
					},
				};
			}
			return completedDispatch(request.agentName, outcome);
		},
	};
}

function engineInput(
	dispatcher: ReviewModelDispatcher,
	overrides: Partial<RunReviewEngineInput> = {},
): RunReviewEngineInput {
	return {
		directory: tmpDir,
		sessionID: 'pairing-session',
		trigger: 'phase_completion',
		phase: 1,
		config: config(),
		dispatcher,
		reviewerAgent: 'reviewer',
		validatorAgent: 'critic_finding_validator',
		injectAdvisory: () => {},
		...overrides,
	};
}

function delegationEvents(kind: TelemetryEvent): CapturedEvent[] {
	return events.filter((entry) => entry.event === kind);
}

/**
 * Asserts the lifecycle contract over the whole captured stream: every
 * `delegation_end` is preceded by an unconsumed `delegation_begin` with the
 * same (sessionId, agentName, taskId). Consumes matches so N ends require N
 * distinct begins rather than one begin satisfying all of them.
 */
function expectEveryEndIsPaired(): void {
	const openBegins: string[] = [];
	for (const entry of events) {
		const key = JSON.stringify([
			entry.data.sessionId,
			entry.data.agentName,
			entry.data.taskId,
		]);
		if (entry.event === 'delegation_begin') {
			openBegins.push(key);
			continue;
		}
		if (entry.event !== 'delegation_end') continue;
		const matchIndex = openBegins.indexOf(key);
		expect({ unpairedEnd: matchIndex >= 0 ? null : key }).toEqual({
			unpairedEnd: null,
		});
		openBegins.splice(matchIndex, 1);
	}
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('review-pairing-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(tmpDir, 'src', 'state.ts'), 'line\n'.repeat(20));
	_internals.collectReviewDiff = async () => diffResult();
	resetTelemetryForTesting();
	initTelemetry(tmpDir);
	events = [];
	addTelemetryListener((event, data) => {
		events.push({ event, data });
	});
});

afterEach(() => {
	_internals.collectReviewDiff = originalCollect;
	resetTelemetryForTesting();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('review engine delegation telemetry pairing', () => {
	test('a reviewer dispatch emits a delegation_begin paired with its delegation_end', async () => {
		await runReviewEngine(
			engineInput(scriptedDispatcher([structured([finding()])])),
		);

		const begins = delegationEvents('delegation_begin');
		const ends = delegationEvents('delegation_end');
		expect(ends.length).toBeGreaterThan(0);
		expect(begins).toHaveLength(ends.length);
		expectEveryEndIsPaired();
	});

	test('begin carries the same sessionId, agentName and taskId as its end, and is observed first', async () => {
		await runReviewEngine(
			engineInput(scriptedDispatcher([structured([finding()])])),
		);

		const begin = delegationEvents('delegation_begin')[0];
		const end = delegationEvents('delegation_end')[0];
		expect(begin?.data.sessionId).toBe('pairing-session');
		expect(begin?.data.agentName).toBe('reviewer');
		expect(begin?.data.taskId).toBe('phase_completion');
		expect(end?.data.sessionId).toBe(begin?.data.sessionId);
		expect(end?.data.agentName).toBe(begin?.data.agentName);
		expect(end?.data.taskId).toBe(begin?.data.taskId);
		expect(events.indexOf(begin)).toBeLessThan(events.indexOf(end));
	});

	test('finding-validation attempts are paired too, not just the reviewer dispatch', async () => {
		// `validate_findings` defaults to FALSE (src/config/schema.ts:640), so the
		// other tests in this file never reach the validation replay loop. Without
		// this case the begin added there is unexecuted and could be deleted with
		// the suite still green.
		await runReviewEngine(
			engineInput(
				scriptedDispatcher([
					structured([finding()]),
					'{"validations":[]}', // validator reply; shape is irrelevant here
				]),
				{ config: config({ validate_findings: true }) },
			),
		);

		const begins = delegationEvents('delegation_begin');
		const ends = delegationEvents('delegation_end');
		// reviewer dispatch + at least one validator attempt
		expect(ends.length).toBeGreaterThanOrEqual(2);
		expect(begins).toHaveLength(ends.length);
		expectEveryEndIsPaired();

		const validationEnds = ends.filter(
			(entry) => entry.data.gate === 'finding_validation',
		);
		expect(validationEnds.length).toBeGreaterThan(0);
		// The validator's own begin carries the validator agent, not the reviewer's.
		expect(
			begins.some(
				(entry) => entry.data.agentName === 'critic_finding_validator',
			),
		).toBe(true);
	});

	test('model fallback emits one begin per attempt, keeping ends paired one-to-one', async () => {
		// dispatchReviewerWithFallback emits one delegation_end PER model attempt
		// (retry_index). A single begin for the whole logical review would leave
		// later attempts' ends unpaired, so begins must be per-attempt too.
		await runReviewEngine(
			engineInput(scriptedDispatcher(['timeout', structured([finding()])]), {
				reviewerModel: { providerID: 'p', modelID: 'primary' },
				reviewerFallbackModels: [{ providerID: 'p', modelID: 'fallback' }],
			}),
		);

		const begins = delegationEvents('delegation_begin');
		const ends = delegationEvents('delegation_end');
		expect(ends).toHaveLength(2);
		expect(begins).toHaveLength(2);
		expectEveryEndIsPaired();
	});
});
