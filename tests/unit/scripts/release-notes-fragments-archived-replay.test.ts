import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	collectFragmentsForPrs,
	combineFragments,
	combineRenderedFragments,
	MARKER_END,
	MARKER_START,
	matchPartsToEntries,
	reconcileTaggedRelease,
	resolveArchivedClaim,
} from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];
let claimCounter = 0;

function fixtureRoot() {
	const root = canonicalMkdtemp('swarm-archived-replay-');
	roots.push(root);
	mkdirSync(path.join(root, 'docs/releases/pending'), { recursive: true });
	mkdirSync(path.join(root, 'docs/releases/manifests'), { recursive: true });
	return root;
}

function put(root: string, relativePath: string, content: string) {
	const absolute = path.join(root, relativePath);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

function hex64(seed: number) {
	return seed.toString(16).padStart(64, '0').slice(-64);
}

function manifestFor(
	tag: string,
	fragments: Array<{ path: string; sha256: string }>,
) {
	return (
		JSON.stringify(
			{
				schemaVersion: 1,
				tag,
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				targetCommitish: 'main',
				releaseBodySha256: hex64(claimCounter++),
				fragments: fragments.map((fragment, order) => ({
					prNumber: 1,
					order,
					path: fragment.path,
					sha256: fragment.sha256,
				})),
			},
			null,
			2,
		) + '\n'
	);
}

function releaseBody(...parts: string[]) {
	return MARKER_START + '\n' + parts.join('\n\n---\n\n') + '\n' + MARKER_END;
}

describe('archived-claim resolution (#3500 claim-only design)', () => {
	test('resolveArchivedClaim resolves a unique claim and names its manifest', () => {
		const root = fixtureRoot();
		const sha = hex64(1);
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: sha },
			]),
		);
		expect(resolveArchivedClaim(root, 'docs/releases/pending/gone.md')).toEqual(
			{
				manifest: 'v1.0.0.json',
				sha256: sha,
			},
		);
	});

	test('no claim for the path resolves to null (collect then still fails closed)', () => {
		const root = fixtureRoot();
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/other.md', sha256: hex64(2) },
			]),
		);
		expect(
			resolveArchivedClaim(root, 'docs/releases/pending/gone.md'),
		).toBeNull();
		expect(() =>
			collectFragmentsForPrs([7], root, () => {}, {
				requireComplete: true,
				verifyCandidate: () => ({
					kind: 'pr',
					files: ['docs/releases/pending/gone.md'],
				}),
				readFragment: () => null,
			}),
		).toThrow(/is unavailable: docs\/releases\/pending\/gone\.md/);
	});

	test('a malformed digest is not a claim', () => {
		const root = fixtureRoot();
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: 'not-a-digest' },
			]),
		);
		expect(
			resolveArchivedClaim(root, 'docs/releases/pending/gone.md'),
		).toBeNull();
	});

	test('identical digests across manifests resolve; distinct digests fail closed', () => {
		const same = fixtureRoot();
		const sha = hex64(3);
		put(
			same,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: sha },
			]),
		);
		put(
			same,
			'docs/releases/manifests/v1.0.1.json',
			manifestFor('v1.0.1', [
				{ path: 'docs/releases/pending/gone.md', sha256: sha },
			]),
		);
		expect(resolveArchivedClaim(same, 'docs/releases/pending/gone.md')).toEqual(
			{
				manifest: 'v1.0.0.json',
				sha256: sha,
			},
		);

		const conflict = fixtureRoot();
		put(
			conflict,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: hex64(4) },
			]),
		);
		put(
			conflict,
			'docs/releases/manifests/v1.0.1.json',
			manifestFor('v1.0.1', [
				{ path: 'docs/releases/pending/gone.md', sha256: hex64(5) },
			]),
		);
		expect(() =>
			resolveArchivedClaim(conflict, 'docs/releases/pending/gone.md'),
		).toThrow(/archived claim is ambiguous/);
	});

	test('collectFragmentsForPrs resolves a claimed fragment as a claim-only entry', () => {
		const root = fixtureRoot();
		const sha = hex64(6);
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: sha },
			]),
		);
		const entries = collectFragmentsForPrs([3387], root, () => {}, {
			requireComplete: true,
			verifyCandidate: () => ({
				kind: 'pr',
				files: ['docs/releases/pending/gone.md'],
			}),
			readFragment: () => null,
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('docs/releases/pending/gone.md');
		expect(entries[0].archivedClaim).toEqual({
			manifest: 'v1.0.0.json',
			sha256: sha,
		});
		// Live-path semantics: claim-only entries render nothing (the bytes were
		// published by the earlier release; republishing would be duplicate
		// consumption) — so an all-claim-only candidate set produces an empty
		// combination for BOTH joins.
		expect(combineFragments(entries)).toBe('');
		expect(combineRenderedFragments(entries)).toBe('');
	});

	test('mixed candidate sets render only content-bearing entries', () => {
		const root = fixtureRoot();
		const sha = hex64(7);
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: sha },
			]),
		);
		put(
			root,
			'docs/releases/pending/live.md',
			'---\nissue: 9\n---\n\n# Live\n',
		);
		const entries = collectFragmentsForPrs([7, 8], root, () => {}, {
			requireComplete: true,
			verifyCandidate: (num: number) => ({
				kind: 'pr',
				files:
					num === 7
						? ['docs/releases/pending/gone.md']
						: ['docs/releases/pending/live.md'],
			}),
			readFragment: (repoRoot: string, fp: string) => {
				if (fp === 'docs/releases/pending/live.md') {
					return {
						content: readFileSync(path.join(repoRoot, fp), 'utf8'),
					};
				}
				return null;
			},
		});
		expect(combineRenderedFragments(entries)).toContain('# Live');
	});

	test('reconciliation validates the archived claim by re-resolution (fail-closed)', async () => {
		const root = fixtureRoot();
		const sha = hex64(8);
		// No manifest on disk: the claim cannot re-resolve, so reconciliation
		// must refuse the entry.
		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.3',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: {
					tagName: 'v1.2.3',
					targetCommitish: 'main',
					body: releaseBody('x'),
				},
				entries: [
					{
						prNumber: 1,
						filePath: 'docs/releases/pending/gone.md',
						archivedClaim: { manifest: 'v1.0.0.json', sha256: sha },
					},
				],
				dryRun: false,
			}),
		).rejects.toThrow(/malformed archived claim/);
	});

	test('an empty published body materializes empty history with no claims and no deletions', async () => {
		const root = fixtureRoot();
		const sha = hex64(9);
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			manifestFor('v1.0.0', [
				{ path: 'docs/releases/pending/gone.md', sha256: sha },
			]),
		);
		put(root, 'docs/releases/pending/still-pending.md', '- not consumed\n');
		const result = await reconcileTaggedRelease({
			repoRoot: root,
			tagName: 'v1.2.3',
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			release: { tagName: 'v1.2.3', targetCommitish: 'main', body: '' },
			entries: [
				{
					prNumber: 1,
					filePath: 'docs/releases/pending/gone.md',
					archivedClaim: { manifest: 'v1.0.0.json', sha256: sha },
				},
				{
					prNumber: 2,
					filePath: 'docs/releases/pending/still-pending.md',
					content: '- not consumed\n',
				},
			],
			dryRun: false,
		});
		expect(result.deleted).toEqual([]);
		expect(
			existsSync(path.join(root, 'docs/releases/pending/still-pending.md')),
		).toBe(true);
		const manifest = JSON.parse(
			readFileSync(
				path.join(root, 'docs/releases/manifests/v1.2.3.json'),
				'utf8',
			),
		);
		expect(manifest.fragments).toEqual([]);
		expect(
			readFileSync(path.join(root, 'docs/releases/v1.2.3.md'), 'utf8'),
		).toBe('');
	});
});

