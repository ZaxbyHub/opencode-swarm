import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import { MAX_EPHEMERAL_PROMPT_BYTE_LIMIT } from '../../../src/evaluation/ephemeral-agent-dispatcher';
import type {
	ReviewDiffResult,
	ReviewDiffSelector,
} from '../../../src/review/diff-source';
import {
	buildReviewPrompt,
	_internals as engineInternals,
	REVIEW_SYSTEM_PROMPT,
	runReviewEngine,
} from '../../../src/review/engine';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const realCollectReviewDiff = engineInternals.collectReviewDiff;

function structuredApproval(): string {
	return [
		'VERDICT: APPROVED',
		'```json',
		'{"findings":[],"verdict":"APPROVED","overall_confidence":0.95}',
		'```',
	].join('\n');
}

function reviewDiff(
	canonicalText: string,
	scopeHashCharacter: string,
	fallbackFiles?: string[],
): Extract<ReviewDiffResult, { status: 'ok' }> {
	const incomplete = fallbackFiles !== undefined;
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText,
		reviewTextBytes: Buffer.byteLength(canonicalText, 'utf8'),
		scopeHash: scopeHashCharacter.repeat(64),
		headSha: 'a'.repeat(40),
		baseRef: 'origin/main',
		baseSha: 'b'.repeat(40),
		mergeBase: 'c'.repeat(40),
		changedLines: new Map([['src/included.ts', [{ start: 1, end: 1 }]]]),
		deletedLines: new Map(),
		files: new Map([
			[
				'src/included.ts',
				{
					kind: 'modified',
					oldPath: 'src/included.ts',
					newPath: 'src/included.ts',
				},
			],
		]),
		completeness: {
			complete: !incomplete,
			truncated: incomplete,
			skipReasons: incomplete
				? [
						{
							code: 'TOTAL_SCOPE_TRUNCATED',
							detail: 'fixture exceeded the configured review cap',
						},
					]
				: [],
			fileListFallback: fallbackFiles
				? {
						files: fallbackFiles,
						complete: true,
						truncated: false,
					}
				: undefined,
		},
		staleness: {
			collectedAt: new Date().toISOString(),
			headSha: 'a'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: scopeHashCharacter.repeat(64),
		},
	};
}

afterEach(() => {
	engineInternals.collectReviewDiff = realCollectReviewDiff;
});

