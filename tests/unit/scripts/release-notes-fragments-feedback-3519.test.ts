/**
 * Issue #3519 feedback-round fixes (PR #3519 review closure): the guarded
 * behaviors added in response to the three posted reviews.
 *
 * - F1 (HIGH): a DELETED pending fragment in a candidate PR's file list is
 *   historical record, not a live fragment. Excluding changeType 'removed'
 *   in filterPendingFragmentPaths keeps this PR's own deletion of
 *   docs/releases/pending/git-status-async-diagnosable.md (double-claimed
 *   across v7.199.5/v7.200.1 manifests with distinct digests) from sending
 *   the next release into archived-claim resolution for a path whose claims
 *   disagree (the old resolver threw on distinct digests).
 * - F1b/F7: archived-claim resolution is latest-consumption-wins with a
 *   digest-only identity; the claiming-manifest NAME is informational.
 * - F9: a malformed manifest is a throw, not a silent skip (the retention
 *   audit already fails closed on the same shapes).
 * - F12: the materialized v7.199.2/v7.200.1 history is verified in-tree:
 *   manifest schema, fragment paths absent from pending, the tag's vX.md
 *   present, and releaseBodySha256 equal to sha256 of the repo copy.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
	assertNoLiveArchivedRewrite,
	filterPendingFragmentPaths,
	reconcileTaggedRelease,
	resolveArchivedClaim,
} from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const REPO_ROOT = path.resolve(
	path.dirname(import.meta.path),
	'..',
	'..',
	'..',
);

function put(root: string, relativePath: string, content: string) {
	const absolute = path.join(root, relativePath);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

function hex64(seed: number): string {
	return createHash('sha256').update(String(seed), 'utf8').digest('hex');
}

function manifestFor(tag: string, fragments: Array<Record<string, unknown>>) {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			tag,
			tagCommit: 'a'.repeat(40),
			targetCommitish: 'a'.repeat(40),
			releaseBodySha256: hex64(tag.length),
			fragments,
		},
		null,
		2,
	)}\n`;
}

function cleanup(root: string) {
	rmSync(root, { recursive: true, force: true });
}

describe('issue #3519 feedback fixes (release fragment pipeline)', () => {
	test('filterPendingFragmentPaths excludes DELETED entries (H-1)', () => {
		// The changeType shapes are the LIVE `gh pr view --json files` values —
		// UPPERCASE ("DELETED"/"ADDED"), captured on PR #3519 itself. A
		// lowercase-only pin fabricated a shape the live seam never emits
		// (review-round Critical finding; the filter is case-insensitive).
		const filtered = filterPendingFragmentPaths([
			{
				path: 'docs/releases/pending/git-status-async-diagnosable.md',
				changeType: 'DELETED',
			},
			{
				path: 'docs/releases/pending/3500-3510-3511-release-fragment-stranding.md',
				changeType: 'ADDED',
			},
			{
				path: 'docs/releases/pending/kept-modified.md',
				changeType: 'MODIFIED',
			},
		]);
		expect(filtered).toEqual([
			'docs/releases/pending/3500-3510-3511-release-fragment-stranding.md',
			'docs/releases/pending/kept-modified.md',
		]);
		// Lowercase and mixed-case spellings are filtered identically.
		expect(
			filterPendingFragmentPaths([
				{
					path: 'docs/releases/pending/gone-lower.md',
					changeType: 'removed',
				},
			]),
		).toEqual([]);
		// String entries (legacy callers) pass through unchanged.
		expect(
			filterPendingFragmentPaths(['docs/releases/pending/kept.md']),
		).toEqual(['docs/releases/pending/kept.md']);
	});

	test('latest-consumption-wins on distinct digests (normal history, not corruption)', () => {
		const root = canonicalMkdtemp('swarm-release-feedback-');
		try {
			put(
				root,
				'docs/releases/manifests/v1.0.0.json',
				manifestFor('v1.0.0', [
					{ path: 'docs/releases/pending/gone.md', sha256: hex64(4) },
				]),
			);
			put(
				root,
				'docs/releases/manifests/v1.0.1.json',
				manifestFor('v1.0.1', [
					{ path: 'docs/releases/pending/gone.md', sha256: hex64(5) },
				]),
			);
			put(
				root,
				'docs/releases/manifests/v2.10.0.json',
				manifestFor('v2.10.0', [
					{ path: 'docs/releases/pending/gone.md', sha256: hex64(6) },
				]),
			);
			expect(
				resolveArchivedClaim(root, 'docs/releases/pending/gone.md'),
			).toEqual({ manifest: 'v2.10.0.json', sha256: hex64(6) });
		} finally {
			cleanup(root);
		}
	});

	test('a malformed manifest is a throw, not a silent skip (F9)', () => {
		const root = canonicalMkdtemp('swarm-release-feedback-');
		try {
			put(root, 'docs/releases/manifests/broken.json', '{ not json');
			put(
				root,
				'docs/releases/manifests/v1.0.1.json',
				manifestFor('v1.0.1', [
					{ path: 'docs/releases/pending/gone.md', sha256: hex64(8) },
				]),
			);
			expect(() =>
				resolveArchivedClaim(root, 'docs/releases/pending/gone.md'),
			).toThrow(/malformed release manifest/);
		} finally {
			cleanup(root);
		}
	});

	test('materialized release history verifies against the repo tree (F12)', () => {
		for (const tag of ['v7.199.2', 'v7.200.1']) {
			const manifestPath = path.join(
				REPO_ROOT,
				'docs/releases/manifests',
				`${tag}.json`,
			);
			const bodyPath = path.join(REPO_ROOT, 'docs/releases', `${tag}.md`);
			expect(existsSync(manifestPath)).toBe(true);
			expect(existsSync(bodyPath)).toBe(true);
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			expect(manifest.schemaVersion).toBe(1);
			expect(manifest.tag).toBe(tag);
			const bodySha = createHash('sha256')
				.update(readFileSync(bodyPath))
				.digest('hex');
			expect(manifest.releaseBodySha256).toBe(bodySha);
			for (const fragment of manifest.fragments) {
				expect(String(fragment.path).startsWith('docs/releases/pending/')).toBe(
					true,
				);
				expect(existsSync(path.join(REPO_ROOT, String(fragment.path)))).toBe(
					false,
				);
			}
		}
		// v7.199.2's published body was byte-empty; the materialized doc is
		// byte-empty and the manifest pins the empty-string digest.
		const emptyBody = readFileSync(
			path.join(REPO_ROOT, 'docs/releases/v7.199.2.md'),
		);
		expect(emptyBody.length).toBe(0);
		const emptyManifest = JSON.parse(
			readFileSync(
				path.join(REPO_ROOT, 'docs/releases/manifests/v7.199.2.json'),
				'utf8',
			),
		);
		expect(emptyManifest.fragments).toEqual([]);
		expect(emptyManifest.releaseBodySha256).toBe(
			createHash('sha256').update(new Uint8Array(0)).digest('hex'),
		);
	});

	test('live update-release refuses to rewrite a block that references archived fragments (F5)', () => {
		const claimed = {
			filePath: 'docs/releases/pending/gone.md',
			archivedClaim: { manifest: 'v1.0.0.json', sha256: hex64(1) },
		};
		// No block markers in the body: archived entries render as nothing and
		// the live path may proceed (a fresh upsert adds the other sections).
		expect(() =>
			assertNoLiveArchivedRewrite([claimed], 'plain body without markers'),
		).not.toThrow();
		// Block present + archived entries: the rewrite would silently drop
		// the archived sections — the named hazard must fire.
		const bodyWithBlock = [
			'intro',
			'<!-- custom-release-notes:start -->',
			'old',
			'<!-- custom-release-notes:end -->',
			'',
		].join('\n');
		expect(() => assertNoLiveArchivedRewrite([claimed], bodyWithBlock)).toThrow(
			/gone\.md[\s\S]*duplicate-consumption hazard/,
		);
		// Content-bearing entries never trip the guard.
		const contentEntry = {
			filePath: 'docs/releases/pending/here.md',
			content: 'x',
		};
		expect(() =>
			assertNoLiveArchivedRewrite([contentEntry], bodyWithBlock),
		).not.toThrow();
	});

	test('reconciliation refuses a claim-only entry whose digest no manifest matches (F7)', async () => {
		const root = canonicalMkdtemp('swarm-release-feedback-');
		try {
			const recordedSha = hex64(11);
			// A manifest claims the path with a DIFFERENT digest than the
			// entry's recorded claim: digest-only identity means a stale claim
			// never replays as valid (the name is not consulted at all).
			put(
				root,
				'docs/releases/manifests/v1.0.0.json',
				manifestFor('v1.0.0', [
					{ path: 'docs/releases/pending/gone.md', sha256: hex64(12) },
				]),
			);
			await expect(
				reconcileTaggedRelease({
					repoRoot: root,
					tagName: 'v1.2.3',
					tagCommit: '0'.repeat(40),
					release: {
						tagName: 'v1.2.3',
						targetCommitish: 'main',
						body: 'intro\n<!-- custom-release-notes:start -->\nold\n<!-- custom-release-notes:end -->\n',
					},
					entries: [
						{
							prNumber: 1,
							filePath: 'docs/releases/pending/gone.md',
							archivedClaim: { manifest: 'v1.0.0.json', sha256: recordedSha },
						},
					],
					dryRun: false,
				}),
			).rejects.toThrow(/malformed archived claim/);
		} finally {
			cleanup(root);
		}
	});
});
