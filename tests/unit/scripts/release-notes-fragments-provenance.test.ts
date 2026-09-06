import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	collectFragmentsForPrs,
	createHistoricalReplayBatch,
	MARKER_END,
	MARKER_START,
	peelRemoteTagObject,
	reconcileTaggedRelease,
	reconstructPublishedBlockFromWorkspace,
	resolveReleaseEntries,
	selectEntriesForPublishedBlock,
	validateExactTagProof,
	validateHistoricalReplayProof,
} from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('complete release provenance', () => {
	test('reconstructs historical provenance from the published block itself', async () => {
		const content = '# Shipped feature (#903)\n';
		const body = `${MARKER_START}\n${content.trimEnd()}\n${MARKER_END}\n\nOutside metadata (#999)\n`;
		const entries = await resolveReleaseEntries(
			'v1.2.3',
			body,
			'repo',
			() => {},
			{
				verifyCandidate: (number: number) => ({
					files: [
						{
							path:
								number === 903
									? 'docs/releases/pending/903.md'
									: 'docs/releases/pending/999.md',
						},
					],
				}),
				readFragment: (_root: string, filePath: string) => ({
					content: filePath.endsWith('/903.md') ? content : '# Other\n',
					contentSha256: 'a'.repeat(64),
				}),
			},
		);
		expect(
			entries.map((entry: { filePath: string }) => entry.filePath),
		).toEqual(['docs/releases/pending/903.md']);
		expect(selectEntriesForPublishedBlock(entries, body)).toEqual(entries);
	});

	test('reconstructs an exact uniquely matching historical workspace fragment', () => {
		const repoRoot = canonicalMkdtemp('swarm-release-provenance-');
		roots.push(repoRoot);
		const pending = path.join(repoRoot, 'docs/releases/pending');
		mkdirSync(pending, { recursive: true });
		writeFileSync(path.join(pending, 'legacy-slug.md'), '# Historical note\n');
		const body = `${MARKER_START}\n# Historical note\n${MARKER_END}\n`;

		expect(
			reconstructPublishedBlockFromWorkspace(repoRoot, body),
		).toMatchObject([
			{
				filePath: 'docs/releases/pending/legacy-slug.md',
				prNumber: null,
				order: 0,
			},
		]);
		writeFileSync(path.join(pending, 'duplicate.md'), '# Historical note\n');
		expect(() =>
			reconstructPublishedBlockFromWorkspace(repoRoot, body),
		).toThrow(/2 exact workspace matches/i);
	});

	test('recognizes GitHub caret rendering of a tagged BEL byte', () => {
		const repoRoot = canonicalMkdtemp('swarm-release-provenance-');
		roots.push(repoRoot);
		const pending = path.join(repoRoot, 'docs/releases/pending');
		mkdirSync(pending, { recursive: true });
		writeFileSync(path.join(pending, 'control.md'), 'bell: \x07rchitecture\n');
		const body = `${MARKER_START}\nbell: ^Grchitecture\n${MARKER_END}\n`;

		expect(
			reconstructPublishedBlockFromWorkspace(repoRoot, body),
		).toMatchObject([{ filePath: 'docs/releases/pending/control.md' }]);
	});

	test('rejects non-empty published notes when no entries were reconstructed', async () => {
		const repoRoot = canonicalMkdtemp('swarm-release-provenance-');
		roots.push(repoRoot);
		const release = {
			tagName: 'v1.2.3',
			body: `${MARKER_START}\nshipped notes\n${MARKER_END}\n`,
		};

		await expect(
			reconcileTaggedRelease({
				repoRoot,
				tagName: release.tagName,
				release,
				tagCommit: 'tag-commit',
				entries: [],
			}),
		).rejects.toThrow(/provenance is empty/i);
	});

	test('allows a proven zero-entry release with no custom block', async () => {
		const repoRoot = canonicalMkdtemp('swarm-release-provenance-');
		roots.push(repoRoot);
		const result = await reconcileTaggedRelease({
			repoRoot,
			tagName: 'v1.2.3',
			release: { tagName: 'v1.2.3', body: 'ordinary release notes\n' },
			tagCommit: 'tag-commit',
			entries: [],
		});
		expect(result.consumedFragments).toEqual([]);
	});

	test('fails before accepting a partial candidate lookup', () => {
		const content = '# Known fragment\n';
		expect(() =>
			collectFragmentsForPrs([101, 102], 'repo', () => {}, {
				requireComplete: true,
				verifyCandidate: (number: number) =>
					number === 101
						? { files: [{ path: 'docs/releases/pending/known.md' }] }
						: null,
				readFragment: () => ({ content, contentSha256: 'a'.repeat(64) }),
			}),
		).toThrow(/failed to resolve candidate PR #102/i);
	});
});

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
