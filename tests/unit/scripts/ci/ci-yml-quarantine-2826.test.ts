import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning test for the issue #2826 quarantine entry.
//
// Issue #2826 was auto-filed by the merge-group flake-detection workflow
// (#1782) after CI run 35239240597 (merge_group, head
// 27d8196445669c53f45acd65c7acd839aeaeb5c5, 2026-09-17T15:17:17Z). It listed
// one candidate:
//   - tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts
//     (windows-latest unit-shard 3, passed-on-retry-2 flake) -> WINDOWS
//     ledger (scripts/ci/quarantined-tests-windows.txt)
//
// DISPOSITION (2026-11-12): the entry was un-quarantined per issue #2973
// (collated trace) — the windows ledger no longer holds it. The pinning
// test reads the real ledger files off disk and asserts the
// retired-absence shape: the path is NOT an active entry in the windows
// ledger or any other ledger, and the on-disk file exists at exactly the
// ledger path so the windows unit shards keep running it.

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

const ISSUE_2826_QUARANTINED_PATH =
	'tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// Entries are compared UNTRIMMED (CI's grep/comm matching is byte-exact, so a
// whitespace-corrupted entry must fail here too); CRLF is normalized first so
// the assertion holds on any checkout config.
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

describe('ci.yml integration — quarantine ledger entry for issue #2826 merge-group flake detection', () => {
	test(`${ISSUE_2826_QUARANTINED_PATH} is retired — NOT an active entry in the windows ledger`, () => {
		// Retirement guard for the #2973 un-quarantine (2026-11-12): the
		// entry must stay ABSENT so the windows-latest unit shards keep
		// running the file; re-adding it requires a fresh merge-group
		// windows-latest failure per the #1782 convention.
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
			ISSUE_2826_QUARANTINED_PATH,
		);
	});

	test('is absent from every other ledger (no cross-ledger migration)', () => {
		// Retirement must not become a cross-ledger migration: the general
		// ledger applies on every RUNNER_OS, the macos ledger on macOS
		// runners (see the "Collect and partition test files" step in
		// ci.yml), and the integration ledger for the `integration` job —
		// none of them may hold the retired path.
		const otherLedgers = [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		];
		for (const ledger of otherLedgers) {
			expect(activeEntries(ledger)).not.toContain(ISSUE_2826_QUARANTINED_PATH);
		}
	});

	test('the retired path exists on disk and is discovered by the ci.yml find chain', () => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated
		// set would never exclude it (the path never appears in all-tests.txt)
		// and the flake-detection workflow would keep re-filing. The unit
		// discovery chain globs tests/unit/**/*.test.ts, so the on-disk file
		// must exist at exactly the ledger path relative to the repo root —
		// existence is what keeps the now-ungated file running in CI.
		expect(existsSync(join(REPO_ROOT, ISSUE_2826_QUARANTINED_PATH))).toBe(true);
	});
});
