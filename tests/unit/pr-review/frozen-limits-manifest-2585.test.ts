/**
 * Issue #2585 (Roadmap H8) — C18 / AC12 frozen-limits drift guard.
 *
 * The controlled-failure fixtures (R12 abort recovery, R14 evidence-read
 * repair) import their numeric ceilings from
 * `tests/helpers/pr-review-frozen-limits.ts` and assert measured totals
 * against them. `.agents/issue-traces/2585-default-path-pr-review-completion/
 * repro/frozen-limits.json` is the COMMITTED manifest of the same values under
 * identical key names — the trace's frozen evaluation basis. This suite
 * deep-equals the two, so the helper can never drift from the manifest the
 * acceptance evidence was frozen against.
 *
 * Pure reads only: no mocks, no seams, no clock, no temp directories.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PR_REVIEW_FROZEN_LIMITS } from '../../helpers/pr-review-frozen-limits.js';

const MANIFEST_RELATIVE_PATH = path.join(
	'tests',
	'fixtures',
	'pr-review',
	'frozen-limits.json',
);

function readFrozenLimitsManifest(): Record<string, unknown> {
	// import.meta.dir = <repo>/tests/unit/pr-review — resolve up to the repo
	// root, then into the committed fixture (a tracked copy of the trace
	// manifest at .agents/issue-traces/.../repro/frozen-limits.json, which is
	// git-excluded and therefore not CI-visible).
	const manifestPath = path.resolve(
		import.meta.dir,
		'..',
		'..',
		'..',
		MANIFEST_RELATIVE_PATH,
	);
	return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
		string,
		unknown
	>;
}

describe('frozen limits manifest — helper == committed manifest (issue #2585 C18/AC12)', () => {
	test('the helper constants deep-equal the committed manifest values', () => {
		const manifest = readFrozenLimitsManifest();
		expect(manifest).toEqual({ ...PR_REVIEW_FROZEN_LIMITS });
	});

	test('the manifest carries exactly the helper key names — no extras, no missing', () => {
		const manifest = readFrozenLimitsManifest();
		expect(Object.keys(manifest).sort()).toEqual(
			Object.keys(PR_REVIEW_FROZEN_LIMITS).sort(),
		);
	});

	test('every frozen ceiling is a positive integer (a null/0 cannot pass as generous)', () => {
		for (const [key, value] of Object.entries(PR_REVIEW_FROZEN_LIMITS)) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
			expect(key.length).toBeGreaterThan(0);
		}
	});

	test('each limit family names its own dimension: abort-recovery vs evidence-repair', () => {
		expect(
			Object.keys(PR_REVIEW_FROZEN_LIMITS).filter((k) =>
				k.startsWith('MAX_ABORT_RECOVERY_'),
			).length,
		).toBe(3);
		expect(
			Object.keys(PR_REVIEW_FROZEN_LIMITS).filter((k) =>
				k.startsWith('MAX_EVIDENCE_REPAIR_'),
			).length,
		).toBe(3);
	});
});
