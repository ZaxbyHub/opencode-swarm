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

// The two paths quarantined for issue #3263 (merge-group flake cohort,
// Nov 2026), both attributed windows-latest-only passed-on-retry via the
// triggering runs' check-run annotations.
//
// DISPOSITION (2026-11-12, per issue #2973's collated trace):
//   - tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts
//     was un-quarantined (never reproduced post-observation) — now pinned
//     with the retired-absence shape below;
//   - tests/unit/commands/archive-dry-run.test.ts is STILL ACTIVE in the
//     windows ledger, re-anchored 2026-11-12 under the #3218 disposition
//     (determinism-hardened in the re-anchoring PR: cache invalidation +
//     clock pinning + boundary spec; criterion = 2 consecutive green
//     windows-latest merge-group runs; EXPIRY 2026-12-20).
//
// The other five files named in the issue body (the ubuntu coverage-shard
// `.swarm/`-posture wave: src/__tests__/cli-version.test.ts,
// src/commands/commands.test.ts, tests/unit/cli/run-command.test.ts,
// tests/unit/hooks/delegation-gate-scope.test.ts, and
// tests/unit/hooks/guardrails-modified-files.test.ts) are deliberately NOT
// quarantined: that wave was root-fixed in-tree by 3bffa0295 (PR #3254,
// 2026-10-14) and none of the five has been re-detected since — a ledger
// entry would only drop real coverage. The negative test below pins that
// disposition.
//
// Wrapped in object literals so `test.each`'s `$path` template
// interpolates the actual path into each test title (sibling pinning
// tests ci-yml-quarantine-2761/2812/2867/3264 use the same destructured
// object form).
const RETIRED_PATHS: ReadonlyArray<{ path: string }> = [
	{
		path: 'tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts',
	},
];
const REANCHORED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/commands/archive-dry-run.test.ts' },
];

// The five issue-#3263 candidates dispositioned as already root-fixed —
// they must stay out of every ledger so ubuntu/macOS CI keeps running
// them (see the negative test below). Object-literal form so $path
// interpolates into each title.
const ROOT_FIXED_NOT_QUARANTINED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'src/__tests__/cli-version.test.ts' },
	{ path: 'src/commands/commands.test.ts' },
	{ path: 'tests/unit/cli/run-command.test.ts' },
	{ path: 'tests/unit/hooks/delegation-gate-scope.test.ts' },
	{ path: 'tests/unit/hooks/guardrails-modified-files.test.ts' },
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

describe('ci.yml integration — quarantine ledger entries for issue #3263', () => {
	test.each(
		RETIRED_PATHS,
	)('$path is retired — NOT an active entry in any ledger', ({ path }) => {
		// Retirement guard for the #2973 un-quarantine (2026-11-12): the
		// entry must stay ABSENT from the windows ledger and every other
		// ledger so the attributed windows-latest unit shards keep running
		// the file; re-adding it requires a fresh merge-group
		// windows-latest failure per the #1782 convention. Every ledger
		// must exist so the negative assertion cannot pass vacuously.
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
		// Re-anchored 2026-11-12 per the #3218 disposition: determinism-
		// hardened in the re-anchoring PR (cache invalidation + clock
		// pinning + boundary spec) and kept quarantined until 2
		// consecutive green windows-latest merge-group runs land.
		// Exactly one owning entry: a second block would leave two
		// OWNER/EXPIRY owners competing for renewal.
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
		for (const ledger of [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		]) {
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

	test.each(
		ROOT_FIXED_NOT_QUARANTINED_PATHS,
	)('$path (root-fixed #3254 posture wave) is NOT quarantined in any ledger', ({
		path,
	}) => {
		// The issue body listed these five files, but per-file CI
		// forensics attributed them to the ubuntu coverage-shard
		// `.swarm/`-posture wave root-fixed in-tree by 3bffa0295
		// (PR #3254, scripts/ci/run-coverage-gate.sh:127-144) BEFORE
		// any of the three triggering runs' detections were triaged;
		// none has been re-detected since. Quarantining them
		// (especially via the general ledger, which the ubuntu
		// coverage gate also honors) would silently drop real
		// coverage on green tests. This pins the no-entry
		// disposition against a reflexive "quarantine everything the
		// issue lists" follow-up.
		for (const ledger of ALL_LEDGER_PATHS) {
			// Every ledger must exist: a missing ledger would make this
			// negative assertion pass vacuously.
			expect(existsSync(ledger)).toBe(true);
			expect(activeEntries(ledger)).not.toContain(path);
		}
	});
});
