import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const REPO_ROOT = join(import.meta.dir, '../../..');

// Every release fragment that references the #2552 merge-queue receipt work.
// The Stage-A receipt set is closed (three receipts recorded, the third being
// Actions run 34162959243), so none of these fragments may keep a
// present-tense claim that the third receipt is still pending or that the
// issue cannot close — such a claim contradicts docs/ci/merge-queue-policy.md
// and would surface verbatim in aggregated release notes.
//
// Consumption-aware (#3511, the merged-#3507 pattern): each named fragment is
// resolved at TEST time (never describe time — a collection-time read fails
// the whole file when one fragment is consumed) against pending OR the
// materialized docs/releases/vX.Y.Z.md history. Exclusive arms — never a
// union — so a stale re-added same-slug fragment cannot hide behind an older
// archive hit. A fragment missing from BOTH surfaces reads as null and the
// pin fails (never passes vacuously).
const FRAGMENTS_2552 = [
	'ci-gate-policy-2552.md',
	'ci-stage-a-decision-2552.md',
	'ci-merge-group-event-scoped-cancellation-2552.md',
	'ci-stage-a-third-receipt-2552.md',
] as const;

function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** Parse `v?X.Y.Z` into a comparable number; unparseable tags sort lowest. */
function tagOrder(tag: string): number {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	if (!m) return -1;
	return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

/**
 * Consumption-aware fragment resolution (issue #3511; tightened per the
 * #3519 feedback): PENDING is the sole authority while present. Once
 * consumed, the obligation resolves through the fragment's MANIFEST CLAIM —
 * the claiming manifest's tag names the materialized `docs/releases/<tag>.md`
 * body that carries the obligation — never through a name-blind aggregate of
 * every release body (the previous archive arm ignored `name`, so pins could
 * pass for never-consumed fragments: '2505' was satisfied by unrelated
 * history). No claim → null → the pins fail (never vacuous).
 */
function fragmentText(root: string, name: string): string | null {
	const pendingFragment = join(root, 'docs/releases/pending', name);
	if (existsSync(pendingFragment)) return readText(pendingFragment);
	const manifestsDir = join(root, 'docs/releases/manifests');
	if (!existsSync(manifestsDir)) return null;
	const claims: Array<{ tag: string; manifest: string }> = [];
	for (const entry of readdirSync(manifestsDir)) {
		if (!entry.toLowerCase().endsWith('.json')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(manifestsDir, entry), 'utf8'));
		} catch {
			continue;
		}
		const manifest = parsed as {
			schemaVersion?: unknown;
			tag?: unknown;
			fragments?: Array<{ path?: unknown }>;
		};
		if (
			manifest?.schemaVersion !== 1 ||
			!Array.isArray(manifest.fragments) ||
			typeof manifest.tag !== 'string'
		) {
			continue;
		}
		const claimed = manifest.fragments.some(
			(fragment) => fragment?.path === `docs/releases/pending/${name}`,
		);
		if (claimed) claims.push({ tag: manifest.tag, manifest: entry });
	}
	if (claims.length === 0) return null;
	claims.sort(
		(a, b) =>
			tagOrder(b.tag) - tagOrder(a.tag) ||
			(a.manifest < b.manifest ? 1 : a.manifest > b.manifest ? -1 : 0),
	);
	const archivedBody = join(root, 'docs/releases', `${claims[0].tag}.md`);
	if (!existsSync(archivedBody)) return null;
	return readText(archivedBody);
}

