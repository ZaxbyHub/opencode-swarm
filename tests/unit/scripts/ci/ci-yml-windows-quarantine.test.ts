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
const QUARANTINED_PATH = 'tests/unit/sandbox/win32-wrapper-runtime.test.ts';

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

describe('ci.yml integration — windows quarantine ledger entry for win32-wrapper-runtime (issue #2185)', () => {
	test('win32-wrapper-runtime.test.ts is retired from the windows ledger (#2973)', () => {
		// #2973 retirement (2026-09-27): the #2185 cold-spawn flake's named
		// remedies landed (explicit per-test floor + spawnSync margins +
		// safeRmRecursive teardown), so the entry is removed. This absence
		// guard keeps a silent re-add without fresh merge-group
		// windows-latest failure evidence from passing unnoticed.
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
	});

	test('pr-monitor-status.test.ts is retired from the windows ledger (#2973)', () => {
		// #2973 retirement: the #1982/#2190 entry (freezeClock + EBUSY-retry
		// landed; the planned residual timeout floor was DROPPED — see the PR's
		// deviation disclosure — so the residual default-cap sensitivity stands
		// disclosed, with flake-detection as the safety net). This file was
		// pinned by no other test — it is the likeliest re-add candidate
		// (reproduced live flake), so it gets its own guard.
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
			'tests/unit/commands/pr-monitor-status.test.ts',
		);
	});

	test('the entry is scoped to the windows ledger only (single-OS evidence)', () => {
		// The #2185 flake was windows-latest-only with green ubuntu/macos
		// siblings, so the entry must NOT suppress the file on other OSes:
		// the general ledger applies on every RUNNER_OS and the macos ledger
		// on macOS runners (see the "Collect and partition test files" step).
		expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
		expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
	});

	test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated set
		// would never exclude it (the path never appears in all-tests.txt) and
		// the flake would keep re-filing. The discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at exactly
		// the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, QUARANTINED_PATH))).toBe(true);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count in a
		// "# STATUS: N active entr(y|ies)" header line. Drift between the
		// declared count and the actual active-entry count (e.g. an entry
		// removed without updating the header, or a count bumped without the
		// matching entries) makes the header lie to triage. Post-2026-11-16
		// the ledger holds 0 active entries (the #3248
		// dispatch-lanes-pr-review-resilience-followups entry retired per
		// #2973; the earlier j02/delegation-gate-background-coder renewals
		// un-quarantined 2026-11-12; the #3218 archive pair retired per
		// #2973 + #3218); this test pins the header's declared count against
		// the actual active-entry count, whatever it is.
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
