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
// The seventh — tests/unit/commands/archive.test.ts — is STILL ACTIVE in
// the windows ledger, re-anchored 2026-11-12 under the #3218 disposition
// (determinism-hardened in the re-anchoring PR: cache invalidation +
// clock pinning + boundary spec; criterion = 2 consecutive green
// windows-latest merge-group runs; EXPIRY 2026-12-20).
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
];
const REANCHORED_PATHS: ReadonlyArray<{ path: string }> = [
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

// Collect the contiguous comment block directly above an active entry,
// the same walk scripts/check-invariants.ts Check 7 performs: break at
// the first blank OR non-comment line (a blank line between an entry and
// its metadata block must fail the walk exactly as it fails Check 7 —
// PRR-019).
function commentBlockAbove(ledgerPath: string, entry: string): string {
	const lines = readFileSync(ledgerPath, 'utf8')
		.replace(/\r\n/g, '\n')
		.split('\n');
	const entryIdx = lines.findIndex((line) => line.trim() === entry);
	expect(entryIdx).toBeGreaterThan(-1);
	let blockStart = entryIdx;
	while (blockStart > 0 && lines[blockStart - 1]?.startsWith('#')) {
		blockStart -= 1;
	}
	return lines.slice(blockStart, entryIdx).join('\n');
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

	test.each(
		REANCHORED_PATHS,
	)('$path is an active entry in the windows ledger exactly once (#3218 re-anchor)', ({
		path,
	}) => {
		// Re-anchored 2026-11-12 per the #3218 disposition:
		// determinism-hardened in the re-anchoring PR (cache
		// invalidation + clock pinning + boundary spec) and kept
		// quarantined until 2 consecutive green windows-latest
		// merge-group runs land. Exactly one owning entry: a second
		// block would leave two OWNER/EXPIRY owners competing for
		// renewal.
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		const entries = activeEntries(WINDOWS_LEDGER_PATH);
		expect(entries).toContain(path);
		expect(entries.filter((e) => e === path).length).toBe(1);
	});

	test.each(
		REANCHORED_PATHS,
	)('$path is scoped to the windows ledger only (no cross-ledger duplicate)', ({
		path,
	}) => {
		// A stray duplicate — most plausibly in the general ledger, which
		// applies on every RUNNER_OS — would suppress the file on OSes
		// where it has never flaked. The integration ledger covers the
		// `integration` job.
		for (const ledger of ALL_LEDGER_PATHS) {
			if (ledger === WINDOWS_LEDGER_PATH) continue;
			expect(activeEntries(ledger)).not.toContain(path);
		}
	});

	test.each(
		REANCHORED_PATHS,
	)('$path carries the re-anchored #3218 OWNER/EXPIRY metadata block', ({
		path,
	}) => {
		// Every active entry in scripts/ci/quarantined-tests*.txt must
		// carry, in the comment block directly above it, an OWNER and
		// an EXPIRY line. scripts/check-invariants.ts Check 7 fails the
		// gate if either is missing. The 2026-11-12 re-anchor moved this
		// entry under issue #3218 with the "2 consecutive green
		// windows-latest merge-group runs" criterion and EXPIRY
		// 2026-12-20; the walk is bounded to the entry's own contiguous
		// comment block so the test cannot spuriously pass against a
		// neighbour entry's metadata.
		const block = commentBlockAbove(WINDOWS_LEDGER_PATH, path);
		expect(block).toMatch(/^# OWNER: .*#3218/m);
		expect(block).toMatch(
			/criterion: 2 consecutive green windows-latest merge-group runs/m,
		);
		expect(block).toMatch(/^# EXPIRY: 2026-12-20/m);
	});

	test.each(
		REANCHORED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path,
	}) => {
		expect(existsSync(join(REPO_ROOT, path))).toBe(true);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count
		// in a "# STATUS: N active entries" header line. Post-2026-11-12
		// count is 3 (the re-anchored #3218 archive + archive-dry-run
		// pair and the #2973 dispatch-lanes entry); drift between the
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
		// Same-basename trap: the re-anchored entry owns
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