describe('#2552 release fragments agree with the closed Stage-A receipt set', () => {
	test('every #2552 fragment resolves on disk (pending or materialized)', () => {
		for (const name of FRAGMENTS_2552) {
			expect(fragmentText(REPO_ROOT, name)).not.toBeNull();
		}
	});

	test('no PENDING fragment claims the third Stage-A receipt is still pending', () => {
		// Authoring invariant (#3511): the negative claims-scan applies only to
		// a fragment's OWN pending text. Once consumed, the resolver returns
		// the aggregated materialized history, where unrelated historical
		// release bodies may legitimately contain the scanned phrases — the
		// consumed-state obligation is the positive citation pin below.
		for (const name of FRAGMENTS_2552) {
			const pendingPath = join(REPO_ROOT, 'docs/releases/pending', name);
			if (!existsSync(pendingPath)) continue;
			const body = readText(pendingPath);
			expect(body).not.toMatch(/a third remains\s+pending/i);
			expect(body).not.toMatch(/remains pending/i);
			expect(body).not.toMatch(/remain required before issue #2552 can close/i);
		}
	});

	test('every fragment cites the completing receipt run 34162959243', () => {
		// Positive pin holds in BOTH states: pending text or, once consumed,
		// the materialized release history (aggregate scan).
		for (const name of FRAGMENTS_2552) {
			const body = fragmentText(REPO_ROOT, name);
			expect(body).not.toBeNull();
			expect(body).toContain('34162959243');
		}
	});

	test('consumption-aware resolution fails closed when neither surface carries a fragment', () => {
		// Strength legs (#3511 + #3519 feedback):
		const neitherDir = canonicalMkdtemp('swarm-ci2552-neither-');
		try {
			expect(fragmentText(neitherDir, 'ci-gate-policy-2552.md')).toBeNull();
		} finally {
			rmSync(neitherDir, { recursive: true, force: true });
		}
		const exclusive = canonicalMkdtemp('swarm-ci2552-excl-');
		try {
			mkdirSync(join(exclusive, 'docs/releases/pending'), {
				recursive: true,
			});
			mkdirSync(join(exclusive, 'docs/releases'), { recursive: true });
			// Exclusive arms (#3511): pending present WITHOUT the citation while
			// a stale archive carries it — pending is the sole authority, so the
			// pin must fail; a UNION resolver would leak the archived citation
			// and pass vacuously (probe-proven shape).
			writeFileSync(
				join(exclusive, 'docs/releases/pending/ci-gate-policy-2552.md'),
				'# gate policy record without the receipt citation',
			);
			writeFileSync(
				join(exclusive, 'docs/releases/v0.0.0.md'),
				'# stale archive citing run 34162959243',
			);
			expect(fragmentText(exclusive, 'ci-gate-policy-2552.md')).not.toContain(
				'34162959243',
			);
		} finally {
			rmSync(exclusive, { recursive: true, force: true });
		}
		const archivedDir = canonicalMkdtemp('swarm-ci2552-arch-');
		try {
			mkdirSync(join(archivedDir, 'docs/releases/manifests'), {
				recursive: true,
			});
			writeFileSync(
				join(archivedDir, 'docs/releases/v0.0.0.md'),
				'ci gate policy record cites completing run 34162959243',
			);
			// The consumed obligation resolves ONLY through the manifest claim:
			// without a claim for this exact path, a stray vX.md must NOT
			// satisfy the pin (the name-blind aggregate defect this round
			// fixes). The fragment stays unresolved → null → pins fail.
			expect(fragmentText(archivedDir, 'ci-gate-policy-2552.md')).toBeNull();
			// With the claim staged, the claiming tag's body carries it.
			writeFileSync(
				join(archivedDir, 'docs/releases/manifests/v0.0.0.json'),
				JSON.stringify({
					schemaVersion: 1,
					tag: 'v0.0.0',
					tagCommit: 'a'.repeat(40),
					targetCommitish: 'a'.repeat(40),
					releaseBodySha256: '0'.repeat(64),
					fragments: [
						{
							prNumber: null,
							order: 0,
							path: 'docs/releases/pending/ci-gate-policy-2552.md',
							sha256: '1'.repeat(64),
						},
					],
				}),
			);
			const body = fragmentText(archivedDir, 'ci-gate-policy-2552.md');
			expect(body).toContain('34162959243');
			// Claim-without-body fails closed: the claiming tag's vX.md missing
			// must not fabricate an obligation.
			rmSync(join(archivedDir, 'docs/releases/v0.0.0.md'));
			expect(fragmentText(archivedDir, 'ci-gate-policy-2552.md')).toBeNull();
		} finally {
			rmSync(archivedDir, { recursive: true, force: true });
		}
		const coexistence = canonicalMkdtemp('swarm-ci2552-coex-');
		try {
			mkdirSync(join(coexistence, 'docs/releases/pending'), {
				recursive: true,
			});
			mkdirSync(join(coexistence, 'docs/releases'), { recursive: true });
			mkdirSync(join(coexistence, 'docs/releases/manifests'), {
				recursive: true,
			});
			// Pending + claim coexistence (re-added fragment with different
			// bytes): pending is the sole authority even when a manifest claims
			// the same path.
			writeFileSync(
				join(coexistence, 'docs/releases/pending/ci-gate-policy-2552.md'),
				'current pending record without the citation',
			);
			writeFileSync(
				join(coexistence, 'docs/releases/v0.0.1.md'),
				'older consumed body citing run 34162959243',
			);
			writeFileSync(
				join(coexistence, 'docs/releases/manifests/v0.0.1.json'),
				JSON.stringify({
					schemaVersion: 1,
					tag: 'v0.0.1',
					tagCommit: 'a'.repeat(40),
					targetCommitish: 'a'.repeat(40),
					releaseBodySha256: '0'.repeat(64),
					fragments: [
						{
							prNumber: null,
							order: 0,
							path: 'docs/releases/pending/ci-gate-policy-2552.md',
							sha256: '2'.repeat(64),
						},
					],
				}),
			);
			expect(fragmentText(coexistence, 'ci-gate-policy-2552.md')).not.toContain(
				'34162959243',
			);
		} finally {
			rmSync(coexistence, { recursive: true, force: true });
		}
	});
});
