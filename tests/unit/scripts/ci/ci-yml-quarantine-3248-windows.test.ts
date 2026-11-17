import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Repo root is four levels up from tests/unit/scripts/ci/.
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

const DISPATCH_LANES_RESILIENCE =
	'tests/unit/tools/dispatch-lanes-pr-review-resilience-followups.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

/**
 * Pins the RETIRED state of the windows-ledger entry that issue #3248 added
 * (PR #3254 review PRR-028) and the 2026-11-16 un-quarantine removed. The
 * entry quarantined dispatch-lanes-pr-review-resilience-followups on
 * windows-latest only, based on retry-only evidence (windows/unit `Passed on
 * retry 1` notices in 5 sampled failed merge-group runs of 2026-10-13/14,
 * zero hard failures, zero macos/ubuntu annotations). Retired 2026-11-16 per
 * issue #2973 after the raw `await fs.rm` teardown (zero EBUSY/EPERM retries
 * over a live WAL SQLite DB — the exact class sibling retirements cured via
 * safeRmRecursive) was converted in the retiring PR; the un-stubbed real-git
 * preflight latency is a disclosed watch item, and re-adding the entry
 * requires fresh merge-group windows-latest failure evidence per the #1782
 * convention.
 */
describe('ci.yml integration — windows ledger entry for issue #3248', () => {
	test(`${DISPATCH_LANES_RESILIENCE} is retired — NOT an active entry in the windows ledger`, () => {
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
			DISPATCH_LANES_RESILIENCE,
		);
	});

	test(`${DISPATCH_LANES_RESILIENCE} is absent from the general, macos, and integration ledgers (no cross-ledger migration)`, () => {
		const otherLedgers = [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		];
		for (const ledger of otherLedgers) {
			if (!existsSync(ledger)) {
				continue;
			}
			expect(activeEntries(ledger)).not.toContain(DISPATCH_LANES_RESILIENCE);
		}
	});

	test(`${DISPATCH_LANES_RESILIENCE} exists on disk at the exact ledger path`, () => {
		// A typo'd path would be a silent no-op in ci.yml's comm-based gate.
		expect(existsSync(join(REPO_ROOT, DISPATCH_LANES_RESILIENCE))).toBe(true);
	});
});
