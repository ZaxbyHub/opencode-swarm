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

// Three paths quarantined by THIS PR for issue #2812. Of the six #2812
// candidates auto-filed by the merge-group flake-detection workflow (#1782)
// after CI run 35113965170 (merge_group pr-2765, head 16f82fcec19271f6,
// 2026-09-16T15:14:18Z), three were already on the windows ledger from
// PR #2774 (pr-subscriptions-checkpoint.test.ts and
// recall-evaluation-profile-isolation.test.ts) or routed to the general
// ledger by PR #2811's CORE-TREE placement
// (pr-workflow-gate-batch-gc.test.ts, tests/unit/hooks/** per detector
// rule C). This PR adds the remaining three as net-new windows-ledger
// entries because all three were single-OS windows-latest flakes with
// green ubuntu 1..6 / macos 1..6 siblings in the same CI run, which the
// windows-ledger re-add policy in scripts/ci/quarantined-tests-windows.txt
// routes to the windows ledger.
//
// Wrapped in object literals so `test.each`'s `$path` template interpolates
// the actual path into each test title (a primitive-string table renders
// the literal `$path` string for every iteration, masking which path
// failed; sibling pinning tests like ci-yml-quarantine-2740.test.ts and
// ci-yml-quarantine-2761.test.ts use the same destructured object form).
// #2973 retirement (2026-09-27): all five #2812 windows entries were retired
// (phase-complete.lock-adversarial's safeRmRecursive fix had already landed via
// PR #2807; archive + write-receipts-feedback got safeRmRecursive teardown and
// pr-subscriptions-checkpoint + recall-evaluation-profile-isolation got the
// POLLS reduction / per-test floor in the retiring PR). The three former
// entries and the two previously-unpinned rows (pr-subscriptions-checkpoint,
// recall-evaluation-profile-isolation — pinned by no test before this) are all
// absence guards now: no silent re-add without fresh merge-group
// windows-latest failure evidence. tests/unit/commands/archive.test.ts met
// that bar on 2026-10-18 (merge-group run 39138948653, windows-latest shard
// 4, passed-on-retry), was re-added per issue #3264, re-anchored 2026-11-12
// under the #3218 disposition, and finally RETIRED 2026-11-16 per issues
// #2973 + #3218 (determinism hardening landed in PR #3672; the "2
// consecutive green windows-latest merge-group runs" criterion accumulates
// from the retiring PR's own queue run) — its retired-absence pinning now
// lives in ci-yml-quarantine-3264.test.ts.

const ISSUE_2812_RETIRED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/mcp/write-receipts-feedback-2500.test.ts' },
	{ path: 'tests/unit/tools/phase-complete.lock-adversarial.test.ts' },
	{ path: 'tests/unit/background/pr-subscriptions-checkpoint.test.ts' },
	{ path: 'tests/unit/memory/recall-evaluation-profile-isolation.test.ts' },
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

describe('ci.yml integration — windows quarantine ledger entries for issue #2812 (this PR)', () => {
	test.each(
		ISSUE_2812_RETIRED_PATHS,
	)('$path is retired from the windows ledger (#2973)', ({ path }) => {
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(path);
	});

	test('tests/unit/commands/archive.test.ts is retired again — the #3264 re-add ended 2026-11-16 (issues #2973 + #3218)', () => {
		// Lifecycle: retired by #2812's remedies -> re-added per #3264 (fresh
		// 2026-10-18 merge-group windows evidence) -> re-anchored 2026-11-12
		// under #3218 (determinism hardening in PR #3672) -> RETIRED 2026-11-16
		// per issues #2973 + #3218. The full retired-absence pinning (every
		// ledger + on-disk existence) lives in ci-yml-quarantine-3264.test.ts;
		// this guard keeps the #3264-era re-add from silently returning.
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
			'tests/unit/commands/archive.test.ts',
		);
	});

	test.each(
		ISSUE_2812_RETIRED_PATHS,
	)('$path is scoped to the windows ledger only (no cross-ledger duplicate)', ({
		path,
	}) => {
		// Cross-ledger duplicates would falsely imply cross-OS or
		// integration evidence: every #2812 candidate was single-detection
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
		ISSUE_2812_RETIRED_PATHS,
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
		// The windows ledger's re-add policy tracks its active entry count in
		// a "# STATUS: N active entr(y|ies)" header line. Drift between the
		// declared count and the actual active-entry count (e.g. an entry
		// removed without updating the header, or a count bumped without the
		// matching entries) makes the header lie to triage. The assertion is
		// relative (declared == actual), so later cohorts re-growing the
		// ledger (#2826, #2867, #3248, #3264) do not need to touch this
		// file — only the header/entry drift this catches does.
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
