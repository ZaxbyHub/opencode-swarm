/**
 * Issue #3500 AC2 — archived-claim provenance for fragments already
 * materialized by an earlier release.
 *
 * `collectFragmentsForPrs` with `requireComplete: true` throws
 * `incomplete release provenance: fragment referenced by #N is unavailable:
 * <path>` as soon as `readFragment` returns null for a candidate PR's
 * fragment path. It never consults the already-merged release manifests
 * (docs/releases/manifests/*.json, schemaVersion 1, fragments[] carrying
 * path+sha256 claims). Real-world case: candidate PR #3387 references
 * docs/releases/pending/skills-frontmatter-hardening-3215-3216-3217.md,
 * which the earlier v7.199.1 materialization archived (deleted from pending,
 * claim recorded in its manifest) — so historical replay of v7.199.2 can
 * never materialize.
 *
 * RED at base, GREEN after the fix: an unavailable fragment whose exact
 * path+sha256 is claimed by an archived release manifest must resolve from
 * that claim instead of throwing, while a missing / malformed claim must
 * keep throwing fail-closed.
 *
 * Contract choice (documented per the trace): the fix's exact return shape
 * is not pinned yet, so the primary assertion is the OBSERVABLE CONTRACT —
 * the call does not throw AND the resolved entries mention the archived
 * path exactly once (length 1, filePath equal). The seam used is the
 * exported `collectFragmentsForPrs` with its existing injectable
 * `{ requireComplete, verifyCandidate, readFragment }` options — no new
 * export is required.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import { collectFragmentsForPrs } from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixtureRoot() {
	const root = canonicalMkdtemp('swarm-release-archived-');
	roots.push(root);
	// pending/ exists but is EMPTY — the v7.199.1 materialization already
	// archived (deleted) the fragment this trace replays.
	mkdirSync(path.join(root, 'docs/releases/pending'), { recursive: true });
	mkdirSync(path.join(root, 'docs/releases/manifests'), { recursive: true });
	return root;
}

function put(root: string, relativePath: string, content: string) {
	const absolute = path.join(root, relativePath);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

const FRAGMENT_PATH =
	'docs/releases/pending/skills-frontmatter-hardening-3215-3216-3217.md';

/** A well-formed 64-hex digest standing in for the archived fragment bytes. */
function hexDigest(seed: string): string {
	return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/**
 * Manifest fixture matching the committed schema exactly (compare
 * docs/releases/manifests/v7.200.10.json): schemaVersion 1, tag, tagCommit,
 * targetCommitish, releaseBodySha256, and fragments[] entries shaped
 * `{ prNumber, order, path, sha256 }`.
 */
function manifestFor(fragments: Array<Record<string, unknown>>): string {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			tag: 'v7.199.1',
			tagCommit: 'a'.repeat(40),
			targetCommitish: 'a'.repeat(40),
			releaseBodySha256: hexDigest('release body for v7.199.1'),
			fragments,
		},
		null,
		2,
	)}\n`;
}

/** PR-shaped verifyCandidate result, mirroring gh pr view --json number,files. */
function prWithFiles(files: string[]) {
	return { kind: 'pr', files };
}

function collect(root: string, options: Record<string, unknown> = {}) {
	const logLines: string[] = [];
	const entries = collectFragmentsForPrs(
		[3387],
		root,
		(message: string) => logLines.push(message),
		{
			requireComplete: true,
			verifyCandidate: () => prWithFiles([FRAGMENT_PATH]),
			readFragment: () => null,
			...options,
		},
	);
	return { entries, logLines };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('collectFragmentsForPrs archived-claim provenance (issue #3500)', () => {
	test('resolves an unavailable fragment from the archived release-manifest claim instead of throwing', () => {
		// RED at base (throws "incomplete release provenance: fragment
		// referenced by #3387 is unavailable: <path>"), GREEN after the fix.
		const root = fixtureRoot();
		put(
			root,
			'docs/releases/manifests/v7.199.1.json',
			manifestFor([
				{
					prNumber: null,
					order: 0,
					path: FRAGMENT_PATH,
					sha256: hexDigest('archived skills-frontmatter fragment bytes'),
				},
			]),
		);

		const { entries } = collect(root);

		// Observable contract floor: non-throw plus the archived path reported
		// exactly once among the resolved entries. Whether the entry also
		// carries an archived/consumed marker or reconstructed content is not
		// pinned by this spec — that is the fix's design freedom.
		expect(entries).toHaveLength(1);
		expect(entries[0]?.filePath).toBe(FRAGMENT_PATH);
	});

	test('stays fail-closed when no archived manifest claims the unavailable fragment', () => {
		// The archived-claim path must not become a blanket suppressor: a
		// manifest that claims some OTHER fragment does not vouch for this
		// path, so the unavailable-fragment error must still throw.
		// GREEN at base and must stay GREEN after the fix.
		const root = fixtureRoot();
		put(
			root,
			'docs/releases/manifests/v7.199.1.json',
			manifestFor([
				{
					prNumber: null,
					order: 0,
					path: 'docs/releases/pending/some-other-fragment.md',
					sha256: hexDigest('other fragment bytes'),
				},
			]),
		);

		expect(() => collect(root)).toThrow(/is unavailable/);
	});

	test('stays fail-closed when the archived claim carries a malformed digest', () => {
		// Bytes-integrity leg. A true cross-source sha mismatch (claim digest
		// vs the bytes the candidate PR shipped) is not encodable at this seam
		// — candidate PR file listings carry no hashes — so the strongest
		// assertable integrity guard is that a claim whose sha256 is not a
		// well-formed 64-hex digest must NOT satisfy provenance.
		// GREEN at base and must stay GREEN after the fix.
		const root = fixtureRoot();
		put(
			root,
			'docs/releases/manifests/v7.199.1.json',
			manifestFor([
				{
					prNumber: null,
					order: 0,
					path: FRAGMENT_PATH,
					sha256: 'not-a-hex-digest',
				},
			]),
		);

		expect(() => collect(root)).toThrow(/is unavailable/);
	});
});
