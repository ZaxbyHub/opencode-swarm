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
// triggering runs' check-run annotations (per-entry rationale and evidence
// live in the OWNER/EXPIRY comment blocks of the windows ledger):
//
//   - tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts
//     is a CORE-TREE entry (tests/unit/hooks/**, detector rule C) routed to
//     the windows ledger after documented review, per the #2867
//     delegation-gate-background-coder precedent;
//   - tests/unit/commands/archive-dry-run.test.ts fired the ledger-entry
//     branch of the rule pre-recorded in the #3263 2026-10-30 triage note
//     (four windows-only passed-on-retry detections, two of them on heads
//     that already contain the #3252 safeRmRecursive conversion).
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
const THIS_PR_ENTRIES: ReadonlyArray<{
	path: string;
}> = [
	{
		path: 'tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts',
	},
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

describe('ci.yml integration — quarantine ledger entries for issue #3263 (this PR)', () => {
	test.each(
		THIS_PR_ENTRIES,
	)('$path is an active entry in the windows ledger', ({ path }) => {
		// Regression guard for the two net-new #3263 entries added by
		// this PR: without them, the attributed windows-latest unit
		// shards keep running these files and Rule A of the flake
		// detector keeps re-filing duplicate issues (it only drops
		// candidates already present in a ledger).
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(path);
	});

	test.each(
		THIS_PR_ENTRIES,
	)('$path is scoped to the windows ledger only (no cross-ledger duplicate)', ({
		path,
	}) => {
		// Cross-ledger duplicates would falsely imply cross-OS
		// evidence: both entries are single-OS windows-latest flakes
		// (zero ubuntu/macos annotations for these files in any of
		// the six triggering runs), so a stray duplicate — most
		// plausibly in the general ledger, which applies on every
		// RUNNER_OS — would suppress the file on OSes where it has
		// never flaked. The integration ledger covers the
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
		THIS_PR_ENTRIES,
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

	test.each(
		THIS_PR_ENTRIES,
	)('$path carries the issue #2477 OWNER + EXPIRY metadata block', ({
		path,
	}) => {
		// Every active entry in scripts/ci/quarantined-tests*.txt must
		// carry, in the comment block directly above it, an OWNER and
		// an EXPIRY line. scripts/check-invariants.ts Check 7 fails
		// the gate if either is missing. The grep window is the
		// contiguous comment block (lines starting with `#`) directly
		// preceding the non-comment path line — bounded to the
		// entry's own header so the test does not spuriously pass
		// against metadata that belongs to a neighbour entry.
		const raw = readFileSync(WINDOWS_LEDGER_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		const lines = raw.split('\n');
		const entryIndex = lines.findIndex((line: string) => line.trim() === path);
		expect(entryIndex).toBeGreaterThan(0);
		let blockStart = entryIndex;
		while (blockStart > 0 && lines[blockStart - 1]?.startsWith('#')) {
			blockStart -= 1;
		}
		const block = lines.slice(blockStart, entryIndex).join('\n');
		expect(block).toMatch(/^# OWNER: .*#3263/m);
		expect(block).toMatch(/^# EXPIRY: 2026-12-06/m);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count
		// in a "# STATUS: N active entries" header line. This PR grew it
		// 8 -> 10 (the five #3264 cohort entries plus the three earlier
		// actives pre-date it); drift between the declared count and the
		// actual active-entry count (e.g. an entry removed without
		// updating the header, or a count bumped without the matching
		// entries) makes the header lie to triage. Note: this only
		// catches count drift; the presence tests above are the
		// cross-PR overwrite guard.
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
