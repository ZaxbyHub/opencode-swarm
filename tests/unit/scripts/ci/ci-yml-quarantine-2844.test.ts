import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2844 quarantine entry.
//
// Issue #2844 was auto-filed by the merge-group flake-detection workflow
// (#1782) after CI run 35422590582 (merge_group pr-2837, head
// bdeba4456f2cdf053368e2114a8f93f9f06cb173, 2026-09-19T04:55:50Z,
// run_attempt 1) produced one hard-failure annotation:
//   ::error file=tests/unit/commands/close-active-state-unlink-retry.test.ts::FAILED
// The failing cell was `unit (windows-latest, 2)` — the test's 5th case
// (`releases Bun query-cache handles before deleting a closed project
// database`) failed 3/3 in-job attempts with `EBUSY` from `rmSync` in the
// `finally` teardown against temp dirs close-query-cache-{LJAU9T,FjJVqP,Hj4dmS}
// (artifact repository-validation-unit-windows-latest-2/unit-shard-2-117.json).
// Sibling ubuntu-latest-4 (686ms) and macos-latest-4 (327ms) cells ran the
// same file green in the same run — single-OS evidence, so the entry goes in
// the Windows ledger (scripts/ci/quarantined-tests-windows.txt) only.
//
// Each pinning test reads the real ledger files off disk and asserts the
// entry is present in the correct ledger and absent from the others, that
// its comment block carries the OWNER/EXPIRY metadata required by
// check:invariants Check 7 (issue #2477), that the on-disk test file exists
// at exactly the ledger path, and that the STATUS header count stays honest.

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
const QUARANTINED_PATH =
	'tests/unit/commands/close-active-state-unlink-retry.test.ts';

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

// Collect the contiguous comment block directly above an entry (issue #2477
// metadata grammar: `# OWNER:` / `# EXPIRY:` must sit in that block).
function commentBlockAbove(ledgerPath: string, entry: string): string {
	const lines = readFileSync(ledgerPath, 'utf8')
		.replace(/\r\n/g, '\n')
		.split('\n');
	const entryIdx = lines.findIndex((line) => line.trim() === entry);
	if (entryIdx === -1) return '';
	const blockAbove: string[] = [];
	for (let i = entryIdx - 1; i >= 0; i -= 1) {
		const above = lines[i] ?? '';
		if (above.trim() === '' || /^\s*#/.test(above)) {
			blockAbove.push(above);
		} else {
			break;
		}
	}
	return blockAbove.reverse().join('\n');
}

describe('ci.yml integration — windows quarantine ledger entry for close-active-state-unlink-retry (issue #2844)', () => {
	test('close-active-state-unlink-retry.test.ts is an active entry in the windows ledger', () => {
		// Regression guard for issue #2844: without the quarantine entry, the
		// windows-latest merge-group shards keep running this file and the
		// flake-detection workflow re-files duplicate issues (rule A only
		// drops candidates already present in a ledger).
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(QUARANTINED_PATH);
	});

	test('the entry is scoped to the windows ledger only (single-OS evidence)', () => {
		// The #2844 flake was windows-latest-only with green ubuntu/macos
		// siblings, so the entry must NOT suppress the file on other OSes:
		// the general ledger applies on every RUNNER_OS and the macos ledger
		// on macOS runners (see the "Collect and partition test files" step).
		expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
			QUARANTINED_PATH,
		);
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

	test('the entry carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
		// check:invariants Check 7 requires every active quarantine entry to
		// carry `# OWNER:` and `# EXPIRY: YYYY-MM-DD` in the comment block
		// directly above it; a missing block fails the gate and would block
		// this very PR's CI, so the pinning test re-asserts the grammar.
		const block = commentBlockAbove(WINDOWS_LEDGER_PATH, QUARANTINED_PATH);
		expect(block).toContain('# OWNER:');
		expect(block.match(/#\s*EXPIRY:\s*\d{4}-\d{2}-\d{2}/) !== null).toBe(
			true,
		);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count in a
		// "# STATUS: N active entr(y|ies)" header line. Drift between the
		// declared count and the actual active-entry count (e.g. an entry
		// removed without updating the header, or a count bumped without the
		// matching entries) makes the header lie to triage. Note: this only
		// catches count drift; the presence test above is the cross-PR
		// overwrite guard.
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
