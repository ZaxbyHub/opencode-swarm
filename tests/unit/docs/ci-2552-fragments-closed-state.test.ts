import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../..');
const PENDING_DIR = join(REPO_ROOT, 'docs/releases/pending');

// Every release fragment that references the #2552 merge-queue receipt work.
// The Stage-A receipt set is closed (three receipts recorded, the third being
// Actions run 34162959243), so none of these fragments may keep a
// present-tense claim that the third receipt is still pending or that the
// issue cannot close — such a claim contradicts docs/ci/merge-queue-policy.md
// and would surface verbatim in aggregated release notes.
const FRAGMENTS_2552 = [
	'ci-gate-policy-2552.md',
	'ci-stage-a-decision-2552.md',
	'ci-merge-group-event-scoped-cancellation-2552.md',
	'ci-stage-a-third-receipt-2552.md',
] as const;

function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('#2552 release fragments agree with the closed Stage-A receipt set', () => {
	const fragments = FRAGMENTS_2552.map((name) => ({
		name,
		body: readText(join(PENDING_DIR, name)),
	}));

	test('every #2552 fragment exists under docs/releases/pending', () => {
		const onDisk = new Set(readdirSync(PENDING_DIR));
		for (const name of FRAGMENTS_2552) {
			expect(onDisk.has(name)).toBe(true);
		}
	});

	test('no fragment claims the third Stage-A receipt is still pending', () => {
		for (const { name, body } of fragments) {
			expect(body).not.toMatch(/a third remains\s+pending/i);
			expect(body).not.toMatch(/remains pending/i);
			expect(body).not.toMatch(/remain required before issue #2552 can close/i);
		}
	});

	test('every fragment cites the completing receipt run 34162959243', () => {
		for (const { name, body } of fragments) {
			expect(body).toContain('34162959243');
		}
	});
});
