import { describe, expect, test } from 'bun:test';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	createHistoricalReplayBatch,
	peelRemoteTagObject,
	validateExactTagProof,
	validateHistoricalReplayProof,
} from '../../../scripts/release-notes-fragments.mjs';

describe('peelRemoteTagObject', () => {
	test('peels an annotated tag to its commit with bounded API calls', () => {
		const calls: string[][] = [];
		const responses = [
			{ object: { type: 'tag', sha: 'tag-object' } },
			{ object: { type: 'commit', sha: 'commit-object' } },
		];
		const result = peelRemoteTagObject(
			'owner/repo',
			'v1.2.3',
			(args: string[]) => {
				calls.push(args);
				return responses.shift();
			},
		);
		expect(result).toBe('commit-object');
		expect(calls).toHaveLength(2);
	});

	test('rejects a tag chain that does not resolve to a commit', () => {
		expect(() =>
			peelRemoteTagObject('owner/repo', 'v1.2.3', () => ({
				object: { type: 'blob', sha: 'not-a-tag' },
			})),
		).toThrow(/did not peel/i);
	});
});

describe('validateExactTagProof', () => {
	test('accepts one exact commit and rejects remote, local, or HEAD divergence', () => {
		const commit = '0123456789abcdef0123456789abcdef01234567';
		expect(validateExactTagProof(commit, commit, commit)).toBe(commit);
		expect(() => validateExactTagProof('remote', commit, commit)).toThrow(
			/exact tag proof failed/i,
		);
		expect(() => validateExactTagProof(commit, 'local', commit)).toThrow(
			/exact tag proof failed/i,
		);
		expect(() => validateExactTagProof(commit, commit, 'head')).toThrow(
			/exact tag proof failed/i,
		);
	});
});

describe('createHistoricalReplayBatch', () => {
	test('returns bounded batches with explicit resume cursors', () => {
		const tags = ['v1.0.0', 'v1.1.0', 'v1.2.0'];
		const first = createHistoricalReplayBatch(tags, '0', 2);
		expect(first.tags).toEqual(['v1.0.0', 'v1.1.0']);
		expect(first.complete).toBe(false);
		expect(first.cursor).toBe(`${first.tagListDigest}:0`);
		expect(first.nextCursor).toBe(`${first.tagListDigest}:2`);
		const final = createHistoricalReplayBatch(tags, first.nextCursor, 2);
		expect(final.tags).toEqual(['v1.2.0']);
		expect(final.cursor).toBe(first.nextCursor);
		expect(final.nextCursor).toBeNull();
		expect(final.complete).toBe(true);
		expect(validateHistoricalReplayProof(first, 'v1.0.0')?.hasMoreWork).toBe(
			true,
		);
		expect(validateHistoricalReplayProof(final, 'v1.2.0')?.hasMoreWork).toBe(
			false,
		);
	});

	test('rejects resume after tag-list deletion, insertion, or reordering', () => {
		const tags = ['v1.0.0', 'v1.1.0', 'v1.2.0'];
		const { nextCursor } = createHistoricalReplayBatch(tags, '0', 1);
		for (const changed of [
			['v1.0.0', 'v1.2.0'],
			['v0.9.0', ...tags],
			['v1.1.0', 'v1.0.0', 'v1.2.0'],
		]) {
			expect(() => createHistoricalReplayBatch(changed, nextCursor, 1)).toThrow(
				/does not match the ordered tag list/i,
			);
		}
	});

	test('fails visibly instead of truncating oversized or invalid input', () => {
		expect(() =>
			createHistoricalReplayBatch(
				Array.from({ length: 1_001 }, (_, index) => `v1.0.${index}`),
			),
		).toThrow(/hard cap exceeded/i);
		expect(() => createHistoricalReplayBatch(['v1.0.0'], '2', 1)).toThrow(
			/malformed/i,
		);
		expect(() =>
			createHistoricalReplayBatch(['v1.0.0', 'v1.0.0'], '0', 1),
		).toThrow(/duplicate/i);
		expect(() => createHistoricalReplayBatch(['v1.0.0'], '0', 26)).toThrow(
			/between 1 and 25/i,
		);
	});
});
