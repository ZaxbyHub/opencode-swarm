import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning test for the issue #2826 quarantine entry.
//
// Issue #2826 was auto-filed by the merge-group flake-detection workflow
// (#1782) after CI run 35239240597 (merge_group, head
// 27d8196445669c53f45acd65c7acd839aeaeb5c5, 2026-09-17T15:17:17Z). It listed
// one candidate:
//   - tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts
//     (windows-latest unit-shard 3, passed-on-retry-2 flake) -> WINDOWS
//     ledger (scripts/ci/quarantined-tests-windows.txt)
//
// The pinning test reads the real ledger files off disk and asserts the
// entry is present in the windows ledger and absent from the others, that
// its comment block carries the OWNER/EXPIRY metadata required by
// check:invariants Check 7 (issue #2477), and that the on-disk file exists
// at exactly the ledger path.

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

const ISSUE_2826_QUARANTINED_PATH =
	'tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// Entries are compared UNTRIMMED (CI's grep/comm matching is byte-exact, so a
// whitespace-corrupted entry must fail here too); CRLF is normalized first so
// the assertion holds on any checkout config.
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
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

describe('ci.yml integration — quarantine ledger entry for issue #2826 merge-group flake detection', () => {
	test(`${ISSUE_2826_QUARANTINED_PATH} is an active entry in the windows ledger`, () => {
		// Regression guard for issue #2826: without this entry, rule A of
		// scripts/ci/detect-and-quarantine-flakes.sh would re-file duplicate
		// issues on every detection (it only drops candidates already present
		// in a ledger) and the affected windows-latest unit shards would keep
		// flaking.
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(
			ISSUE_2826_QUARANTINED_PATH,
		);
	});

	test('the entry is scoped to the windows ledger only (single-OS evidence)', () => {
		// The #2826 flake was windows-latest-only with green/round-robin
		// ubuntu/macos siblings, so the entry must NOT suppress the file on
		// other OSes: the general ledger applies on every RUNNER_OS and the
		// macos ledger on macOS runners (see the "Collect and partition test
		// files" step in ci.yml).
		const otherLedgers = [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		];
		for (const ledger of otherLedgers) {
			expect(activeEntries(ledger)).not.toContain(
				ISSUE_2826_QUARANTINED_PATH,
			);
		}
	});

	test('the entry carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
		// check:invariants Check 7 requires every active quarantine entry to
		// carry `# OWNER:` and `# EXPIRY: YYYY-MM-DD` in the comment block
		// directly above it; a missing block fails the gate and would block
		// this very PR's CI, so the pinning test re-asserts the grammar.
		const block = commentBlockAbove(
			WINDOWS_LEDGER_PATH,
			ISSUE_2826_QUARANTINED_PATH,
		);
		expect(block).toContain('# OWNER:');
		expect(block.match(/#\s*EXPIRY:\s*\d{4}-\d{2}-\d{2}/) !== null).toBe(
			true,
		);
	});

	test('the quarantined path exists on disk and is discovered by the ci.yml find chain', () => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated
		// set would never exclude it (the path never appears in all-tests.txt)
		// and the flake-detection workflow would keep re-filing. The unit
		// discovery chain globs tests/unit/**/*.test.ts, so the on-disk file
		// must exist at exactly the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, ISSUE_2826_QUARANTINED_PATH))).toBe(
			true,
		);
	});
});
