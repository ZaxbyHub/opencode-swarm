import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type AutoReviewConfig,
	AutoReviewConfigSchema,
} from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import {
	_internals,
	REVIEW_SYSTEM_PROMPT,
	type RunReviewEngineInput,
	runReviewEngine,
} from '../../../src/review/engine';
import { canonicalizeValidationCandidates } from '../../../src/review/finding-validator';
import { createReviewManifest } from '../../helpers/review-manifest';

let tmpDir: string;
const originalCollect = _internals.collectReviewDiff;

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

function diffResult(
	overrides: Partial<Extract<ReviewDiffResult, { status: 'ok' }>> = {},
): Extract<ReviewDiffResult, { status: 'ok' }> {
	const canonicalText =
		'diff --git a/src/state.ts b/src/state.ts\n@@ -9,1 +10,1 @@\n-old\n+new\n';
	return {
		status: 'ok',
		selector: { kind: 'default' },
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
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
		},
		manifest: createReviewManifest(),
		...overrides,
	};
}

function queuedDispatcher(outputs: string[]): {
	dispatcher: ReviewModelDispatcher;
	calls: Array<Record<string, unknown>>;
} {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		dispatcher: {
			async dispatch(request) {
				calls.push(request as unknown as Record<string, unknown>);
				const text = outputs.shift() ?? '';
				return {
					status: 'completed' as const,
					text,
					agentName: request.agentName,
					durationMs: 1,
					promptBytes: request.prompt.length,
					responseBytes: text.length,
					costFields: {
						tokens_input: 10,
						tokens_output: 5,
						tokens_reasoning: 0,
						tokens_cache: 0,
						cost_usd: null,
						cost_source: 'unavailable' as const,
					},
				};
			},
		},
	};
}

function input(
	dispatcher: ReviewModelDispatcher,
	overrides: Partial<RunReviewEngineInput> = {},
): RunReviewEngineInput {
	return {
		directory: tmpDir,
		sessionID: 'session-1',
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

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-engine-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(tmpDir, 'src', 'state.ts'), 'line\n'.repeat(20));
	_internals.collectReviewDiff = async () => diffResult();
});

