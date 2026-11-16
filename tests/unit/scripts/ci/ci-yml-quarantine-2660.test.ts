import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2660 quarantine entry.
//
// Issue #2660 listed one candidate from a merge-group flake-detection run
// (CI run 34309871068, merge_group, head e2491c3a, 2026-09-09T04:09:35Z):
//   - tests/unit/telemetry/init-rehome.test.ts
//     (ubuntu-latest coverage-shard 1, passed-on-retry flake — placed in
//     the GENERAL ledger because run-coverage-gate.sh never branches
//     per-OS)
//
// DISPOSITION (2026-11-12): the entry was un-quarantined per issue #2973
// (collated trace) — the general ledger is now empty and the path is
// retired from EVERY ledger. The pinning tests below assert the
// retired-absence shape: the path is NOT an active entry in any of the
// three unit ledgers (nor the integration ledger) and the on-disk file
// still exists, so CI keeps running it and a silent re-add cannot hide
// behind a missing file.

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

const INIT_REHOME = 'tests/unit/telemetry/init-rehome.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first; no trimming — ci.yml's grep/comm matching is
// exact, so a whitespace-padded entry must fail here just as it silently
// fails to exclude in CI. No sort -u dedup either: containment checks only
// need membership, and ci.yml dedupes on the CI side at ci.yml:638.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

describe('quarantine ledger entries for issue #2660 merge-group flake detection', () => {
	describe('init-rehome.test.ts (ubuntu-latest, coverage-shard 1)', () => {
		test('is retired — NOT an active entry in the GENERAL ledger', () => {
			// The coverage job runs ubuntu-only and honors ONLY the general
			// ledger (run-coverage-gate.sh rejects per-OS branching — its
			// header at scripts/ci/run-coverage-gate.sh says coverage is
			// ubuntu-only and must never partition by RUNNER_OS). The
			// entry was un-quarantined 2026-11-12 per issue #2973 (collated
			// trace): the flake was not reproduced post-#2660 observation,
			// so the general ledger no longer suppresses it and the
			// ubuntu coverage shards must keep running the file.
			expect(existsSync(GENERAL_LEDGER_PATH)).toBe(true);
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(INIT_REHOME);
		});

		test('is absent from every per-OS and integration ledger (no cross-ledger migration)', () => {
			// Retirement must not become a cross-ledger migration: the
			// macos/windows/integration ledgers never held this entry (the
			// coverage job does not run on those runners), and the
			// 2026-11-12 un-quarantine must not leave a stray duplicate
			// behind. All four ledgers exist on main; assert presence
			// up-front (matching the #2740 pinning test pattern) so a
			// renamed or removed ledger fails loudly instead of silently
			// passing.
			expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
			expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
			expect(existsSync(INTEGRATION_LEDGER_PATH)).toBe(true);
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(INIT_REHOME);
		});

		test('the retired path exists on disk and is discoverable by the ci.yml find chain', () => {
			// A typo'd ledger path would be a silent no-op: CI's
			// `comm -23` gated set would never exclude it (the path never
			// appears in all-tests.txt) and the flake would keep
			// re-filing. The unit discovery chain globs
			// tests/unit/**/*.test.ts, so the on-disk file must exist at
			// exactly the ledger path relative to the repo root —
			// existence at a tests/unit/**/*.test.ts-shaped path is what
			// makes the find chain emit it now that it runs ungated.
			expect(existsSync(join(REPO_ROOT, INIT_REHOME))).toBe(true);
		});
	});
});