describe('segmentation bounds and ambiguity (#3500 A1r)', () => {
	test('a plain fragment that is a prefix of a separator-bearing one stays unambiguous', () => {
		const plain = 'intro text';
		const separated = 'intro text\n\n---\n\nafter separator';
		const body = releaseBody(separated, plain);
		const entries = [
			{ filePath: 'a.md', content: plain },
			{ filePath: 'b.md', content: separated },
		];
		const selected = matchPartsToEntries(
			body
				.slice(
					body.indexOf(MARKER_START) + MARKER_START.length,
					body.indexOf(MARKER_END),
				)
				.trim()
				.split('\n\n---\n\n'),
			entries,
		);
		// The only complete segmentation assigns the joined span to b.md and
		// the trailing part to a.md — greedily consuming a.md at the first part
		// would leave the rest unmatched, and the search must recover from that.
		expect(
			selected?.map((entry: { filePath: string }) => entry.filePath),
		).toEqual(['b.md', 'a.md']);
	});

	test('two complete segmentations fail closed as ambiguous', () => {
		const parts = ['x', 'y'];
		const entries = [
			{ filePath: 'one.md', content: 'x\n\n---\n\ny' },
			{ filePath: 'two.md', content: 'x' },
			{ filePath: 'three.md', content: 'y' },
		];
		expect(matchPartsToEntries(parts, entries)).toBeNull();
	});

	test('the parts cap fails closed beyond 256 parts', () => {
		const parts = new Array(257).fill('p');
		expect(() => matchPartsToEntries(parts, [])).toThrow(/parts cap exceeded/);
	});

	test('a body no entry can segment fails closed as unresolvable (fast, bounded)', () => {
		// No entry ever matches, so no complete segmentation exists: the
		// matcher returns null after linear work (no exponential blowup —
		// nothing to branch on).
		const parts = new Array(40).fill('p');
		expect(matchPartsToEntries(parts, [])).toBeNull();
	});

	test('the ambiguity stop bounds exponential branching (terminates, fails closed)', () => {
		// 30 distinct parts where every position admits BOTH a span-1 and a
		// span-2 resolution — 2^30 segmentation paths. The enumeration stops
		// at the second complete segmentation and fails closed as ambiguous;
		// the point is bounded termination, not the raw path count.
		const count = 30;
		const parts: string[] = [];
		const entries: Array<{ filePath: string; content: string }> = [];
		for (let index = 0; index < count; index += 1) {
			parts.push('part-' + index);
			entries.push({
				filePath: 'one-' + index + '.md',
				content: 'part-' + index,
			});
			if (index + 1 < count) {
				entries.push({
					filePath: 'two-' + index + '.md',
					content: 'part-' + index + '\n\n---\n\npart-' + (index + 1),
				});
			}
		}
		expect(matchPartsToEntries(parts, entries)).toBeNull();
	});

	test('the work budget fails closed when dead-end branching never completes', () => {
		// Span-1 and span-2 resolutions at every position, but the FINAL part
		// matches no entry and nothing spans onto it: every path dead-ends at
		// the tail, zero complete segmentations ever land, and only the work
		// counter can stop the 2^28-path exploration.
		const count = 29;
		const parts: string[] = [];
		const entries: Array<{ filePath: string; content: string }> = [];
		for (let index = 0; index < count; index += 1) {
			entries.push({
				filePath: 'one-' + index + '.md',
				content: 'part-' + index,
			});
			if (index + 1 < count) {
				entries.push({
					filePath: 'two-' + index + '.md',
					content: 'part-' + index + '\n\n---\n\npart-' + (index + 1),
				});
			}
			parts.push('part-' + index);
		}
		parts.push('unmatchable-tail'); // no entry matches it, none spans onto it
		expect(() => matchPartsToEntries(parts, entries)).toThrow(
			/search budget exceeded/,
		);
	});
});

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});
