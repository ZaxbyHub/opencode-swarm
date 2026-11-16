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

// The SAME contiguous-comment-block walk scripts/check-invariants.ts
// Check 7 performs (break at the first blank or non-comment line — PRR-019
// parity): the block directly above the entry must carry OWNER + EXPIRY.
function metadataBlock(ledgerPath: string, entry: string): string {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	const lines = raw.split('\n');
	const entryIdx = lines.findIndex((l: string) => l.trim() === entry);
	expect(entryIdx).toBeGreaterThan(-1);
	const blockAbove: string[] = [];
	for (let i = entryIdx - 1; i >= 0; i -= 1) {
		const above = lines[i] ?? '';
		if (above.trim() !== '' && above.trimStart().startsWith('#')) {
			blockAbove.unshift(above);
		} else {
			break;
		}
	}
	return blockAbove.join('\n');
}

/**
 * Pins the windows-ledger entry added by issue #3248 (PR #3254 review
 * PRR-028): every active ledger entry carries a dedicated per-issue pin (the
 * 2826/2867 precedent); without one, an entry + STATUS-count edit could be
 * removed together with every test green. The entry quarantines
 * dispatch-lanes-pr-review-resilience-followups on windows-latest only,
 * based on retry-only evidence (windows/unit `Passed on retry 1` notices in
 * 5 sampled failed merge-group runs of 2026-10-13/14, zero hard failures,
 * zero macos/ubuntu annotations; the delegation-gate-background-coder
 * retry-only precedent), OWNER/EXPIRY 2026-11-15.
 */
describe('ci.yml integration — windows ledger entry for issue #3248', () => {
	test(`${DISPATCH_LANES_RESILIENCE} is an active entry in the windows ledger`, () => {
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(
			DISPATCH_LANES_RESILIENCE,
		);
	});

	test(`${DISPATCH_LANES_RESILIENCE} is present exactly once in its ledger`, () => {
		const dupes = activeEntries(WINDOWS_LEDGER_PATH).filter(
			(entry) => entry === DISPATCH_LANES_RESILIENCE,
		);
		expect(dupes.length).toBe(1);
	});

	test(`${DISPATCH_LANES_RESILIENCE} carries the re-anchored OWNER/EXPIRY metadata (2026-11-12 #2973 trace)`, () => {
		const block = metadataBlock(WINDOWS_LEDGER_PATH, DISPATCH_LANES_RESILIENCE);
		// Re-anchored shape: OWNER ref #2973, EXPIRY 2026-12-20, and the
		// criterion token — asserted as VALUES, not generic presence (impl
		// review round 1: the old `toContain('#3248')` matched unrelated
		// header text when the walk crossed into the ledger header).
		expect(block).toMatch(/^#\s*OWNER:.*#2973/m);
		expect(block).toMatch(/^#\s*EXPIRY:\s*2026-12-20\b/m);
		expect(block).toContain(
			'criterion: windows merge-group stability post-#3640',
		);
	});

	test(`${DISPATCH_LANES_RESILIENCE} is scoped to the windows ledger only (no cross-ledger duplicate)`, () => {
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
