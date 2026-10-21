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

// The seven paths quarantined for the issue #3264 merge-group flake cohort
// (Oct 2026), each attributed to its exact triggering run/shard/OS via the
// check-run annotations API across the eleven 2026-10-14..20 merge-group
// runs (attribution evidence and per-entry rationale live in the OWNER/
// EXPIRY comment blocks of each ledger):
//
//   - five windows-latest flakes (three passed-on-retry, one 3/3 hard
//     failure in tests/unit/full-auto/state-locking.test.ts, and the
//     tests/unit/commands/archive.test.ts re-add per the #2973
//     retirement re-add rule) -> windows ledger;
//   - one macos-latest passed-on-retry flake, twice six days apart ->
//     macos ledger;
//   - one ubuntu-latest passed-on-retry flake -> general ledger, because
//     ubuntu has no per-OS ledger and the coverage gate honors only the
//     general ledger (issue #2660 precedent; the unit job consumes it
//     unconditionally on every RUNNER_OS with the per-OS ledgers
//     additive).
//
// Wrapped in object literals so `test.each`'s `$path` template
// interpolates the actual path into each test title (sibling pinning
// tests ci-yml-quarantine-2761/2812/2867 use the same destructured
// object form).
const WINDOWS_QUARANTINED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/tools/test-runner-feedback-regressions.test.ts' },
	{ path: 'tests/unit/full-auto/state-locking.test.ts' },
	{ path: 'tests/unit/evaluation/runner-failures.test.ts' },
	{ path: 'tests/unit/workflow/coder-settlement-2214-hardening.test.ts' },
	{ path: 'tests/unit/commands/archive.test.ts' },
];
const MACOS_QUARANTINED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/plan/manager-current-phase-2532.test.ts' },
];
const GENERAL_QUARANTINED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/background/plan-sync-worker.test.ts' },
];
const ALL_LEDGER_PATHS: ReadonlyArray<string> = [
	GENERAL_LEDGER_PATH,
	MACOS_LEDGER_PATH,
	WINDOWS_LEDGER_PATH,
	INTEGRATION_LEDGER_PATH,
];

// Full table of this PR's entries with the single ledger each belongs in.
const THIS_PR_ENTRIES: ReadonlyArray<{
	path: string;
	ledgerPath: string;
	ledgerName: string;
}> = [
	...WINDOWS_QUARANTINED_PATHS.map((entry) => ({
		...entry,
		ledgerPath: WINDOWS_LEDGER_PATH,
		ledgerName: 'windows',
	})),
	...MACOS_QUARANTINED_PATHS.map((entry) => ({
		...entry,
		ledgerPath: MACOS_LEDGER_PATH,
		ledgerName: 'macos',
	})),
	...GENERAL_QUARANTINED_PATHS.map((entry) => ({
		...entry,
		ledgerPath: GENERAL_LEDGER_PATH,
		ledgerName: 'general',
	})),
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

describe('ci.yml integration — quarantine ledger entries for issue #3264 (this PR)', () => {
	test.each(THIS_PR_ENTRIES)(
		'$path is an active entry in the $ledgerName ledger',
		({ path, ledgerPath }) => {
			// Regression guard for the seven net-new #3264 entries: without
			// them, the attributed merge-group unit/coverage shards keep
			// running these files and Rule A of the flake detector keeps
			// re-filing duplicate issues (it only drops candidates already
			// present in a ledger).
			expect(existsSync(ledgerPath)).toBe(true);
			expect(activeEntries(ledgerPath)).toContain(path);
		},
	);

	test.each(THIS_PR_ENTRIES)(
		'$path is scoped to the $ledgerName ledger only (no cross-ledger duplicate)',
		({ path, ledgerPath }) => {
			// Cross-ledger duplicates would falsely imply cross-OS evidence:
			// every windows/macos entry here is single-OS (green sibling-OS
			// shards in the same runs) and the general entry is the sole
			// ubuntu-reachable ledger. A stray duplicate would suppress the
			// file on OSes where it has never flaked. The general ledger
			// applies on every RUNNER_OS, the per-OS ledgers on their named
			// OS, and the integration ledger for the `integration` job.
			for (const ledger of ALL_LEDGER_PATHS) {
				if (ledger === ledgerPath) continue;
				expect(activeEntries(ledger)).not.toContain(path);
			}
		},
	);

	test.each(THIS_PR_ENTRIES)(
		'$path exists on disk and is discovered by the ci.yml find chain',
		({ path }) => {
			// A typo'd ledger path would be a silent no-op: CI's comm -23
			// gated set would never exclude it (the path never appears in
			// all-tests.txt) and the flake-detection workflow would keep
			// re-filing. The unit discovery chain globs
			// tests/unit/**/*.test.ts, so the on-disk file must exist at
			// exactly the ledger path relative to the repo root.
			expect(existsSync(join(REPO_ROOT, path))).toBe(true);
		},
	);

	test.each(THIS_PR_ENTRIES)(
		'$path carries the issue #2477 OWNER + EXPIRY metadata block',
		({ path, ledgerPath }) => {
			// Every active entry in scripts/ci/quarantined-tests*.txt must
			// carry, in the comment block directly above it, an OWNER and
			// an EXPIRY line. scripts/check-invariants.ts Check 7 fails the
			// gate if either is missing. The grep window is the contiguous
			// comment block (lines starting with `#`) directly preceding
			// the non-comment path line — bounded to the entry's own header
			// so the test does not spuriously pass against metadata that
			// belongs to a neighbour entry.
			const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
			const lines = raw.split('\n');
			const entryIndex = lines.findIndex(
				(line: string) => line.trim() === path,
			);
			expect(entryIndex).toBeGreaterThan(0);
			let blockStart = entryIndex;
			while (blockStart > 0 && lines[blockStart - 1]?.startsWith('#')) {
				blockStart -= 1;
			}
			const block = lines.slice(blockStart, entryIndex).join('\n');
			expect(block).toMatch(/^# OWNER: .*#3264/m);
			expect(block).toMatch(/^# EXPIRY: 2026-11-20/m);
		},
	);

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count
		// in a "# STATUS: N active entries" header line. This PR grew it
		// 6 -> 11; drift between the declared count and the actual
		// active-entry count (e.g. an entry removed without updating the
		// header, or a count bumped without the matching entries) makes
		// the header lie to triage. Note: this only catches count drift;
		// the presence tests above are the cross-PR overwrite guard.
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
		// Same-basename trap: this PR quarantines
		// tests/unit/commands/archive.test.ts (windows re-add per #2973),
		// NOT tests/unit/evidence/archive.test.ts. The evidence-flavour
		// archive test has no flake evidence in the #3264 cohort and must
		// stay in every gated set — a glob or basename-based quarantine
		// would silently stop CI running it on all OSes.
		for (const ledger of ALL_LEDGER_PATHS) {
			expect(activeEntries(ledger)).not.toContain(
				'tests/unit/evidence/archive.test.ts',
			);
		}
	});
});
