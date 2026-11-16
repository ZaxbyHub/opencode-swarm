import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Repo root is four levels up from tests/unit/scripts/ci/.
const REPO_ROOT = join(import.meta.dir, '../../../..');
const WINDOWS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-windows.txt',
);
const GENERAL_LEDGER_PATH = join(REPO_ROOT, 'scripts/ci/quarantined-tests.txt');
const MACOS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-macos.txt',
);
const INTEGRATION_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-integration-tests.txt',
);

// One path quarantined for issue #2867. Of the two #2867 candidates
// auto-filed by the merge-group flake-detection workflow (issue #1782)
// from CI run 35491073606 (merge_group, head cffc439a,
// 2026-09-20T05:12:12Z) and surfaced via flake-detection run 35492561496
// (2026-09-20T05:47:22Z), both were single-OS windows-latest flakes with
// green ubuntu-1..6 / macos-1..6 / the-other-windows-shards siblings in
// the same CI run. The second candidate
// (`delegation-gate-background-coder.test.ts`, quarantined in the windows
// ledger) is a CORE-TREE entry per detector rule C (`tests/unit/hooks/**`);
// the review at quarantine time confirmed a real assertion flake (not an
// infra signature) with all sibling OS shards green, so placement was the
// windows ledger (single-OS evidence) rather than the general ledger
// (which would falsely imply cross-OS flake by suppressing the file on
// every RUNNER_OS).
//
// DISPOSITION (2026-11-12): the entry was un-quarantined per issue #2973
// (collated trace) — its observer-timing failure was never reproduced
// post-observation. The pinning tests below assert the retired-absence
// shape: absent from the windows ledger and every other ledger, with the
// on-disk file still existing so CI keeps running it. Re-adding it
// requires a fresh merge-group windows-latest failure per the #1782
// convention.
//
// The first candidate (`close-active-state-unlink-retry.test.ts`) was
// never quarantined by this issue: its teardown root cause was fixed on
// main by e7d227ab3 (PR #2862 review round, 2026-09-20 — safeRmRecursive
// EBUSY-retry migration, explicitly naming this file as the
// "pre-existing Windows-flaky" case), and the windows ledger's re-add
// policy forbids entries whose failure class has a root fix in-tree.
//
// Wrapped in object literals so `test.each`'s `$path` template
// interpolates the actual path into each test title (a primitive-string
// table renders the literal `$path` string for every iteration, masking
// which path failed; sibling pinning tests like
// ci-yml-quarantine-2812.test.ts and ci-yml-quarantine-2761.test.ts use
// the same destructured object form).
const ISSUE_2867_RETIRED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/hooks/delegation-gate-background-coder.test.ts' },
];

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first; no trimming — ci.yml's grep/comm matching
// is exact, so a whitespace-padded entry must fail here just as it
// silently fails to exclude in CI.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

describe('ci.yml integration — windows quarantine ledger entries for issue #2867', () => {
	test.each(
		ISSUE_2867_RETIRED_PATHS,
	)('$path is retired — NOT an active entry in the windows ledger', ({
		path,
	}) => {
		// Retirement guard for the #2973 un-quarantine (2026-11-12): the
		// entry must stay ABSENT so the attributed windows-latest unit
		// shards keep running the file; re-adding it requires a fresh
		// merge-group windows-latest failure per the #1782 convention.
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(path);
	});

	test.each(
		ISSUE_2867_RETIRED_PATHS,
	)('$path is absent from every other ledger (no cross-ledger migration)', ({
		path,
	}) => {
		// Retirement must not become a cross-ledger migration: the general
		// ledger applies on every RUNNER_OS, the macOS ledger on macOS
		// runners, and the integration ledger for the `integration` job —
		// none of them may hold the retired path.
		for (const ledger of [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		]) {
			expect(activeEntries(ledger)).not.toContain(path);
		}
	});

	test.each(
		ISSUE_2867_RETIRED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path,
	}) => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23
		// gated set would never exclude it (the path never appears in
		// all-tests.txt) and the flake-detection workflow would keep
		// re-filing. The unit discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at
		// exactly the ledger path relative to the repo root — existence
		// is what keeps the now-ungated file running in CI.
		expect(existsSync(join(REPO_ROOT, path))).toBe(true);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry
		// count in a "# STATUS: N active entr(y|ies)" header line. Drift
		// between the declared count and the actual active-entry count
		// (e.g. an entry removed without updating the header, or a count
		// bumped without the matching entries) makes the header lie to
		// triage. Note: this only catches count drift; the presence
		// tests above are the cross-PR overwrite guard. Post-2026-11-12
		// count is 3 (the re-anchored #3218 archive + archive-dry-run
		// pair and the #2973 dispatch-lanes entry; the #2867 cohort was
		// un-quarantined per issue #2973).
		const raw = readFileSync(WINDOWS_LEDGER_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		const statusMatches = [
			...raw.matchAll(/^#\s*STATUS:\s*(\d+)\s+active entr/gm),
		];
		expect(statusMatches.length).toBe(1);
		const declared = Number(statusMatches[0]?.[1]);
		expect(declared).toBe(activeEntries(WINDOWS_LEDGER_PATH).length);
	});
});
