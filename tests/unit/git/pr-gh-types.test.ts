/**
 * Tests for src/git/pr.ts gh CLI wrappers (#2471 consolidation).
 *
 * Part 1: Type-checking tests — verify exports, types, and signatures.
 * Part 2: Runtime execution-path tests — use the _internals DI seam to mock
 * ghExecAsync and exercise success, error, and edge-case paths for the two
 * per-poll fetchers: getPRPollSnapshot (one `gh pr view --json`) and
 * getPRReviewComments (one `gh api pulls/N/comments`).
 * Part 3: Poll-consolidation output equivalence (#2471 required test) — the
 * consolidated snapshot's comment mapping must reproduce the exact
 * PRCommentResult shapes the pre-consolidation two-endpoint fetch produced
 * for the same underlying data, including the REST numeric comment id
 * recovered from the `#issuecomment-<id>` permalink.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
	MergeStateResult,
	PRCommentResult,
	PRPollSnapshot,
	PRStatusResult,
	ReviewStateResult,
} from '../../../src/git/pr';

// Import the actual values to verify they exist
import {
	_internals,
	getPRPollSnapshot,
	getPRReviewComments,
	ghExec,
} from '../../../src/git/pr';
import { neutralizeUntrustedMarkdown } from '../../../src/utils/untrusted-markdown';

describe('gh CLI wrappers — #2471 poll consolidation', () => {
	let originalGhExecAsync: typeof _internals.ghExecAsync;

	beforeEach(() => {
		originalGhExecAsync = _internals.ghExecAsync;
	});

	afterEach(() => {
		_internals.ghExecAsync = originalGhExecAsync;
	});

	// ── Part 1: Type-checking tests ───────────────────────────────────────

	describe('type-checking — export verification', () => {
		describe('PRStatusResult type', () => {
			it('has correct fields including statusCheckRollup', () => {
				const status: PRStatusResult = {
					number: 123,
					state: 'OPEN',
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					headRefOid: 'abc123',
					statusCheckRollup: [
						{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
					],
				};

				expect(status.number).toBe(123);
				expect(status.state).toBe('OPEN');
				expect(status.mergeable).toBe('MERGEABLE');
				expect(status.mergeStateStatus).toBe('CLEAN');
				expect(status.headRefOid).toBe('abc123');
				expect(status.statusCheckRollup).toHaveLength(1);
			});
		});

		describe('PRCommentResult type', () => {
			it('has correct fields', () => {
				const comment: PRCommentResult = {
					id: '123',
					author: 'testuser',
					body: 'Test comment body',
					createdAt: '2024-01-01T00:00:00Z',
					isReviewComment: false,
				};

				expect(comment.id).toBe('123');
				expect(comment.author).toBe('testuser');
				expect(comment.body).toBe('Test comment body');
				expect(comment.createdAt).toBe('2024-01-01T00:00:00Z');
				expect(comment.isReviewComment).toBe(false);
			});
		});

		describe('MergeStateResult type', () => {
			it('has correct fields', () => {
				const merge: MergeStateResult = {
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					headRefOid: 'abc123',
				};

				expect(merge.mergeable).toBe('MERGEABLE');
				expect(merge.mergeStateStatus).toBe('CLEAN');
				expect(merge.headRefOid).toBe('abc123');
			});
		});

		describe('ReviewStateResult type', () => {
			it('has correct fields', () => {
				const review: ReviewStateResult = {
					reviewDecision: 'APPROVED',
					reviewRequestCount: 0,
				};

				expect(review.reviewDecision).toBe('APPROVED');
				expect(review.reviewRequestCount).toBe(0);
			});
		});

		describe('PRPollSnapshot type', () => {
			it('composes status, comments, merge and review', () => {
				const snapshot: PRPollSnapshot = {
					status: {
						number: 42,
						state: 'OPEN',
						mergeable: 'MERGEABLE',
						mergeStateStatus: 'CLEAN',
						headRefOid: 'sha',
						statusCheckRollup: [],
					},
					comments: [],
					merge: {
						mergeable: 'MERGEABLE',
						mergeStateStatus: 'CLEAN',
						headRefOid: 'sha',
					},
					review: { reviewDecision: '', reviewRequestCount: 0 },
				};

				expect(snapshot.status.number).toBe(42);
				expect(snapshot.comments).toEqual([]);
				expect(snapshot.merge.headRefOid).toBe('sha');
				expect(snapshot.review.reviewDecision).toBe('');
			});
		});

		describe('ghExec export', () => {
			it('ghExec is exported as a function', () => {
				expect(typeof ghExec).toBe('function');
			});
		});

		describe('getPRPollSnapshot function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd) => Promise<PRPollSnapshot>', () => {
				expect(typeof getPRPollSnapshot).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
				) => Promise<PRPollSnapshot> = getPRPollSnapshot;
				expect(fn).toBeDefined();
			});
		});

		describe('getPRReviewComments function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd) => Promise<PRCommentResult[]>', () => {
				expect(typeof getPRReviewComments).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
				) => Promise<PRCommentResult[]> = getPRReviewComments;
				expect(fn).toBeDefined();
			});
		});

		describe('GIT_TIMEOUT_MS constant', () => {
			it('GIT_TIMEOUT_MS is exported and set to 30000', () => {
				const { GIT_TIMEOUT_MS } = require('../../../src/git/pr');
				expect(GIT_TIMEOUT_MS).toBe(30_000);
			});
		});
	});

	// ── Part 2: Runtime execution-path tests ─────────────────────────────

	describe('getPRPollSnapshot — runtime execution paths', () => {
		it('parses a valid pr-view payload into status/merge/review/comment shapes', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					number: 42,
					state: 'OPEN',
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					headRefOid: 'sha123abc',
					statusCheckRollup: [
						{
							name: 'ci-lint',
							status: 'COMPLETED',
							conclusion: 'SUCCESS',
						},
					],
					reviewDecision: 'APPROVED',
					reviewRequests: [{ login: 'alice' }, { login: 'bob' }],
					comments: [
						{
							id: 'IC_kwDORCfX8c8AAAABScXPIQ',
							author: { login: 'reviewer' },
							body: 'Looks good',
							createdAt: '2025-01-01T00:00:00Z',
							url: 'https://github.com/owner/repo/pull/42#issuecomment-5532667681',
						},
					],
				});

			const result = await getPRPollSnapshot(42, 'owner/repo', '/cwd');
			// status shape — identical to the pre-consolidation getPRStatus
			expect(result.status.number).toBe(42);
			expect(result.status.state).toBe('OPEN');
			expect(result.status.mergeable).toBe('MERGEABLE');
			expect(result.status.mergeStateStatus).toBe('CLEAN');
			expect(result.status.headRefOid).toBe('sha123abc');
			expect(result.status.statusCheckRollup[0]?.name).toBe('ci-lint');
			// merge shape — identical to the pre-consolidation getMergeState
			expect(result.merge).toEqual({
				mergeable: 'MERGEABLE',
				mergeStateStatus: 'CLEAN',
				headRefOid: 'sha123abc',
			});
			// review shape — identical to the pre-consolidation getPRReviewState
			expect(result.review).toEqual({
				reviewDecision: 'APPROVED',
				reviewRequestCount: 2,
			});
			// issue comment — REST numeric id recovered from the permalink
			expect(result.comments).toHaveLength(1);
			expect(result.comments[0]?.id).toBe('5532667681');
			expect(result.comments[0]?.author).toBe('reviewer');
			expect(result.comments[0]?.isReviewComment).toBe(false);
		});

		it('defaults review decision to empty string and requests to 0 when absent', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					number: 42,
					state: 'OPEN',
					mergeable: 'UNKNOWN',
					mergeStateStatus: 'UNKNOWN',
					headRefOid: 'sha',
					statusCheckRollup: [],
				});

			const result = await getPRPollSnapshot(42, 'owner/repo', '/cwd');
			expect(result.review).toEqual({
				reviewDecision: '',
				reviewRequestCount: 0,
			});
			expect(result.status.statusCheckRollup).toEqual([]);
			expect(result.comments).toEqual([]);
		});

		it('falls back to the node id when the permalink shape is unavailable', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					number: 42,
					state: 'OPEN',
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					headRefOid: 'sha',
					statusCheckRollup: [],
					comments: [
						{
							id: 'IC_nourlfallback',
							author: null,
							body: null,
							createdAt: '2025-01-01T00:00:00Z',
						},
					],
				});

			const result = await getPRPollSnapshot(42, 'owner/repo', '/cwd');
			expect(result.comments[0]?.id).toBe('IC_nourlfallback');
			expect(result.comments[0]?.author).toBe('');
			expect(result.comments[0]?.body).toBe(
				neutralizeUntrustedMarkdown('', 'GitHub issue comment'),
			);
		});

		it('throws on ENOENT (gh not found)', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(getPRPollSnapshot(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch PR poll snapshot for owner\/repo#42.*ENOENT/,
			);
		});

		it('throws on malformed JSON', async () => {
			_internals.ghExecAsync = (_args, _cwd) => '{broken';

			await expect(
				getPRPollSnapshot(42, 'owner/repo', '/cwd'),
			).rejects.toThrow();
		});

		it('passes the consolidated --json field list to ghExec', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push(args);
				return '{}';
			};

			await getPRPollSnapshot(99, 'my-org/my-repo', '/some-cwd');
			expect(capturedArgs).toHaveLength(1);
			expect(capturedArgs[0]).toEqual([
				'pr',
				'view',
				'99',
				'--repo',
				'my-org/my-repo',
				'--json',
				'number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,reviewDecision,reviewRequests,comments',
			]);
		});
	});

	describe('getPRReviewComments — runtime execution paths', () => {
		it('maps REST review comments with isReviewComment: true', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify([
					{
						id: 987654,
						user: { login: 'coder' },
						body: 'Inline remark',
						created_at: '2025-01-02T00:00:00Z',
					},
				]);

			const result = await getPRReviewComments(42, 'owner/repo', '/cwd');
			expect(result).toHaveLength(1);
			// identical mapping to the pre-consolidation review-comment half
			expect(result[0]).toEqual({
				id: '987654',
				author: 'coder',
				body: neutralizeUntrustedMarkdown(
					'Inline remark',
					'GitHub review comment',
				),
				createdAt: '2025-01-02T00:00:00Z',
				isReviewComment: true,
			});
		});

		it('throws on ENOENT (gh not found)', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(
				getPRReviewComments(42, 'owner/repo', '/cwd'),
			).rejects.toThrow(
				/Failed to fetch review comments for owner\/repo#42.*ENOENT/,
			);
		});

		it('targets the pulls comments endpoint', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push(args);
				return '[]';
			};

			await getPRReviewComments(7, 'my-org/my-repo', '/some-cwd');
			expect(capturedArgs).toHaveLength(1);
			expect(capturedArgs[0]).toEqual([
				'api',
				'repos/my-org/my-repo/pulls/7/comments',
			]);
		});
	});

	// ── Part 3: Poll-consolidation output equivalence (#2471) ────────────

	describe('poll consolidation output equivalence (#2471)', () => {
		it('snapshot comments equal the old issue-comment mapping for the same data', async () => {
			// Same underlying comment as the REST endpoint returns, expressed
			// in pr-view shape. The pre-consolidation getPRComments produced
			// exactly this PRCommentResult from the REST fields.
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					number: 42,
					state: 'OPEN',
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					headRefOid: 'sha',
					statusCheckRollup: [],
					comments: [
						{
							id: 'IC_equivalence',
							author: { login: 'someone' },
							body: 'Same comment body',
							createdAt: '2025-03-04T05:06:07Z',
							url: 'https://github.com/o/r/pull/42#issuecomment-111222333',
						},
					],
				});

			const snapshot = await getPRPollSnapshot(42, 'owner/repo', '/cwd');
			expect(snapshot.comments).toEqual([
				{
					id: '111222333',
					author: 'someone',
					body: neutralizeUntrustedMarkdown(
						'Same comment body',
						'GitHub issue comment',
					),
					createdAt: '2025-03-04T05:06:07Z',
					isReviewComment: false,
				},
			]);
		});

		it('review comments keep the numeric REST id space of the old fetch', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify([
					{
						id: 111222334,
						user: { login: 'someone' },
						body: 'inline',
						created_at: '2025-03-04T05:06:08Z',
					},
				]);

			const reviewComments = await getPRReviewComments(
				42,
				'owner/repo',
				'/cwd',
			);
			expect(reviewComments[0]?.id).toBe('111222334');
			expect(reviewComments[0]?.isReviewComment).toBe(true);
		});
	});
});
