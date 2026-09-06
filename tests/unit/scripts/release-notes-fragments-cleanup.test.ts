import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	auditFragmentRetention,
	createHistoricalReplayBatch,
	decodeFragmentBytes,
	MARKER_END,
	MARKER_START,
	reconcileTaggedRelease,
	resolveCleanupPlanPath,
} from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixtureRoot() {
	const root = canonicalMkdtemp('swarm-release-cleanup-');
	roots.push(root);
	mkdirSync(path.join(root, 'docs/releases/pending'), { recursive: true });
	return root;
}

function put(root: string, relativePath: string, content: string) {
	const absolute = path.join(root, relativePath);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

function releaseBody(...notes: string[]) {
	return [
		'# Release',
		'',
		MARKER_START,
		notes.join('\n\n---\n\n'),
		MARKER_END,
		'',
		'Generated changelog.',
	].join('\n');
}

function options(root: string) {
	const entries = [
		{
			prNumber: 1,
			filePath: 'docs/releases/pending/one.md',
			content: '- one\n',
		},
		{
			prNumber: 2,
			filePath: 'docs/releases/pending/two.md',
			content: '- tagged two\n',
		},
	];
	return {
		repoRoot: root,
		tagName: 'v1.2.3',
		tagCommit: '0123456789abcdef0123456789abcdef01234567',
		release: {
			tagName: 'v1.2.3',
			targetCommitish: 'main',
			body: releaseBody('- one', '- tagged two'),
		},
		entries,
		maxPendingFragments: 20,
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('reconcileTaggedRelease', () => {
	test('defaults to dry-run and reports planned cleanup without mutation', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');

		const result = await reconcileTaggedRelease(options(root));

		expect(result.deleted).toEqual([]);
		expect(result.retention).toEqual({
			limit: 20,
			current: 2,
			projected: 0,
			violation: false,
			authorizedIntermediate: false,
		});
		expect(existsSync(path.join(root, 'docs/releases/v1.2.3.md'))).toBe(false);
		expect(existsSync(path.join(root, 'docs/releases/pending/one.md'))).toBe(
			true,
		);
	});

	test('materializes exact history and deletes only byte-identical files', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- changed after tag\n');
		put(root, 'docs/releases/pending/user-authored.md', '- keep\n');

		const first = await reconcileTaggedRelease({
			...options(root),
			dryRun: false,
		});
		const second = await reconcileTaggedRelease({
			...options(root),
			dryRun: false,
		});

		expect(first.deleted).toEqual(['docs/releases/pending/one.md']);
		expect(first.retained).toEqual([
			'docs/releases/pending/two.md',
			'docs/releases/pending/user-authored.md',
		]);
		expect(second.deleted).toEqual([]);
		expect(
			readFileSync(path.join(root, 'docs/releases/v1.2.3.md'), 'utf8'),
		).toBe(options(root).release.body);
		const manifest = JSON.parse(
			readFileSync(
				path.join(root, 'docs/releases/manifests/v1.2.3.json'),
				'utf8',
			),
		);
		expect(manifest.tag).toBe('v1.2.3');
		expect(manifest.fragments).toHaveLength(2);
		expect(existsSync(path.join(root, 'docs/releases/pending/two.md'))).toBe(
			true,
		);
	});

	test('retains byte-distinct files that decode to the same replacement text', async () => {
		const root = fixtureRoot();
		const currentBytes = Buffer.from([0x81]);
		writeFileSync(
			path.join(root, 'docs/releases/pending/one.md'),
			currentBytes,
		);
		const replacement = '\uFFFD';
		const taggedBytes = Buffer.from(replacement, 'utf8');
		const result = await reconcileTaggedRelease({
			...options(root),
			release: {
				...options(root).release,
				body: releaseBody(replacement),
			},
			entries: [
				{
					prNumber: 1,
					filePath: 'docs/releases/pending/one.md',
					content: replacement,
					contentSha256: createHash('sha256').update(taggedBytes).digest('hex'),
				},
			],
			dryRun: false,
		});
		expect(result.deleted).toEqual([]);
		expect(result.retained).toContain('docs/releases/pending/one.md');
		expect(
			readFileSync(path.join(root, 'docs/releases/pending/one.md')),
		).toEqual(currentBytes);
	});

	test('rejects invalid UTF-8 fragment bytes before rendering', () => {
		expect(() =>
			decodeFragmentBytes(Buffer.from([0x80]), 'docs/releases/pending/bad.md'),
		).toThrow(/not valid UTF-8/i);
	});

	test('preserves a UTF-8 BOM so its raw hash remains reconcilable', async () => {
		const root = fixtureRoot();
		const taggedBytes = Buffer.from([
			0xef, 0xbb, 0xbf, 0x23, 0x20, 0x6f, 0x6e, 0x65,
		]);
		const content = decodeFragmentBytes(
			taggedBytes,
			'docs/releases/pending/one.md',
		);
		expect(content.charCodeAt(0)).toBe(0xfeff);
		writeFileSync(path.join(root, 'docs/releases/pending/one.md'), taggedBytes);
		const result = await reconcileTaggedRelease({
			...options(root),
			release: { ...options(root).release, body: releaseBody('# one') },
			entries: [
				{
					prNumber: 1,
					filePath: 'docs/releases/pending/one.md',
					content,
					contentSha256: createHash('sha256').update(taggedBytes).digest('hex'),
				},
			],
			dryRun: false,
		});
		expect(result.deleted).toEqual(['docs/releases/pending/one.md']);
	});

	test('retains a consumed fragment when its tagged path was renamed', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/renamed.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');

		const result = await reconcileTaggedRelease({
			...options(root),
			dryRun: false,
		});

		expect(result.deleted).toEqual(['docs/releases/pending/two.md']);
		expect(result.retained).toContain('docs/releases/pending/renamed.md');
		expect(
			existsSync(path.join(root, 'docs/releases/pending/renamed.md')),
		).toBe(true);
	});

	test('rejects tag mismatch and published block mismatch before writes', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');
		await expect(
			reconcileTaggedRelease({
				...options(root),
				release: { ...options(root).release, tagName: 'v9.9.9' },
			}),
		).rejects.toThrow(/tag mismatch/i);
		await expect(
			reconcileTaggedRelease({
				...options(root),
				release: { ...options(root).release, body: releaseBody('- wrong') },
			}),
		).rejects.toThrow(/does not match/i);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.3.md'))).toBe(false);
	});

	test('refuses conflicting history and unsafe or ambiguous entries', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');
		put(root, 'docs/releases/v1.2.3.md', 'different');
		await expect(
			reconcileTaggedRelease({ ...options(root), dryRun: false }),
		).rejects.toThrow(/conflicting release history/i);
		await expect(
			reconcileTaggedRelease({
				...options(root),
				entries: [
					...options(root).entries,
					{
						prNumber: 3,
						filePath: 'docs/releases/pending/one.md',
						content: 'different',
					},
				],
			}),
		).rejects.toThrow(/ambiguous/i);
		await expect(
			reconcileTaggedRelease({
				...options(root),
				entries: [
					{
						prNumber: 1,
						filePath: 'docs/releases/pending/../escape.md',
						content: 'x',
					},
				],
			}),
		).rejects.toThrow(/unsafe/i);
	});

	test('retains symlinks even when target bytes match', async () => {
		if (process.platform === 'win32') return;
		const root = fixtureRoot();
		put(root, 'target.md', '- one\n');
		symlinkSync(
			path.join(root, 'target.md'),
			path.join(root, 'docs/releases/pending/one.md'),
		);
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');
		const result = await reconcileTaggedRelease({
			...options(root),
			dryRun: false,
		});
		expect(result.deleted).toEqual(['docs/releases/pending/two.md']);
		expect(result.retained).toContain('docs/releases/pending/one.md');
	});

	test('rejects symlinked release directories before reads or writes', async () => {
		const root = fixtureRoot();
		const outside = canonicalMkdtemp('swarm-release-outside-');
		roots.push(outside);
		rmSync(path.join(root, 'docs/releases/pending'), { recursive: true });
		symlinkSync(
			outside,
			path.join(root, 'docs/releases/pending'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		put(outside, 'one.md', '- one\n');

		await expect(reconcileTaggedRelease(options(root))).rejects.toThrow(
			/unsafe release directory/i,
		);

		unlinkSync(path.join(root, 'docs/releases/pending'));
		mkdirSync(path.join(root, 'docs/releases/pending'));
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');
		symlinkSync(
			outside,
			path.join(root, 'docs/releases/manifests'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await expect(
			reconcileTaggedRelease({ ...options(root), dryRun: false }),
		).rejects.toThrow(/unsafe release directory/i);
		unlinkSync(path.join(root, 'docs/releases/manifests'));
	});

	test('returns a structured dry-run retention violation before body proof', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/a.md', 'a');
		put(root, 'docs/releases/pending/b.md', 'b');
		const result = await reconcileTaggedRelease({
			...options(root),
			release: { tagName: 'v1.2.3', body: '' },
			entries: [],
			maxPendingFragments: 1,
		});
		expect(result.retention.violation).toBe(true);
		expect(result.retention.authorizedIntermediate).toBe(false);
		expect(result.diagnostics.join(' ')).toContain('retention');
	});

	test('refuses to mutate a final batch that remains above retention policy', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/a.md', 'a');
		put(root, 'docs/releases/pending/b.md', 'b');

		const result = await reconcileTaggedRelease({
			...options(root),
			release: { tagName: 'v1.2.3', body: '' },
			entries: [],
			maxPendingFragments: 1,
			dryRun: false,
		});

		expect(result.retention.authorizedIntermediate).toBe(false);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.3.md'))).toBe(false);
	});

	test('permits an above-limit intermediate batch only with a bounded next cursor', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/a.md', 'a');
		put(root, 'docs/releases/pending/b.md', 'b');
		const historicalReplay = createHistoricalReplayBatch(
			['v1.2.3', 'v1.2.4'],
			'0',
			1,
		);

		const result = await reconcileTaggedRelease({
			...options(root),
			release: { tagName: 'v1.2.3', body: '' },
			entries: [],
			maxPendingFragments: 1,
			dryRun: false,
			historicalReplay,
		});

		expect(result.retention).toMatchObject({
			violation: true,
			authorizedIntermediate: true,
		});
		expect(existsSync(path.join(root, 'docs/releases/v1.2.3.md'))).toBe(true);
	});

	test('rejects malformed historical replay authorization', async () => {
		const root = fixtureRoot();
		await expect(
			reconcileTaggedRelease({
				...options(root),
				historicalReplay: {
					schemaVersion: 1,
					tagListDigest: 'a'.repeat(64),
					orderedTags: ['v1.2.3', 'v1.2.4'],
					tags: ['v1.2.3'],
					cursor: 'a'.repeat(64) + ':0',
					nextCursor: 'a'.repeat(64) + ':1',
					complete: false,
				},
			}),
		).rejects.toThrow(/historical replay proof is not a contiguous/i);
	});
});

