import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2730 quarantine disposition.
//
// Issue #2730 listed 4 candidates from a merge-group flake-detection run
// (CI run 34670762927, head 1499a74b, 2026-09-12T04:27:48Z → 04:34:14Z).
// Their dispositions, after the 2026-11-12 un-quarantine per issue #2973
// (collated trace; re-anchors to #3218/#2973):
//   - tests/unit/hooks/pr-feedback-scope-controller.test.ts
//     (macos-latest unit-shard 1, passed-on-retry flake — was quarantined in
//     scripts/ci/quarantined-tests-macos.txt and re-anchored 2026-11-12 with
//     OWNER #2973 / EXPIRY 2026-12-20; RETIRED on 2026-11-16 when the macOS
//     ledger reached zero active entries — the assertion below pins absence)
//   - tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts
//     (macos-latest unit-shard 1, hard fail — was quarantined in
//     scripts/ci/quarantined-tests-macos.txt by issue #2738, commit
//     ad8c53ae3; RETIRED when the #2738 process-group SIGKILL root fix
//     landed — pinned ABSENT, see the describe block below)
//   - tests/unit/telemetry/init-rehome.test.ts
//     (ubuntu-latest coverage-shard 3, passed-on-retry flake — was
//     quarantined in the GENERAL ledger by issue #2660 / PR #2799;
//     RETIRED 2026-11-12 per the #2973 un-quarantine — now pinned ABSENT
//     from every ledger)
//   - tests/unit/utils/bun-compat-exit-first-2530.test.ts
//     (macos-latest unit-shard 5, hard fail both attempts — quarantined
//     by issue #2740 / PR #2769, re-added per #3248, and finally RETIRED
//     2026-11-12 per the #2973 un-quarantine — now pinned ABSENT from
//     every ledger)
//
// Each pinning test below reads the real ledger files off disk: active
// entries are asserted present exactly once in the correct ledger with
// their OWNER/EXPIRY metadata block (issue #2477 Check 7); retired paths
// are asserted absent from every ledger while still existing on disk.

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

const PR_FEEDBACK_SCOPE_CONTROLLER =
	'tests/unit/hooks/pr-feedback-scope-controller.test.ts';
const INIT_REHOME = 'tests/unit/telemetry/init-rehome.test.ts';
const BUN_COMPAT_EXIT_FIRST =
	'tests/unit/utils/bun-compat-exit-first-2530.test.ts';
const REPO_VALIDATION_REAL_PROCESS_2675 =
	'tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts';

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