afterEach(() => {
	_internals.collectReviewDiff = originalCollect;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('shared review engine', () => {
	test('[review finding] replacement prompt is a self-contained bounded structured-output contract', () => {
		expect(REVIEW_SYSTEM_PROMPT).toContain(
			'Your complete response must be at most 800 output tokens.',
		);
		for (const legacyField of [
			'VERDICT: APPROVED | REJECTED',
			'REUSE_RE_VERIFICATION: VERIFIED | DUPLICATION_DETECTED | SKIPPED',
			'RISK: LOW | MEDIUM | HIGH | CRITICAL',
			'ISSUES: none (see structured findings JSON)',
			'ACCEPTANCE_SATISFACTION:',
			'TASK:',
			'SKILL_COMPLIANCE:',
			'DIRECTIVE_COMPLIANCE:',
			'FIXES:',
		]) {
			expect(REVIEW_SYSTEM_PROMPT).toContain(legacyField);
		}
		expect(REVIEW_SYSTEM_PROMPT).toContain(
			'severity: exactly critical | high | medium | low | info',
		);
		for (const key of [
			'"findings"',
			'"title"',
			'"body"',
			'"severity"',
			'"confidence"',
			'"file"',
			'"line_start"',
			'"line_end"',
			'"verdict"',
			'"overall_confidence"',
		]) {
			expect(REVIEW_SYSTEM_PROMPT).toContain(key);
		}
		expect(REVIEW_SYSTEM_PROMPT.match(/```json/g)).toHaveLength(1);
		expect(REVIEW_SYSTEM_PROMPT.match(/```/g)).toHaveLength(2);
		expect(REVIEW_SYSTEM_PROMPT).toContain(
			'The JSON object is strict: no additional keys are allowed',
		);
	});
	test('gate blocks only an anchored threshold finding independently CONFIRMED', async () => {
		const reviewer = structured([finding()]);
		const first = queuedDispatcher([reviewer]);
		const candidateProbe = await runReviewEngine(
			input(first.dispatcher, {
				config: config({
					validate_findings: false,
					final_review: { mode: 'advisory' },
				}),
			}),
		);
		const findingId = candidateProbe.findings[0].finding_id;
		const { dispatcher } = queuedDispatcher([
			reviewer,
			JSON.stringify({
				validations: [
					{
						finding_id: findingId,
						disposition: 'CONFIRMED',
						confidence: 0.96,
						evidence: 'src/state.ts:10 changed line reproduces',
					},
				],
			}),
		]);
		const result = await runReviewEngine(
			input(dispatcher, {
				config: config({ final_review: { mode: 'gate' } }),
			}),
		);
		expect(result.blocked).toBe(true);
		expect(result.blockReason).toBe('CONFIRMED_FINDINGS');
		expect(result.blockingFindings).toHaveLength(1);
		expect(result.evidencePath).toContain('auto-review.json');
	});
	test.each([
		['unchanged line', { line_start: 4, line_end: 4 }],
		['absolute path', { file: 'C:\\outside\\state.ts' }],
		['traversal path', { file: '../state.ts' }],
		['nonexistent path', { file: 'src/missing.ts' }],
	])('complete structured gate persists but does not block %s findings', async (_name, findingOverrides) => {
		const { dispatcher, calls } = queuedDispatcher([
			structured([finding(findingOverrides)]),
		]);
		const result = await runReviewEngine(
			input(dispatcher, {
				config: config({ final_review: { mode: 'gate' } }),
			}),
		);
		expect(result.blocked).toBe(false);
		expect(result.findings[0].anchored).toBe(false);
		expect(result.findings[0].anchor_rejection).toBeDefined();
		expect(calls).toHaveLength(1);
		expect(result.evidencePath).toBeDefined();
	});
	test('low-confidence HIGH finding is persisted as effective info and not validated', async () => {
		const { dispatcher, calls } = queuedDispatcher([
			structured([finding({ confidence: 0.2 })]),
		]);
		const result = await runReviewEngine(
			input(dispatcher, {
				config: config({
					min_confidence: 0.7,
					validate_findings: true,
					final_review: { mode: 'gate' },
				}),
			}),
		);
		expect(result.blocked).toBe(false);
		expect(result.findings[0].effective_severity).toBe('info');
		expect(calls).toHaveLength(1);
	});

	test('legacy fallback and truncated scope fail closed only in gate mode', async () => {
		const legacy = 'VERDICT: APPROVED\nRISK: LOW\nISSUES: none';
		const legacyRun = queuedDispatcher([legacy]);
		const legacyResult = await runReviewEngine(
			input(legacyRun.dispatcher, {
				config: config({ final_review: { mode: 'gate' } }),
			}),
		);
		expect(legacyResult.blocked).toBe(true);
		expect(legacyResult.blockReason).toBe('INCOMPLETE_REVIEW_EVIDENCE');

		_internals.collectReviewDiff = async () =>
			diffResult({
				scopeHash: 'd'.repeat(64),
				completeness: {
					complete: false,
					truncated: true,
					skipReasons: [
						{
							code: 'TOTAL_SCOPE_TRUNCATED',
							detail: 'cap reached',
						},
					],
				},
			});
		const truncatedRun = queuedDispatcher([structured([])]);
		const truncatedResult = await runReviewEngine(
			input(truncatedRun.dispatcher, {
				config: config({ final_review: { mode: 'gate' } }),
			}),
		);
		expect(truncatedResult.blocked).toBe(true);
		expect(truncatedResult.blockReason).toBe('INCOMPLETE_SCOPE');
	});

	test('reuses completed evidence only for the unchanged scope and policy', async () => {
		const probe = queuedDispatcher([structured([])]);
		const first = await runReviewEngine(input(probe.dispatcher));
		const second = await runReviewEngine(input(probe.dispatcher));

		expect(first.blocked).toBe(false);
		expect(second.blocked).toBe(false);
		expect(second.message).toContain('Reused fresh auto-review evidence');
		expect(second.modelCalls).toBe(0);
		expect(probe.calls).toHaveLength(1);
	});

	test('does not reuse phase evidence for a plan-completion trigger', async () => {
		const probe = queuedDispatcher([structured([]), structured([])]);
		await runReviewEngine(input(probe.dispatcher));
		const second = await runReviewEngine(
			input(probe.dispatcher, { trigger: 'plan_completion' }),
		);

		expect(second.message).not.toContain('Reused fresh auto-review evidence');
		expect(second.modelCalls).toBe(1);
		expect(probe.calls).toHaveLength(2);
	});

	test('does not let forged derived evidence erase a confirmed blocker on retry', async () => {
		const findingId = canonicalizeValidationCandidates([finding()])[0]
			.finding_id;
		const validation = JSON.stringify({
			validations: [
				{
					finding_id: findingId,
					disposition: 'CONFIRMED',
					confidence: 0.96,
					evidence: 'src/state.ts:10 changed line reproduces',
				},
			],
		});
		const probe = queuedDispatcher([
			structured([finding()]),
			validation,
			structured([finding()]),
			validation,
		]);
		const gateConfig = config({ final_review: { mode: 'gate' } });
		const first = await runReviewEngine(
			input(probe.dispatcher, { config: gateConfig }),
		);
		const persisted = JSON.parse(
			fs.readFileSync(first.evidencePath!, 'utf8'),
		) as {
			findings: Array<{
				anchored: boolean;
				anchor_rejection?: string;
				effective_severity: string;
			}>;
			blocking_finding_ids: string[];
		};
		persisted.findings[0].anchored = false;
		persisted.findings[0].anchor_rejection = 'forged';
		persisted.findings[0].effective_severity = 'info';
		persisted.blocking_finding_ids = [];
		fs.writeFileSync(first.evidencePath!, JSON.stringify(persisted), 'utf8');

		const retry = await runReviewEngine(
			input(probe.dispatcher, { config: gateConfig }),
		);
		expect(retry.message).not.toContain('Reused fresh auto-review evidence');
		expect(retry.blockReason).toBe('CONFIRMED_FINDINGS');
		expect(probe.calls).toHaveLength(4);
	});

	test('structured_findings false ignores JSON and retains legacy compatibility', async () => {
		const probe = queuedDispatcher([structured([finding()])]);
		const result = await runReviewEngine(
			input(probe.dispatcher, {
				config: config({
					structured_findings: false,
					validate_findings: true,
				}),
			}),
		);
		expect(result.blocked).toBe(false);
		expect(result.findings).toEqual([]);
		expect(result.modelCalls).toBe(1);
	});

	test('explicit UNVERIFIED disposition remains advisory and non-blocking', async () => {
		const reviewer = structured([finding()]);
		const probe = queuedDispatcher([reviewer]);
		const initial = await runReviewEngine(input(probe.dispatcher));
		const { dispatcher } = queuedDispatcher([
			reviewer,
			JSON.stringify({
				validations: [
					{
						finding_id: initial.findings[0].finding_id,
						disposition: 'UNVERIFIED',
						confidence: 0.3,
						evidence: 'runtime condition unavailable',
					},
				],
			}),
		]);
		const result = await runReviewEngine(
			input(dispatcher, {
				config: config({ final_review: { mode: 'gate' } }),
			}),
		);
		expect(result.blocked).toBe(false);
		expect(result.findings[0].validation?.disposition).toBe('UNVERIFIED');
	});

	test('partial validator output fails closed in gate and advisory never blocks', async () => {
		const reviewer = structured([finding()]);
		const gateDispatcher = queuedDispatcher([
			reviewer,
			JSON.stringify({ validations: [] }),
		]);
		const gate = await runReviewEngine(
			input(gateDispatcher.dispatcher, {
				config: config({ final_review: { mode: 'gate' } }),
			}),
		);
		expect(gate.blocked).toBe(true);
		expect(gate.blockReason).toBe('INCOMPLETE_VALIDATION');

		const advisoryDispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				return {
					status: 'timeout',
					text: '',
					error: 'timed out',
					agentName: request.agentName,
					durationMs: 30_000,
					promptBytes: 10,
					responseBytes: 0,
					costFields: {
						tokens_input: 0,
						tokens_output: 0,
						tokens_reasoning: 0,
						tokens_cache: 0,
						cost_usd: null,
						cost_source: 'unavailable',
					},
				};
			},
		};
		const advisory = await runReviewEngine(
			input(advisoryDispatcher, {
				config: config({ final_review: { mode: 'advisory' } }),
			}),
		);
		expect(advisory.blocked).toBe(false);
		expect(advisory.status).toBe('error');
	});

	test('transient reviewer timeout advances to the configured fallback model', async () => {
		const models: unknown[] = [];
		const output = structured([]);
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				models.push(request.model);
				if (models.length === 1) {
					return {
						status: 'timeout',
						text: '',
						error: 'provider timed out',
						agentName: request.agentName,
						durationMs: 30_000,
						promptBytes: request.prompt.length,
						responseBytes: 0,
					};
				}
				return {
					status: 'completed',
					text: output,
					agentName: request.agentName,
					modelId: 'backup/reviewer',
					durationMs: 1,
					promptBytes: request.prompt.length,
					responseBytes: output.length,
				};
			},
		};
		const result = await runReviewEngine(
			input(dispatcher, {
				reviewerFallbackModels: [{ providerID: 'backup', modelID: 'reviewer' }],
			}),
		);
		expect(result.status).toBe('completed');
		expect(result.modelCalls).toBe(2);
		expect(models).toEqual([
			undefined,
			{ providerID: 'backup', modelID: 'reviewer' },
		]);
	});
});