describe('auditFragmentRetention', () => {
	test('rejects a symlinked manifest directory before enumeration', () => {
		const root = fixtureRoot();
		const outside = canonicalMkdtemp('swarm-manifests-outside-');
		roots.push(outside);
		mkdirSync(path.join(root, 'docs/releases'), { recursive: true });
		symlinkSync(
			outside,
			path.join(root, 'docs/releases/manifests'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		expect(() => auditFragmentRetention(root)).toThrow(
			/unsafe release directory/i,
		);
		unlinkSync(path.join(root, 'docs/releases/manifests'));
	});

	test('does not equate distinct invalid UTF-8 byte sequences', () => {
		const root = fixtureRoot();
		const taggedBytes = Buffer.from([0x80]);
		const currentBytes = Buffer.from([0x81]);
		writeFileSync(
			path.join(root, 'docs/releases/pending/one.md'),
			currentBytes,
		);
		put(
			root,
			'docs/releases/manifests/v1.0.0.json',
			JSON.stringify({
				schemaVersion: 1,
				fragments: [
					{
						path: 'docs/releases/pending/one.md',
						sha256: createHash('sha256').update(taggedBytes).digest('hex'),
					},
				],
			}),
		);
		const result = auditFragmentRetention(root, 20);
		expect(result.consumedPending).toEqual([]);
		expect(result.violation).toBe(false);
		expect(
			readFileSync(path.join(root, 'docs/releases/pending/one.md')),
		).toEqual(currentBytes);
	});

	test('flags byte-identical consumed files and the pending-count policy', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');
		await reconcileTaggedRelease({ ...options(root), dryRun: false });
		put(root, 'docs/releases/pending/one.md', '- one\n');

		const consumed = auditFragmentRetention(root, 20);
		expect(consumed.violation).toBe(true);
		expect(consumed.consumedPending).toEqual(['docs/releases/pending/one.md']);

		rmSync(path.join(root, 'docs/releases/pending/one.md'));
		put(root, 'docs/releases/pending/unconsumed.md', '- keep\n');
		const count = auditFragmentRetention(root, 0);
		expect(count.violation).toBe(true);
		expect(count.pending).toBe(1);
	});

	test('does not classify changed retained content as already consumed', async () => {
		const root = fixtureRoot();
		put(root, 'docs/releases/pending/one.md', '- one\n');
		put(root, 'docs/releases/pending/two.md', '- tagged two\n');
		await reconcileTaggedRelease({ ...options(root), dryRun: false });
		put(root, 'docs/releases/pending/one.md', '- edited later\n');
		const result = auditFragmentRetention(root, 20);
		expect(result.consumedPending).toEqual([]);
		expect(result.violation).toBe(false);
	});
});

describe('resolveCleanupPlanPath', () => {
	test('accepts one contained JSON file and rejects escape or nesting', () => {
		const root = fixtureRoot();
		expect(
			resolveCleanupPlanPath(root, '.release-fragment-cleanup/plan.json'),
		).toBe(path.join(root, '.release-fragment-cleanup', 'plan.json'));
		for (const candidate of [
			'../outside.json',
			'.release-fragment-cleanup/nested/plan.json',
			path.join(root, 'absolute.json'),
		]) {
			expect(() => resolveCleanupPlanPath(root, candidate)).toThrow(
				/must be a JSON file/i,
			);
		}
	});
});
