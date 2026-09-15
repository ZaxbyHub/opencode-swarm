import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2692 quarantine entry.
//
// Issue #2692 was auto-filed by the flake-detection workflow (issue #1782,
// .github/workflows/flake-detection.yml) after merge-group CI run 34410703321
// (merge_group pr-2644, head 740b66aa4, 2026-09-09T22:08:51Z) produced one
// flake annotation:
//   - tests/unit/background/completion-observer-coder.test.ts
//     (windows-latest unit-shard 1, Attempt 1 failed → Passed on retry 1;
//      passed-on-retry flake; sibling ubuntu-latest shard 1 and
//      macos-latest shard 1 ran the same file green in the same run)
//
// The entry belongs in the windows-only ledger (single-OS evidence): the
// general ledger applies on every RUNNER_OS and would suppress the file on
// ubuntu/macos too, which the evidence does not justify.
//
// Each pinning test below reads the real ledger files off disk and asserts
// the entry is present in the windows ledger and absent from the others,
// that the on-disk test file exists, and that the entry block carries the
// OWNER/EXPIRY metadata required by Check 7 (issue #2477).

const REPO_ROOT = join(import.meta.dir, '../../../..');
const GENERAL_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests.txt',
);
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

const COMPLETION_OBSERVER_CODER =
	'tests/unit/background/completion-observer-coder.test.ts';

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

describe('ci.yml integration — quarantine ledger entry for issue #2692 merge-group flake detection', () => {
	test('completion-observer-coder.test.ts is an active entry in the windows ledger', () => {
		// Without this entry, the flake-detection script keeps re-filing the
		// candidate (Rule A only drops already-quarantined files). The flake
		// originated on windows-latest unit-shard 1 (CI run 34410703321,
		// 2026-09-09T22:14:39Z, Attempt 1 failed → Passed on retry 1).
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(
			COMPLETION_OBSERVER_CODER,
		);
	});

	test('is scoped to the windows ledger only (single-OS evidence)', () => {
		// The general ledger applies on every RUNNER_OS — listing it there
		// would suppress the file on ubuntu/macos too, but the evidence is
		// windows-only (ubuntu-latest shard 1 ran the file green in 1.18s and
		// macos-latest shard 1 in 2.41s in the same CI run 34410703321).
		expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
			COMPLETION_OBSERVER_CODER,
		);
		expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(
			COMPLETION_OBSERVER_CODER,
		);
		if (existsSync(INTEGRATION_LEDGER_PATH)) {
			expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
				COMPLETION_OBSERVER_CODER,
			);
		}
	});

	test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated set
		// would never exclude it (the path never appears in all-tests.txt) and
		// the flake would keep re-filing. The discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at exactly
		// the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, COMPLETION_OBSERVER_CODER))).toBe(
			true,
		);
	});

	test('the entry block carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
		// Check 7 hard-fails any active entry missing OWNER/EXPIRY or with
		// EXPIRY past the 14-day grace window. Reading the raw file here is
		// more direct than invoking check:invariants and gives a focused,
		// fast RED signal if the next entry edit drops one of the two
		// required lines.
		const raw = readFileSync(WINDOWS_LEDGER_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		const lines = raw.split('\n');
		const entryIdx = lines.findIndex(
			(l: string) => l.trim() === COMPLETION_OBSERVER_CODER,
		);
		expect(entryIdx).toBeGreaterThan(-1);
		const blockAbove: string[] = [];
		for (let i = entryIdx - 1; i >= 0; i -= 1) {
			const above = lines[i] ?? '';
			if (above.trim() === '' || /^\s*#/.test(above)) {
				blockAbove.push(above);
			} else {
				break;
			}
		}
		const block = blockAbove.join('\n');
		expect(block).toMatch(/^#\s*OWNER:\s*\S.*$/m);
		const expiry = block.match(/^#\s*EXPIRY:\s*(\d{4}-\d{2}-\d{2})\b/m);
		expect(expiry).not.toBeNull();
		const [y, m, d] = (expiry?.[1] ?? '').split('-').map(Number);
		expect(y).toBeGreaterThan(2020);
		expect(m).toBeGreaterThanOrEqual(1);
		expect(m).toBeLessThanOrEqual(12);
		expect(d).toBeGreaterThanOrEqual(1);
		expect(d).toBeLessThanOrEqual(31);
	});
});
