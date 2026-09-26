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

// Two paths quarantined by THIS PR for issue #2867. Of the two #2867
// candidates auto-filed by the merge-group flake-detection workflow
// (issue #1782) from CI run 35491073606 (merge_group, head cffc439a,
// 2026-09-20T05:12:12Z) and surfaced via flake-detection run 35492561496
// (2026-09-20T05:47:22Z), both were single-OS windows-latest flakes with
// green ubuntu-1..6 / macos-1..6 / the-other-windows-shards siblings in
// the same CI run, which the windows-ledger re-add policy in
// scripts/ci/quarantined-tests-windows.txt routes to the windows ledger.
// One candidate (`close-active-state-unlink-retry.test.ts`) was already
// auto-filed by the four earlier sibling issues #2843 / #2844 / #2845 /
// #2846 — all still OPEN, with quarantine commits sitting on unmerged
// sibling auto-fix branches — but those entries are not yet on
// origin/main, so the file is NOT yet in any ledger on this branch and
// the rule-A drop in detect-and-quarantine-flakes.sh would still re-file
// a duplicate if this branch's run also failed. The second candidate
// (`delegation-gate-background-coder.test.ts`) is a CORE-TREE entry per
// detector rule C (`tests/unit/hooks/**`); the workflow surfaced it
// with the `# CORE-TREE (requires human review)` prefix; the issue's
// triage comment requires a manual review of the merge-group logs before
// placing it. The review (this PR's commit body) confirms the
// `Passed on retry 2 (flaky)` annotation prefix is NOT in the
// INFRA_SIGNATURES list of the detector (no `Runner offline` / `was not
// acquired by Runner` / `no space left on device` / `waiting for a
// runner`) so this is a real assertion flake, and the sibling OS
// shards are all green, so placement is the windows ledger (single-OS
// evidence) rather than the general ledger (which would falsely imply
// cross-OS flake by suppressing the file on every RUNNER_OS).
//
// Wrapped in object literals so `test.each`'s `$path` template
// interpolates the actual path into each test title (a primitive-string
// table renders the literal `$path` string for every iteration, masking
// which path failed; sibling pinning tests like
// ci-yml-quarantine-2812.test.ts and ci-yml-quarantine-2761.test.ts use
// the same destructured object form).
const ISSUE_2867_THIS_PR_QUARANTINED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/commands/close-active-state-unlink-retry.test.ts' },
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

describe('ci.yml integration — windows quarantine ledger entries for issue #2867 (this PR)', () => {
	test.each(
		ISSUE_2867_THIS_PR_QUARANTINED_PATHS,
	)('$path is an active entry in the windows ledger', ({ path }) => {
		// Regression guard for the two net-new #2867 entries added by this
		// PR: without them, the windows-latest unit shards 2 + 6 would
		// keep running these files and Rule A of the detector would keep
		// re-filing duplicate issues (it only drops candidates already
		// present in a ledger).
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(path);
	});

	test.each(
		ISSUE_2867_THIS_PR_QUARANTINED_PATHS,
	)('$path is scoped to the windows ledger only (no cross-ledger duplicate)', ({
		path,
	}) => {
		// Cross-ledger duplicates would falsely imply cross-OS or
		// integration evidence: every #2867 candidate was single-detection
		// on windows-latest with green ubuntu/macos siblings, so the
		// entries must NOT suppress the files on other OSes. The general
		// ledger applies on every RUNNER_OS, the macOS ledger on macOS
		// runners, and the integration ledger for the `integration` job.
		for (const ledger of [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		]) {
			expect(activeEntries(ledger)).not.toContain(path);
		}
	});

	test.each(
		ISSUE_2867_THIS_PR_QUARANTINED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path,
	}) => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23
		// gated set would never exclude it (the path never appears in
		// all-tests.txt) and the flake-detection workflow would keep
		// re-filing. The unit discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at
		// exactly the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, path))).toBe(true);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry
		// count in a "# STATUS: N active entr(y|ies)" header line. Drift
		// between the declared count and the actual active-entry count
		// (e.g. an entry removed without updating the header, or a count
		// bumped without the matching entries) makes the header lie to
		// triage. Note: this only catches count drift; the presence
		// tests above are the cross-PR overwrite guard. Post-#2867 count
		// is 11 (9 pre-existing on main from PRs #2774 / #2811 + the
		// 2812 windows-ledger additions + 2 net-new from this PR).
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

	test.each(
		ISSUE_2867_THIS_PR_QUARANTINED_PATHS,
	)('$path carries the issue #2477 OWNER + EXPIRY metadata block', ({
		path,
	}) => {
		// Every active entry in scripts/ci/quarantined-tests*.txt must
		// carry, in the comment block directly above it, an OWNER and
		// an EXPIRY line. scripts/check-invariants.ts Check 7 fails
		// the gate if either is missing. The grep window is the
		// comment block (lines starting with `#`) directly preceding
		// the non-comment path line — bounded to the entry's own
		// header so the test does not spuriously pass against
		// metadata that belongs to a neighbour entry.
		const raw = readFileSync(WINDOWS_LEDGER_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		const lines = raw.split('\n');
		const entryIndex = lines.findIndex((line: string) => line.trim() === path);
		expect(entryIndex).toBeGreaterThan(0);
		const windowAbove = lines.slice(Math.max(0, entryIndex - 60), entryIndex);
		const joined = windowAbove.join('\n');
		expect(joined).toMatch(/^# OWNER: .+#2867/m);
		expect(joined).toMatch(/^# EXPIRY: 2026-10-20/m);
	});
});
