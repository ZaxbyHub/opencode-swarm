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

function fragmentText(root: string, name: string): string | null {
	const pendingFragment = join(root, 'docs/releases/pending', name);
	if (existsSync(pendingFragment)) return readText(pendingFragment);
	const releasesPath = join(root, 'docs/releases');
	if (!existsSync(releasesPath)) return null;
	const parts: string[] = [];
	for (const entry of readdirSync(releasesPath)) {
		if (/^v\d+\.\d+\.\d+\.md$/.test(entry)) {
			parts.push(readText(join(releasesPath, entry)));
		}
	}
	return parts.length > 0 ? parts.join('\n') : null;
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
		// Strength leg (#3511): consumed + unarchived reads as null (the pins
		// above fail); the archive arm carries the citation once materialized.
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
			expect(
				fragmentText(exclusive, 'ci-gate-policy-2552.md'),
			).not.toContain('34162959243');
		} finally {
			rmSync(exclusive, { recursive: true, force: true });
		}
		const archivedDir = canonicalMkdtemp('swarm-ci2552-arch-');
		try {
			mkdirSync(join(archivedDir, 'docs/releases'), { recursive: true });
			writeFileSync(
				join(archivedDir, 'docs/releases/v0.0.0.md'),
				'ci gate policy record cites completing run 34162959243',
			);
			const body = fragmentText(archivedDir, 'ci-gate-policy-2552.md');
			expect(body).toContain('34162959243');
		} finally {
			rmSync(archivedDir, { recursive: true, force: true });
		}
	});
});
