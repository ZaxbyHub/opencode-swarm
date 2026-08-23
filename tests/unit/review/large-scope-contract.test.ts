import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import { createReviewModelDispatcher } from '../../../src/review/contracts';
import {
	collectReviewDiff,
	_internals as diffInternals,
	type ReviewDiffResult,
} from '../../../src/review/diff-source';
import {
	_internals as engineInternals,
	runReviewEngine,
} from '../../../src/review/engine';
import type {
	BunCompatSpawnOptions,
	BunCompatSubprocess,
} from '../../../src/utils/bun-compat';
import { createReviewManifest } from '../../helpers/review-manifest';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const realSpawn = diffInternals.bunSpawn;
const realCollectReviewDiff = engineInternals.collectReviewDiff;

function stream(text: string) {
	const bytes = new TextEncoder().encode(text);
	return {
		async text() {
			return text;
		},
		async bytes() {
			return bytes;
		},
		getReader() {
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}).getReader();
		},
	};
}

function proc(stdout: string, onKill: () => void): BunCompatSubprocess {
	return {
		stdout: stream(stdout),
		stderr: stream(''),
		exited: Promise.resolve(0),
		exitCode: 0,
		kill: onKill,
	};
}

function structuredApproval(): string {
	return [
		'VERDICT: APPROVED',
		'```json',
		'{"findings":[],"verdict":"APPROVED","overall_confidence":0.95}',
		'```',
	].join('\n');
}

afterEach(() => {
	diffInternals.bunSpawn = realSpawn;
	engineInternals.collectReviewDiff = realCollectReviewDiff;
});

