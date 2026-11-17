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
const ALL_LEDGER_PATHS: ReadonlyArray<string> = [
	GENERAL_LEDGER_PATH,
	MACOS_LEDGER_PATH,
	WINDOWS_LEDGER_PATH,
	INTEGRATION_LEDGER_PATH,
];

// The seven paths quarantined for the issue #3264 merge-group flake cohort
// (Oct 2026), each attributed to its exact triggering run/shard/OS via the
// check-run annotations API across the eleven 2026-10-14..20 merge-group
// runs.
//
// DISPOSITION (2026-11-12, per issue #2973's collated trace): six of the
// seven were un-quarantined —
//   - five windows-latest flakes (test-runner-feedback-regressions,
//     state-locking, runner-failures, coder-settlement-2214-hardening —
//     plus the j02-era cohort retired alongside them) from the windows
//     ledger;
//   - one macos-latest passed-on-retry flake
//     (plan/manager-current-phase-2532) from the macos ledger;
//   - one ubuntu-latest passed-on-retry flake (plan-sync-worker) from the
//     general ledger (ubuntu has no per-OS ledger and the coverage gate
//     honors only the general ledger — issue #2660 precedent).
// These six are pinned with the retired-absence shape below: absent from
// EVERY ledger and still present on disk so CI keeps running them.
//
// The seventh — tests/unit/commands/archive.test.ts — was re-anchored
// 2026-11-12 under the #3218 disposition and RETIRED 2026-11-16 per
// issues #2973 + #3218 (determinism hardening landed in the re-anchoring
// PR; the entry criterion of 2 consecutive green windows-latest
// merge-group runs accumulates from the retiring PR's own queue run) —
// now pinned with the retired-absence shape below.
//
// Wrapped in object literals so `test.each`'s `$path` template
// interpolates the actual path into each test title (sibling pinning
// tests ci-yml-quarantine-2761/2812/2867/3263 use the same destructured
// object form).
const RETIRED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/tools/test-runner-feedback-regressions.test.ts' },
	{ path: 'tests/unit/full-auto/state-locking.test.ts' },
	{ path: 'tests/unit/evaluation/runner-failures.test.ts' },
	{ path: 'tests/unit/workflow/coder-settlement-2214-hardening.test.ts' },
	{ path: 'tests/unit/plan/manager-current-phase-2532.test.ts' },
	{ path: 'tests/unit/background/plan-sync-worker.test.ts' },
	{ path: 'tests/unit/commands/archive.test.ts' },
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

describe('ci.yml integration — quarantine ledger entries for issue #3264', () => {
	test.each(
		RETIRED_PATHS,
	)('$path is retired — NOT an active entry in any ledger', ({ path }) => {
		// Retirement guard for the #2973 un-quarantine (2026-11-12): the
		// entry must stay ABSENT from its former owning ledger and every
		// other ledger so the attributed merge-group unit/coverage shards
		// keep running the file; re-adding any of them requires fresh
		// merge-group failure evidence per the #1782 convention. Every
		// ledger must exist so the negative assertion cannot pass
		// vacuously.
		for (const ledger of ALL_LEDGER_PATHS) {
			expect(existsSync(ledger)).toBe(true);
			expect(activeEntries(ledger)).not.toContain(path);
		}
	});

	test.each(
		RETIRED_PATHS,
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
		// The windows ledger's re-add policy tracks its active entry count
		// in a "# STATUS: N active entries" header line. Post-2026-11-16
		// count is 0 (the three re-anchors retired per #2973 + #3218);
		// drift between the
		// declared count and the actual active-entry count (e.g. an
		// entry removed without updating the header, or a count bumped
		// without the matching entries) makes the header lie to triage.
		// Note: this only catches count drift; the presence tests above
		// are the cross-PR overwrite guard.
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

	test('same-basename sibling tests/unit/evidence/archive.test.ts is NOT quarantined', () => {
		// Same-basename trap: the retired entry owned
		// tests/unit/commands/archive.test.ts (#3218), NOT
		// tests/unit/evidence/archive.test.ts. The evidence-flavour
		// archive test has no flake evidence and must stay in every
		// gated set — a glob or basename-based quarantine would silently
		// stop CI running it on all OSes.
		for (const ledger of ALL_LEDGER_PATHS) {
			expect(activeEntries(ledger)).not.toContain(
				'tests/unit/evidence/archive.test.ts',
			);
		}
	});
});
