import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Repo root is four levels up from tests/unit/scripts/ci/.
const REPO_ROOT = join(import.meta.dir, '../../../..');
const GENERAL_LEDGER_PATH = join(REPO_ROOT, 'scripts/ci/quarantined-tests.txt');
const MACOS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-macos.txt',
);
const WINDOWS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-windows.txt',
);
const INTEGRATION_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-integration-tests.txt',
);

// Originally three paths quarantined by issue #2740 (merge-group flake
// run 34726206593; the ubuntu-latest flake landed in the general ledger —
// no ubuntu-specific ledger exists, #2368 dispatch-lanes precedent — and
// the two macos-latest flakes landed in the macOS ledger per the
// windows-ledger re-add policy in docs/testing/test-stability.md).
//
// DISPOSITION (2026-11-12): ALL THREE #2740 paths are now retired from
// every ledger per issue #2973 (collated trace) —
//   - promote-registration: retired 2026-09-27 by #2973 (canonical
//     mkdtemp + safeRmRecursive teardown landed in the retiring PR);
//   - evidence-summary-adversarial: re-quarantined per #3261 (2026-10-14,
//     run 38623951150, ubuntu-latest unit-shard 3 heap-growth probe) and
//     un-quarantined again 2026-11-12;
//   - bun-compat-exit-first-2530: retired by #2973 (2026-09-27), re-added
//     per #3248 (fresh merge-group macos-latest hard-failure evidence,
//     runs 38449931439 + 38421990284), and un-quarantined again
//     2026-11-12.
// Each row below pins the retired-absence shape: absent from its last
// owning ledger, absent from every other ledger, and still present on
// disk so CI keeps running it. Re-adding any of them requires fresh
// merge-group failure evidence per the #1782 convention.
const ISSUE_2740_RETIRED_PATHS: ReadonlyArray<{
	path: string;
	expectedLedger: string;
}> = [
	{
		path: 'tests/unit/commands/promote-registration.test.ts',
		expectedLedger: MACOS_LEDGER_PATH,
	},
	{
		path: 'tests/unit/services/evidence-summary-adversarial.test.ts',
		expectedLedger: GENERAL_LEDGER_PATH,
	},
	{
		path: 'tests/unit/utils/bun-compat-exit-first-2530.test.ts',
		expectedLedger: MACOS_LEDGER_PATH,
	},
];

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first; no trimming — ci.yml's grep/comm matching is
// exact, so a whitespace-padded entry must fail here just as it silently
// fails to exclude in CI.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

describe('ci.yml integration — quarantine ledger entries for issue #2740', () => {
	test.each(
		ISSUE_2740_RETIRED_PATHS,
	)('$path is retired from its last owning ledger (#2973 un-quarantine 2026-11-12)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// Retirement contract: the path must stay ABSENT from the ledger
		// that last owned it; re-adding it would silently skip the file on
		// that OS / job without fresh merge-group failure evidence.
		expect(existsSync(expectedLedger)).toBe(true);
		expect(activeEntries(expectedLedger)).not.toContain(quarantinedPath);
	});

	test.each(
		ISSUE_2740_RETIRED_PATHS,
	)('$path is absent from every other ledger (no cross-ledger duplicate)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// Cross-ledger duplicates would falsely imply OS-specific or
		// integration evidence: retirement must not become a cross-ledger
		// migration, so the other three ledgers must not hold the path
		// either (the general ledger applies on every RUNNER_OS, the
		// per-OS ledgers on their named OS, the integration ledger for the
		// `integration` job — per the "Collect and partition test files"
		// step).
		const otherLedgers = [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			WINDOWS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		].filter((ledger) => ledger !== expectedLedger);
		for (const ledger of otherLedgers) {
			expect(activeEntries(ledger)).not.toContain(quarantinedPath);
		}
	});

	test.each(
		ISSUE_2740_RETIRED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path: quarantinedPath,
	}) => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated
		// set would never exclude it (the path never appears in all-tests.txt)
		// and the flake-detection workflow would keep re-filing. The unit
		// discovery chain globs tests/unit/**/*.test.ts, so the on-disk file
		// must exist at exactly the ledger path relative to the repo root —
		// existence is what keeps the now-ungated file running in CI.
		expect(existsSync(join(REPO_ROOT, quarantinedPath))).toBe(true);
	});
});