describe('large review scope contract', () => {
	test('dispatches a 600 KiB review prompt when the bounded caller limit permits it', async () => {
		let promptCalled = false;
		const client = {
			session: {
				create: async () => ({ data: { id: 'large-review' } }),
				prompt: async () => {
					promptCalled = true;
					return {
						data: {
							info: {
								providerID: 'test',
								modelID: 'reviewer',
								cost: 0,
								tokens: {
									input: 1,
									output: 1,
									reasoning: 0,
									cache: { read: 0, write: 0 },
								},
							},
							parts: [{ type: 'text', text: structuredApproval() }],
						},
					};
				},
				delete: async () => ({}),
			},
		} as never;
		const prompt = 'x'.repeat(600 * 1024);

		const result = await createReviewModelDispatcher(client).dispatch({
			directory: process.cwd(),
			agentName: 'reviewer',
			system: 'bounded review',
			prompt,
			promptByteLimit: 700 * 1024,
			timeoutMs: 1_000,
		});

		expect(result.status).toBe('completed');
		expect(result.promptBytes).toBe(
			Buffer.byteLength('bounded review', 'utf8') +
				Buffer.byteLength(prompt, 'utf8'),
		);
		expect(promptCalled).toBe(true);
	});

	test('persists a bounded complete changed-file fallback when diff text truncates', async () => {
		const fixture = createSafeTestDir('review-large-scope-');
		const calls: Array<{ command: string[]; options: BunCompatSpawnOptions }> =
			[];
		let kills = 0;
		const oversizedDiff = [
			'diff --git a/src/included.ts b/src/included.ts',
			'--- a/src/included.ts',
			'+++ b/src/included.ts',
			'@@ -1 +1 @@',
			'-old',
			`+${'x'.repeat(2_000)}`,
			'',
		].join('\n');
		try {
			diffInternals.bunSpawn = ((command, options) => {
				calls.push({ command, options });
				const joined = command.join(' ');
				const kill = () => {
					kills++;
				};
				if (joined.includes('rev-parse --show-toplevel')) {
					return proc(`${fixture.dir}\n`, kill);
				}
				if (joined.includes('HEAD^{commit}')) return proc(`${HEAD}\n`, kill);
				if (joined.includes('symbolic-ref')) {
					return proc('origin/main\n', kill);
				}
				if (joined.includes('origin/main^{commit}')) {
					return proc(`${BASE}\n`, kill);
				}
				if (joined.includes('merge-base')) {
					return proc(`${MERGE_BASE}\n`, kill);
				}
				if (joined.includes('--show-object-format')) {
					return proc('sha1\n', kill);
				}
				if (joined.includes('ls-files')) {
					return proc('untracked.ts\0', kill);
				}
				if (joined.includes('--name-only')) {
					return proc('src/included.ts\0src/omitted.ts\0', kill);
				}
				if (joined.includes(' diff ')) return proc(oversizedDiff, kill);
				throw new Error(`unexpected git command: ${joined}`);
			}) as typeof realSpawn;

			const result = await collectReviewDiff({
				directory: fixture.dir,
				maxBytes: 512,
			});

			expect(result.status).toBe('ok');
			if (result.status !== 'ok') throw new Error('expected truncated scope');
			expect(result.completeness).toMatchObject({
				complete: false,
				truncated: true,
				fileListFallback: {
					complete: true,
					truncated: false,
					files: ['src/included.ts', 'src/omitted.ts', 'untracked.ts'],
				},
			});
			expect(result.canonicalText).toContain('review diff truncated');
			expect(calls.some(({ command }) => command.includes('--name-only'))).toBe(
				true,
			);
			for (const call of calls) {
				expect(call.command[0]).toBe('git');
				expect(call.options.cwd).toBe(fixture.dir);
				expect(call.options.stdin).toBe('ignore');
				expect(call.options.timeout).toBeGreaterThan(0);
				expect(call.options.stdout).toBe('pipe');
				expect(call.options.stderr).toBe('pipe');
			}
			expect(kills).toBeGreaterThanOrEqual(calls.length);
		} finally {
			fixture.cleanup();
		}
	});

	test('marks incomplete scope in the reviewer prompt, result, and automatic advisory', async () => {
		const fixture = createSafeTestDir('review-large-advisory-');
		const canonicalText = [
			'diff --git a/src/included.ts b/src/included.ts',
			'--- a/src/included.ts',
			'+++ b/src/included.ts',
			'@@ -1 +1 @@',
			'-old',
			`+${'x'.repeat(600 * 1024)}`,
			'... [review diff truncated: max_bytes]',
		].join('\n');
		const diff: Extract<ReviewDiffResult, { status: 'ok' }> = {
			status: 'ok',
			selector: { kind: 'default' },
			canonicalText,
			reviewTextBytes: Buffer.byteLength(canonicalText, 'utf8'),
			scopeHash: 'd'.repeat(64),
			headSha: HEAD,
			baseRef: 'origin/main',
			baseSha: BASE,
			mergeBase: MERGE_BASE,
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
				complete: false,
				truncated: true,
				skipReasons: [
					{
						code: 'TOTAL_SCOPE_TRUNCATED',
						detail: 'fixture exceeded the configured review cap',
					},
				],
				fileListFallback: {
					files: ['src/included.ts', 'src/omitted.ts'],
					complete: true,
					truncated: false,
				},
			},
			staleness: {
				collectedAt: new Date().toISOString(),
				headSha: HEAD,
				selectorKey: 'default',
				includesWorkingTree: true,
				scopeHash: 'd'.repeat(64),
			},
			manifest: createReviewManifest(),
		};
		engineInternals.collectReviewDiff = async () => diff;
		let dispatchedPrompt = '';
		let dispatchedLimit = 0;
		const advisories: string[] = [];
		try {
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'large-scope-session',
				trigger: 'phase_completion',
				phase: 1,
				config: resolveAutoReviewConfig({
					enabled: true,
					final_review: {
						mode: 'advisory',
						max_diff_bytes: 700 * 1024,
					},
				}),
				dispatcher: {
					async dispatch(request) {
						dispatchedPrompt = request.prompt;
						dispatchedLimit = request.promptByteLimit ?? 0;
						return {
							status: 'completed',
							agentName: request.agentName,
							text: structuredApproval(),
							durationMs: 1,
							promptBytes: Buffer.byteLength(request.prompt, 'utf8'),
							responseBytes: 1,
						};
					},
				},
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
				injectAdvisory: (_sessionID, advisory) => {
					advisories.push(advisory);
				},
			});

			expect(dispatchedLimit).toBeGreaterThan(
				Buffer.byteLength(dispatchedPrompt, 'utf8'),
			);
			expect(dispatchedPrompt).toContain('SCOPE_WARNING: INCOMPLETE');
			expect(dispatchedPrompt).toContain('FILE_LIST_FALLBACK_COMPLETE: true');
			expect(dispatchedPrompt).toContain('"src/omitted.ts"');
			expect(result.scopeComplete).toBe(false);
			expect(result.scopeFileList).toEqual([
				'src/included.ts',
				'src/omitted.ts',
			]);
			expect(result.scopeWarnings?.join(' ')).toContain(
				'must not be treated as a whole-diff verdict',
			);
			expect(advisories).toHaveLength(1);
			expect(advisories[0]).toContain(
				'No findings were reported in the reviewed subset',
			);
			expect(advisories[0]).toContain('Review scope was incomplete');
		} finally {
			fixture.cleanup();
		}
	});
});