describe('review prompt hard-cap contract', () => {
	const selectorCases: Array<{
		selector: ReviewDiffSelector;
		targetKind: string;
	}> = [
		{
			selector: { kind: 'default' },
			targetKind: 'checkout-history-index-working-tree',
		},
		{
			selector: { kind: 'base', ref: 'origin/release' },
			targetKind: 'checkout-history-index-working-tree',
		},
		{
			selector: {
				kind: 'range',
				from: 'release-base',
				to: 'release-target',
				operator: '...',
			},
			targetKind: 'exact-committed-range',
		},
		{
			selector: { kind: 'working-tree' },
			targetKind: 'checkout-index-working-tree',
		},
	];

	test.each(
		selectorCases,
	)('identifies selector $selector.kind without conflating checkout and target', ({
		selector,
		targetKind,
	}) => {
		const diff = reviewDiff('target-only diff', 's');
		diff.selector = selector;
		diff.staleness.includesWorkingTree = selector.kind !== 'range';
		if (selector.kind === 'range') {
			diff.rangeToSha = 'd'.repeat(40);
		}

		const prompt = buildReviewPrompt({ trigger: 'manual', diff });
		expect(prompt).toContain(`REVIEW_SELECTOR: ${JSON.stringify(selector)}`);
		expect(prompt).toContain(`REVIEW_TARGET_KIND: ${targetKind}`);
		expect(prompt).toContain(`CHECKOUT_HEAD_SHA: ${diff.headSha}`);
		expect(prompt).toContain(
			`REVIEW_SCOPE_INCLUDES_WORKING_TREE: ${selector.kind !== 'range'}`,
		);
		if (selector.kind === 'range') {
			expect(prompt).toContain(`RESOLVED_FROM_SHA: ${diff.baseSha}`);
			expect(prompt).toContain(`RESOLVED_TO_SHA: ${diff.rangeToSha}`);
			expect(prompt).toContain(`REVIEW_TARGET_SHA: ${diff.rangeToSha}`);
		} else {
			expect(prompt).not.toContain('REVIEW_TARGET_SHA:');
		}
		expect(prompt).not.toContain('\nHEAD_SHA:');
	});

	test('dispatches the 2 MiB quote-heavy critic probe with an exact request limit', async () => {
		const fixture = createSafeTestDir('review-prompt-cap-');
		const files = Array.from(
			{ length: 2_465 },
			(_, index) => `src/${index}-${'"'.repeat(200)}.ts`,
		);
		const nul = '\0';
		const trackedBytes = Buffer.byteLength(
			`${files.slice(0, 1_235).join(nul)}${nul}`,
		);
		const untrackedBytes = Buffer.byteLength(
			`${files.slice(1_235).join(nul)}${nul}`,
		);
		const diff = reviewDiff('x'.repeat(2 * 1024 * 1024), 'd', files);
		engineInternals.collectReviewDiff = async () => diff;
		let dispatchedPrompt = '';
		let dispatchedRequestBytes = 0;
		try {
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'quote-heavy-cap',
				trigger: 'phase_completion',
				phase: 1,
				config: resolveAutoReviewConfig({
					enabled: true,
					final_review: { max_diff_bytes: 2 * 1024 * 1024 },
				}),
				dispatcher: {
					async dispatch(request) {
						dispatchedPrompt = request.prompt;
						dispatchedRequestBytes =
							Buffer.byteLength(REVIEW_SYSTEM_PROMPT, 'utf8') +
							Buffer.byteLength(request.prompt, 'utf8');
						expect(request.promptByteLimit).toBe(dispatchedRequestBytes);
						expect(dispatchedRequestBytes).toBeLessThanOrEqual(
							MAX_EPHEMERAL_PROMPT_BYTE_LIMIT,
						);
						return {
							status: 'completed',
							agentName: request.agentName,
							text: structuredApproval(),
							durationMs: 1,
							promptBytes: dispatchedRequestBytes,
							responseBytes: 1,
						};
					},
				},
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});

			expect(trackedBytes).toBeLessThanOrEqual(256 * 1024);
			expect(untrackedBytes).toBeLessThanOrEqual(256 * 1024);
			expect(result.status).toBe('completed');
			expect(dispatchedRequestBytes).toBeGreaterThan(2_883_584);
			expect(dispatchedPrompt).toContain('FILE_LIST_FALLBACK_COMPLETE: true');
			expect(dispatchedPrompt).not.toContain('FILE_LIST_FALLBACK_OMITTED');
			expect(result.scopeFileList).toEqual(files);
			expect(result.scopeFileListComplete).toBe(true);

			const evidence = JSON.parse(
				fs.readFileSync(result.evidencePath ?? '', 'utf8'),
			) as {
				scope: {
					hash: string;
					completeness: { fileListFallback?: { files: string[] } };
				};
			};
			expect(evidence.scope.hash).toBe(diff.scopeHash);
			expect(evidence.scope.completeness.fileListFallback?.files).toEqual(
				files,
			);
		} finally {
			fixture.cleanup();
		}
	});

	test('omits only rendered names and discloses the incomplete prompt inventory', async () => {
		const fixture = createSafeTestDir('review-prompt-omission-');
		const quote = '"';
		const files = Array.from({ length: 137 }, (_, index) => {
			const unique = `${quote.repeat(index)}a${quote.repeat(254 - index)}`;
			const middle = Array.from({ length: 13 }, () => quote.repeat(255));
			return index < 68
				? [unique, ...middle, quote.repeat(241), quote.repeat(25)].join('/')
				: [unique, ...middle, quote.repeat(212)].join('/');
		});
		const nul = '\0';
		const trackedBytes = Buffer.byteLength(
			`${files.slice(0, 68).join(nul)}${nul}`,
		);
		const untrackedBytes = Buffer.byteLength(
			`${files.slice(68).join(nul)}${nul}`,
		);
		const diff = reviewDiff('x'.repeat(2 * 1024 * 1024), 'g', files);
		engineInternals.collectReviewDiff = async () => diff;
		let dispatchedPrompt = '';
		try {
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'quote-dense-omission',
				trigger: 'phase_completion',
				phase: 1,
				config: resolveAutoReviewConfig({
					enabled: true,
					final_review: { max_diff_bytes: 2 * 1024 * 1024 },
				}),
				dispatcher: {
					async dispatch(request) {
						dispatchedPrompt = request.prompt;
						const requestBytes =
							Buffer.byteLength(REVIEW_SYSTEM_PROMPT, 'utf8') +
							Buffer.byteLength(request.prompt, 'utf8');
						expect(request.promptByteLimit).toBe(requestBytes);
						expect(requestBytes).toBeLessThanOrEqual(
							MAX_EPHEMERAL_PROMPT_BYTE_LIMIT,
						);
						return {
							status: 'completed',
							agentName: request.agentName,
							text: structuredApproval(),
							durationMs: 1,
							promptBytes: requestBytes,
							responseBytes: 1,
						};
					},
				},
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});

			expect(trackedBytes).toBeLessThanOrEqual(256 * 1024);
			expect(untrackedBytes).toBeLessThanOrEqual(256 * 1024);
			expect(result.status).toBe('completed');
			expect(dispatchedPrompt).toContain('FILE_LIST_FALLBACK_COMPLETE: false');
			expect(dispatchedPrompt).toContain(
				'FILE_LIST_FALLBACK_SOURCE_COMPLETE: true',
			);
			expect(dispatchedPrompt).toContain(
				'FILE_LIST_FALLBACK_WARNING: INCOMPLETE PROMPT INVENTORY',
			);
			const included = Number(
				/FILE_LIST_FALLBACK_INCLUDED: (\d+)/.exec(dispatchedPrompt)?.[1],
			);
			const omitted = Number(
				/FILE_LIST_FALLBACK_OMITTED: (\d+)/.exec(dispatchedPrompt)?.[1],
			);
			expect(included).toBeGreaterThan(0);
			expect(omitted).toBeGreaterThan(0);
			expect(included + omitted).toBe(files.length);
			expect(result.scopeFileList).toHaveLength(included);
			expect(result.scopeFileListComplete).toBe(false);
			expect(result.scopeWarnings?.join(' ')).toContain(
				`${omitted} name(s) were omitted`,
			);

			const evidence = JSON.parse(
				fs.readFileSync(result.evidencePath ?? '', 'utf8'),
			) as {
				scope: { completeness: { fileListFallback?: { files: string[] } } };
			};
			expect(evidence.scope.completeness.fileListFallback?.files).toEqual(
				files,
			);
		} finally {
			fixture.cleanup();
		}
	});

	test('dispatches at the exact ceiling and refuses ceiling plus one', async () => {
		const fixture = createSafeTestDir('review-prompt-boundary-');
		const oneByteDiff = reviewDiff('x', 'e');
		const fixedRequestBytes =
			Buffer.byteLength(REVIEW_SYSTEM_PROMPT, 'utf8') +
			Buffer.byteLength(
				buildReviewPrompt({
					trigger: 'manual',
					diff: oneByteDiff,
				}),
				'utf8',
			) -
			1;
		const exactDiff = reviewDiff(
			'x'.repeat(MAX_EPHEMERAL_PROMPT_BYTE_LIMIT - fixedRequestBytes),
			'e',
		);
		const overDiff = reviewDiff(`${exactDiff.canonicalText}x`, 'f');
		let dispatches = 0;
		const run = () =>
			runReviewEngine({
				directory: fixture.dir,
				sessionID: 'prompt-boundary',
				trigger: 'manual',
				config: resolveAutoReviewConfig({ enabled: true }),
				dispatcher: {
					async dispatch(request) {
						dispatches++;
						expect(
							Buffer.byteLength(REVIEW_SYSTEM_PROMPT, 'utf8') +
								Buffer.byteLength(request.prompt, 'utf8'),
						).toBe(MAX_EPHEMERAL_PROMPT_BYTE_LIMIT);
						expect(request.promptByteLimit).toBe(
							MAX_EPHEMERAL_PROMPT_BYTE_LIMIT,
						);
						return {
							status: 'completed',
							agentName: request.agentName,
							text: structuredApproval(),
							durationMs: 1,
							promptBytes: MAX_EPHEMERAL_PROMPT_BYTE_LIMIT,
							responseBytes: 1,
						};
					},
				},
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});
		try {
			engineInternals.collectReviewDiff = async () => exactDiff;
			expect((await run()).status).toBe('completed');
			expect(dispatches).toBe(1);

			engineInternals.collectReviewDiff = async () => overDiff;
			const overResult = await run();
			expect(overResult.status).toBe('error');
			expect(overResult.message).toContain(
				`requires ${MAX_EPHEMERAL_PROMPT_BYTE_LIMIT + 1} bytes`,
			);
			expect(overResult.message).toContain(
				'after omitting all fallback file names',
			);
			expect(dispatches).toBe(1);
		} finally {
			fixture.cleanup();
		}
	});
});
