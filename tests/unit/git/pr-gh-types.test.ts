/**
 * Tests for src/git/pr.ts gh CLI wrappers (task 1.6)
 *
 * Part 1: Type-checking tests — verify exports, types, and signatures.
 * Part 2: Runtime execution-path tests — use the _internals DI seam to mock
 * ghExec and exercise success, error, and edge-case paths for all 4 wrapper
 * functions (getPRStatus, getPRChecks, getPRComments, getMergeState).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
	MergeStateResult,
	PRCheckResult,
	PRCommentResult,
	PRStatusResult,
	ReviewStateResult,
} from '../../../src/git/pr';

// Import the actual values to verify they exist
import {
	_internals,
	getMergeState,
	getPRChecks,
	getPRComments,
	getPRReviewState,
	getPRStatus,
	ghExec,
} from '../../../src/git/pr';

// ── Type definitions to verify ───────────────────────────────────────────────

/** PRCheckResult MUST NOT have a `conclusion` field (FR-003) */
type _AssertPRCheckResultHasNoConclusion = PRCheckResult extends {
	conclusion: unknown;
}
	? never
	: true;

describe('gh CLI wrappers — task 1.6', () => {
	let originalGhExecAsync: typeof _internals.ghExecAsync;

	beforeEach(() => {
		originalGhExecAsync = _internals.ghExecAsync;
	});

	afterEach(() => {
		_internals.ghExecAsync = originalGhExecAsync;
	});

	// ── Part 1: Type-checking tests ───────────────────────────────────────

	describe('type-checking — FR-003 and export verification', () => {
		describe('PRCheckResult — regression: must NOT have conclusion field (FR-003)', () => {
			it('PRCheckResult type does not include conclusion field', () => {
				type AssertNoConclusion = _AssertPRCheckResultHasNoConclusion;
				expect<AssertNoConclusion>(true);
			});

			it('PRCheckResult has the correct fields per FR-003', () => {
				const check: PRCheckResult = {
					name: 'test-check',
					bucket: 'CI',
					state: 'COMPLETED',
					startedAt: '2024-01-01T00:00:00Z',
					completedAt: '2024-01-01T00:01:00Z',
				};

				expect(check.name).toBe('test-check');
				expect(check.bucket).toBe('CI');
				expect(check.state).toBe('COMPLETED');
				expect(check.startedAt).toBe('2024-01-01T00:00:00Z');
				expect(check.completedAt).toBe('2024-01-01T00:01:00Z');

				expect(
					(check as unknown as Record<string, unknown>).conclusion,
				).toBeUndefined();
			});
		});

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

		describe('ghExec export', () => {
			it('ghExec is exported as a function', () => {
				expect(typeof ghExec).toBe('function');
			});
		});

		describe('getPRStatus function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd) => Promise<PRStatusResult>', () => {
				expect(typeof getPRStatus).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
				) => Promise<PRStatusResult> = getPRStatus;
				expect(fn).toBeDefined();
			});
		});

		describe('getPRChecks function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd) => Promise<PRCheckResult[]>', () => {
				expect(typeof getPRChecks).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
				) => Promise<PRCheckResult[]> = getPRChecks;
				expect(fn).toBeDefined();
			});
		});

		describe('getPRComments function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd, since?) => Promise<PRCommentResult[]>', () => {
				expect(typeof getPRComments).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
					since?: string,
				) => Promise<PRCommentResult[]> = getPRComments;
				expect(fn).toBeDefined();
			});
		});

		describe('getMergeState function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd) => Promise<MergeStateResult>', () => {
				expect(typeof getMergeState).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
				) => Promise<MergeStateResult> = getMergeState;
				expect(fn).toBeDefined();
			});
		});

		describe('getPRReviewState function signature', () => {
			it('has the correct signature: (prNumber, repoFullName, cwd) => Promise<ReviewStateResult>', () => {
				expect(typeof getPRReviewState).toBe('function');
				const fn: (
					prNumber: number,
					repoFullName: string,
					cwd: string,
				) => Promise<ReviewStateResult> = getPRReviewState;
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

	describe('getPRStatus — runtime execution paths', () => {
		it('parses valid gh pr view output', async () => {
			const mockData: PRStatusResult = {
				number: 42,
				state: 'OPEN',
				mergeable: 'MERGEABLE',
				mergeStateStatus: 'CLEAN',
				headRefOid: 'sha123abc',
				statusCheckRollup: [
					{ name: 'ci-lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
					{ name: 'ci-test', status: 'IN_PROGRESS', conclusion: null },
				],
			};
			_internals.ghExecAsync = (_args, _cwd) => JSON.stringify(mockData);

			const result = await getPRStatus(42, 'owner/repo', '/cwd');
			expect(result.number).toBe(42);
			expect(result.state).toBe('OPEN');
			expect(result.mergeable).toBe('MERGEABLE');
			expect(result.mergeStateStatus).toBe('CLEAN');
			expect(result.headRefOid).toBe('sha123abc');
			expect(result.statusCheckRollup).toHaveLength(2);
			expect(result.statusCheckRollup[0].name).toBe('ci-lint');
		});

		it('throws on ENOENT (gh not found)', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(getPRStatus(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch PR status for owner\/repo#42.*ENOENT/,
			);
		});

		it('throws with descriptive message on non-zero exit', async () => {
			_internals.ghExecAsync = (_args, _cwd) => {
				throw new Error('gh exited with 1');
			};

			await expect(getPRStatus(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch PR status for owner\/repo#42/,
			);
		});

		it('throws on malformed JSON', async () => {
			_internals.ghExecAsync = (_args, _cwd) => '{invalid-json';

			await expect(getPRStatus(42, 'owner/repo', '/cwd')).rejects.toThrow();
		});

		it('passes correct args to ghExec', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push(args);
				return '{}';
			};

			await getPRStatus(42, 'owner/repo', '/test-cwd');
			expect(capturedArgs).toHaveLength(1);
			expect(capturedArgs[0]).toEqual([
				'pr',
				'view',
				'42',
				'--repo',
				'owner/repo',
				'--json',
				'number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup',
			]);
		});
	});

	describe('getPRChecks — runtime execution paths', () => {
		it('parses valid gh pr checks output', async () => {
			const mockData: PRCheckResult[] = [
				{
					name: 'ci-build',
					bucket: 'ci',
					state: 'COMPLETED',
					startedAt: '2024-01-01T00:00:00Z',
					completedAt: '2024-01-01T00:05:00Z',
				},
				{
					name: 'ci-lint',
					bucket: 'ci',
					state: 'IN_PROGRESS',
					startedAt: '2024-01-01T00:00:10Z',
					completedAt: null,
				},
			];
			_internals.ghExecAsync = (_args, _cwd) => JSON.stringify(mockData);

			const result = await getPRChecks(42, 'owner/repo', '/cwd');
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('ci-build');
			expect(result[0].bucket).toBe('ci');
			expect(result[0].state).toBe('COMPLETED');
			expect(result[1].completedAt).toBeNull();
		});

		it('verifies --json fields do NOT include conclusion', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push(args);
				return '[]';
			};

			await getPRChecks(42, 'owner/repo', '/cwd');
			expect(capturedArgs).toHaveLength(1);
			const jsonFields = capturedArgs[0][capturedArgs[0].length - 1];
			expect(jsonFields).toBe('name,bucket,state,startedAt,completedAt');
			expect(jsonFields).not.toContain('conclusion');
		});

		it('throws on ENOENT (gh not found)', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(getPRChecks(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch PR checks for owner\/repo#42.*ENOENT/,
			);
		});

		it('throws on non-zero exit', async () => {
			_internals.ghExecAsync = (_args, _cwd) => {
				throw new Error('gh exited with 1');
			};

			await expect(getPRChecks(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch PR checks for owner\/repo#42/,
			);
		});

		it('throws on malformed JSON', async () => {
			_internals.ghExecAsync = (_args, _cwd) => 'not-json-at-all';

			await expect(getPRChecks(42, 'owner/repo', '/cwd')).rejects.toThrow();
		});

		it('returns empty array when no checks', async () => {
			_internals.ghExecAsync = (_args, _cwd) => '[]';

			const result = await getPRChecks(42, 'owner/repo', '/cwd');
			expect(result).toEqual([]);
		});
	});

	describe('getPRComments — runtime execution paths', () => {
		it('parses valid issue + review comments without since', async () => {
			const issueComment = {
				id: 100,
				user: { login: 'alice' },
				body: 'Looks good!',
				created_at: '2024-01-01T00:00:00Z',
			};
			const reviewComment = {
				id: 200,
				user: { login: 'bob' },
				body: 'Nit: use const here',
				created_at: '2024-01-01T01:00:00Z',
			};

			let callCount = 0;
			_internals.ghExecAsync = (args) => {
				callCount++;
				// First call is issue comments, second is review comments
				if (args[1].includes('/issues/')) {
					return JSON.stringify([issueComment]);
				}
				return JSON.stringify([reviewComment]);
			};

			const result = await getPRComments(42, 'owner/repo', '/cwd');
			expect(result).toHaveLength(2);
			expect(callCount).toBe(2);

			// Issue comment first
			expect(result[0].id).toBe('100');
			expect(result[0].author).toBe('alice');
			expect(result[0].body).toBe('Looks good!');
			expect(result[0].isReviewComment).toBe(false);

			// Review comment second
			expect(result[1].id).toBe('200');
			expect(result[1].author).toBe('bob');
			expect(result[1].isReviewComment).toBe(true);
		});

		it('includes since query parameter when provided', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push([...args]);
				return '[]';
			};

			await getPRComments(42, 'owner/repo', '/cwd', '2024-06-01T00:00:00Z');
			expect(capturedArgs).toHaveLength(2);

			// Issue comments path should include since
			expect(capturedArgs[0][1]).toContain('since=2024-06-01T00:00:00Z');
			expect(capturedArgs[0][1]).toBe(
				'repos/owner/repo/issues/42/comments?since=2024-06-01T00:00:00Z',
			);

			// Review comments path should include since
			expect(capturedArgs[1][1]).toContain('since=2024-06-01T00:00:00Z');
			expect(capturedArgs[1][1]).toBe(
				'repos/owner/repo/pulls/42/comments?since=2024-06-01T00:00:00Z',
			);
		});

		it('omits since query parameter when not provided', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push([...args]);
				return '[]';
			};

			await getPRComments(42, 'owner/repo', '/cwd');
			expect(capturedArgs).toHaveLength(2);
			expect(capturedArgs[0][1]).not.toContain('since=');
			expect(capturedArgs[1][1]).not.toContain('since=');
		});

		it('throws on ENOENT (gh not found) for issue comments', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(getPRComments(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch issue comments for owner\/repo#42.*ENOENT/,
			);
		});

		it('throws on non-zero exit for review comments', async () => {
			let callCount = 0;
			_internals.ghExecAsync = (_args) => {
				callCount++;
				if (callCount === 1) return '[]'; // issue comments succeed
				throw new Error('gh exited with 1'); // review comments fail
			};

			await expect(getPRComments(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch review comments for owner\/repo#42/,
			);
		});

		it('handles missing user field gracefully', async () => {
			_internals.ghExecAsync = (_args) => {
				return JSON.stringify([
					{ id: 300, body: 'no user', created_at: '2024-01-01T00:00:00Z' },
				]);
			};

			const result = await getPRComments(42, 'owner/repo', '/cwd');
			expect(result).toHaveLength(2); // Both issue and review comments
			expect(result[0].author).toBe('');
			expect(result[0].id).toBe('300');
		});

		it('handles empty comment arrays', async () => {
			_internals.ghExecAsync = (_args) => '[]';

			const result = await getPRComments(42, 'owner/repo', '/cwd');
			expect(result).toHaveLength(0);
		});
	});

	describe('getMergeState — runtime execution paths', () => {
		it('parses valid merge state with MERGEABLE', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					mergeable: 'MERGEABLE',
					mergeStateStatus: 'CLEAN',
					headRefOid: 'sha456def',
				});

			const result = await getMergeState(42, 'owner/repo', '/cwd');
			expect(result.mergeable).toBe('MERGEABLE');
			expect(result.mergeStateStatus).toBe('CLEAN');
			expect(result.headRefOid).toBe('sha456def');
		});

		it('parses merge state with CONFLICTING', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					mergeable: 'CONFLICTING',
					mergeStateStatus: 'DIRTY',
					headRefOid: 'sha789ghi',
				});

			const result = await getMergeState(42, 'owner/repo', '/cwd');
			expect(result.mergeable).toBe('CONFLICTING');
			expect(result.mergeStateStatus).toBe('DIRTY');
			expect(result.headRefOid).toBe('sha789ghi');
		});

		it('parses merge state with UNKNOWN mergeable', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					mergeable: 'UNKNOWN',
					mergeStateStatus: 'BLOCKED',
					headRefOid: 'sha000',
				});

			const result = await getMergeState(42, 'owner/repo', '/cwd');
			expect(result.mergeable).toBe('UNKNOWN');
			expect(result.mergeStateStatus).toBe('BLOCKED');
		});

		it('throws on ENOENT (gh not found)', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(getMergeState(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch merge state for owner\/repo#42.*ENOENT/,
			);
		});

		it('throws on non-zero exit', async () => {
			_internals.ghExecAsync = (_args, _cwd) => {
				throw new Error('gh exited with 1');
			};

			await expect(getMergeState(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch merge state for owner\/repo#42/,
			);
		});

		it('throws on malformed JSON', async () => {
			_internals.ghExecAsync = (_args, _cwd) => '{broken';

			await expect(getMergeState(42, 'owner/repo', '/cwd')).rejects.toThrow();
		});

		it('passes correct args to ghExec', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push(args);
				return '{}';
			};

			await getMergeState(99, 'my-org/my-repo', '/some-cwd');
			expect(capturedArgs).toHaveLength(1);
			expect(capturedArgs[0]).toEqual([
				'pr',
				'view',
				'99',
				'--repo',
				'my-org/my-repo',
				'--json',
				'mergeable,mergeStateStatus,headRefOid',
			]);
		});
	});

	describe('getPRReviewState — runtime execution paths', () => {
		it('parses valid review state with APPROVED', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					reviewDecision: 'APPROVED',
					reviewRequests: [],
				});

			const result = await getPRReviewState(42, 'owner/repo', '/cwd');
			expect(result.reviewDecision).toBe('APPROVED');
			expect(result.reviewRequestCount).toBe(0);
		});

		it('parses review state with CHANGES_REQUESTED and pending requests', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					reviewDecision: 'CHANGES_REQUESTED',
					reviewRequests: [{ login: 'alice' }, { login: 'bob' }],
				});

			const result = await getPRReviewState(42, 'owner/repo', '/cwd');
			expect(result.reviewDecision).toBe('CHANGES_REQUESTED');
			expect(result.reviewRequestCount).toBe(2);
		});

		it('parses review state with REVIEW_REQUIRED', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					reviewDecision: 'REVIEW_REQUIRED',
					reviewRequests: [{ login: 'charlie' }],
				});

			const result = await getPRReviewState(42, 'owner/repo', '/cwd');
			expect(result.reviewDecision).toBe('REVIEW_REQUIRED');
			expect(result.reviewRequestCount).toBe(1);
		});

		it('defaults reviewDecision to empty string when missing', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					reviewRequests: [],
				});

			const result = await getPRReviewState(42, 'owner/repo', '/cwd');
			expect(result.reviewDecision).toBe('');
			expect(result.reviewRequestCount).toBe(0);
		});

		it('defaults reviewRequestCount to 0 when reviewRequests is missing', async () => {
			_internals.ghExecAsync = (_args, _cwd) =>
				JSON.stringify({
					reviewDecision: 'APPROVED',
				});

			const result = await getPRReviewState(42, 'owner/repo', '/cwd');
			expect(result.reviewDecision).toBe('APPROVED');
			expect(result.reviewRequestCount).toBe(0);
		});

		it('throws on ENOENT (gh not found)', async () => {
			const error = new Error('spawnSync gh ENOENT') as Error & {
				code: string;
			};
			error.code = 'ENOENT';
			_internals.ghExecAsync = (_args, _cwd) => {
				throw error;
			};

			await expect(getPRReviewState(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch review state for owner\/repo#42.*ENOENT/,
			);
		});

		it('throws on non-zero exit', async () => {
			_internals.ghExecAsync = (_args, _cwd) => {
				throw new Error('gh exited with 1');
			};

			await expect(getPRReviewState(42, 'owner/repo', '/cwd')).rejects.toThrow(
				/Failed to fetch review state for owner\/repo#42/,
			);
		});

		it('throws on malformed JSON', async () => {
			_internals.ghExecAsync = (_args, _cwd) => '{broken';

			await expect(
				getPRReviewState(42, 'owner/repo', '/cwd'),
			).rejects.toThrow();
		});

		it('passes correct args to ghExec', async () => {
			const capturedArgs: string[][] = [];
			_internals.ghExecAsync = (args) => {
				capturedArgs.push(args);
				return '{}';
			};

			await getPRReviewState(99, 'my-org/my-repo', '/some-cwd');
			expect(capturedArgs).toHaveLength(1);
			expect(capturedArgs[0]).toEqual([
				'pr',
				'view',
				'99',
				'--repo',
				'my-org/my-repo',
				'--json',
				'reviewDecision,reviewRequests',
			]);
		});
	});
});