describe('ci.yml integration — quarantine ledger disposition for issue #2730 merge-group flake detection', () => {
	describe('pr-feedback-scope-controller.test.ts (macos-latest, unit-shard 1) — retired by the 2026-11-16 #2973 un-quarantine', () => {
		test('is retired — NOT an active entry in the macOS ledger', () => {
			// The 2026-09-12 passed-on-retry flake (CI run 34670762927) had its
			// attempt-1 evidence recovered from the run's repository-validation
			// artifact: the race test expected exactly one fulfilled Task call
			// and received zero — a shared fail-closed pre-consumption transient
			// can reject BOTH racing calls without violating the exactly-once
			// reservation. The race test was determinism-hardened in the retiring
			// PR (bounded attempt-counted re-race + designed-loser reason pin)
			// and a transient-semantics spec pins the fail-closed non-destructive
			// behavior. Un-quarantined 2026-11-16 per issue #2973; re-adding
			// requires fresh merge-group macos-latest failure evidence per the
			// #1782 convention (the per-attempt validation artifact carries
			// attempt-1 stderr).
			expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(
				PR_FEEDBACK_SCOPE_CONTROLLER,
			);
		});

		test('is absent from the general, windows, and integration ledgers', () => {
			// Retirement must not become a cross-ledger migration.
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
				PR_FEEDBACK_SCOPE_CONTROLLER,
			);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
				PR_FEEDBACK_SCOPE_CONTROLLER,
			);
			if (existsSync(INTEGRATION_LEDGER_PATH)) {
				expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
					PR_FEEDBACK_SCOPE_CONTROLLER,
				);
			}
		});

		test('the retired path exists on disk and is discovered by the ci.yml find chain', () => {
			expect(existsSync(join(REPO_ROOT, PR_FEEDBACK_SCOPE_CONTROLLER))).toBe(
				true,
			);
		});
	});

	describe('init-rehome.test.ts (ubuntu-latest, coverage-shard 3) — retired by the 2026-11-12 #2973 un-quarantine', () => {
		test('is retired — NOT an active entry in the GENERAL ledger', () => {
			// The coverage job runs ubuntu-only and honors ONLY the general
			// ledger (run-coverage-gate.sh never branches per-OS). The
			// #2660-owned entry was un-quarantined 2026-11-12 per issue
			// #2973 (collated trace): the general ledger no longer
			// suppresses the file and the ubuntu coverage shards must keep
			// running it.
			expect(existsSync(GENERAL_LEDGER_PATH)).toBe(true);
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(INIT_REHOME);
		});

		test('is absent from every per-OS and integration ledger (no cross-ledger migration)', () => {
			// Retirement must not become a cross-ledger migration: these
			// ledgers never held the entry, and the un-quarantine must not
			// leave a stray duplicate behind.
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			if (existsSync(INTEGRATION_LEDGER_PATH)) {
				expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
					INIT_REHOME,
				);
			}
		});

		test('the retired path exists on disk and is discovered by the ci.yml find chain', () => {
			expect(existsSync(join(REPO_ROOT, INIT_REHOME))).toBe(true);
		});
	});

	describe('bun-compat-exit-first-2530.test.ts (macos-latest, unit-shard 5, hard fail) — retired by the 2026-11-12 #2973 un-quarantine', () => {
		test('is retired — NOT an active entry in the macOS ledger', () => {
			// Quarantined by #2740, retired by #2973 on 2026-09-27, re-added
			// per #3248 (fresh merge-group macos-latest hard-failure
			// evidence), and finally un-quarantined 2026-11-12 per issue
			// #2973 (collated trace). The macOS unit shards must keep
			// running the file; re-adding it again requires fresh
			// merge-group macos-latest failure evidence per the #1782
			// convention.
			expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(
				BUN_COMPAT_EXIT_FIRST,
			);
		});

		test('is absent from the general, windows, and integration ledgers', () => {
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
				BUN_COMPAT_EXIT_FIRST,
			);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
				BUN_COMPAT_EXIT_FIRST,
			);
			if (existsSync(INTEGRATION_LEDGER_PATH)) {
				expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
					BUN_COMPAT_EXIT_FIRST,
				);
			}
		});

		test('the retired path exists on disk and is discovered by the ci.yml find chain', () => {
			expect(existsSync(join(REPO_ROOT, BUN_COMPAT_EXIT_FIRST))).toBe(true);
		});
	});

	describe('repository-validation-real-process-2675.test.ts (retired from quarantine by issue #2738)', () => {
		test('is NOT duplicated into the general or windows ledgers', () => {
			// Issue #2730 listed this path while it was an active macOS
			// entry via issue #2738 (commit ad8c53ae3, 2026-09-12). The
			// #2738 root fix (process-group SIGKILL + survival detection)
			// retired the entry, and retirement must not become a
			// cross-ledger migration.
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
				REPO_VALIDATION_REAL_PROCESS_2675,
			);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
				REPO_VALIDATION_REAL_PROCESS_2675,
			);
		});

		test('is retired from the macOS ledger (issue #2738 root fix landed)', () => {
			// Retirement contract: the crash fixture now terminates the
			// authority-spawned `bun test` process group (kill -KILL 0) and
			// the test fails with an explicit child-survived diagnostic if
			// the termination ever misses again — the quarantine's stated
			// retirement criterion (scripts/ci/quarantined-tests-macos.txt,
			// issue #2738 EXPIRY 2026-11-18). The entry must stay ABSENT;
			// re-adding it would silently skip the crash-classification arm
			// on macOS CI.
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(
				REPO_VALIDATION_REAL_PROCESS_2675,
			);
		});
	});
});
