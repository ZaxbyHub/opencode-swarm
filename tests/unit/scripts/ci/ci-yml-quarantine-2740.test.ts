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

// Three paths quarantined by issue #2740. The merge-group flake-detection
// workflow (#1782) flagged all three with `Passed on retry` annotations in
// run 34726206593; per the recipe in
// .hermes/skills/auto-fix-issue/references/flaky-test-quarantine.md, the
// ubuntu-latest flake lands in the general ledger (no ubuntu-specific ledger
// exists; #2368 dispatch-lanes precedent) and the two macos-latest flakes
// land in the macOS ledger (windows ledger re-add policy requires a windows
// merge-group confirmed failure; sibling OS shards were green).
const ISSUE_2740_QUARANTINED_PATHS: ReadonlyArray<{
	path: string;
	expectedLedger: string;
}> = [
	{
		path: 'tests/unit/services/evidence-summary-adversarial.test.ts',
		expectedLedger: GENERAL_LEDGER_PATH,
	},
	{
		path: 'tests/unit/utils/bun-compat-exit-first-2530.test.ts',
		expectedLedger: MACOS_LEDGER_PATH,
	},
	{
		path: 'tests/unit/commands/promote-registration.test.ts',
		expectedLedger: MACOS_LEDGER_PATH,
	},
];

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first so the assertion holds on any checkout config.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line))
		.map((line: string) => line.trim());
}

describe('ci.yml integration — quarantine ledger entries for issue #2740', () => {
	test.each(
		ISSUE_2740_QUARANTINED_PATHS,
	)('$path is an active entry in its ledger', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// Regression guard for issue #2740: the merge-group flake-detection
		// workflow (#1782) auto-filed all three paths as flaky candidates.
		// Without these entries, Rule A would re-file duplicate issues on
		// every detection (it only drops candidates already present in a
		// ledger) and the unit/coverage shards would keep flaking.
		expect(existsSync(expectedLedger)).toBe(true);
		expect(activeEntries(expectedLedger)).toContain(quarantinedPath);
	});

	test.each(
		ISSUE_2740_QUARANTINED_PATHS,
	)('$path is scoped to its ledger only (no cross-ledger duplicate)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// Cross-ledger duplicates would falsely imply OS-specific or
		// integration evidence: the evidence-summary flake is
		// single-detection on ubuntu-latest (general ledger applies on
		// every RUNNER_OS), and the two macOS flakes must NOT suppress the
		// files on other OSes (the macOS ledger applies on macOS runners
		// only, per the "Collect and partition test files" step).
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
		ISSUE_2740_QUARANTINED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path: quarantinedPath,
	}) => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated
		// set would never exclude it (the path never appears in all-tests.txt)
		// and the flake-detection workflow would keep re-filing. The unit
		// discovery chain globs tests/unit/**/*.test.ts, so the on-disk file
		// must exist at exactly the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, quarantinedPath))).toBe(true);
	});
});
