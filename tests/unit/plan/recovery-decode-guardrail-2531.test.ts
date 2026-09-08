import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #2531 Phase 4.2 defect-class guardrail (strongest feasible rung: a
 * source-scan ratchet over src/plan/). The defect class: a recovery or read
 * path consumes a derived projection or unverified ledger suffix when richer
 * verified authoritative state is available, or decodes plan state leniently
 * so invalid bytes become silent U+FFFD replacement characters.
 *
 * Predicates:
 * 1. No lenient `readFileSync(<plan.json path>, 'utf8')` decode remains in
 *    src/plan/ — plan.json must be read through the fatal decoder
 *    (readPlanFileUtf8 / readFileLedgerExact / TextDecoder fatal).
 * 2. Approved-snapshot loaders must use readLedgerEventsWithIntegrity (the
 *    verified prefix), never bare readLedgerEvents.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const PLAN_SRC = join(REPO_ROOT, 'src', 'plan');

function listFilesRecursive(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			files.push(...listFilesRecursive(full));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			files.push(full);
		}
	}
	return files;
}

describe('#2531 recovery/decode defect-class guardrail', () => {
	test('no lenient utf8 decode remains under src/plan/ outside the explicit allowlist', () => {
		// Hardened (#2531 feedback PRR-009): match ANY same-line lenient
		// `readFileSync(<firstArg>, 'utf8')` regardless of variable name or
		// quote style, and require every hit to be one of the two pre-existing,
		// internally-consistent lenient readers (computeCurrentPlanHash's hash
		// input and the quarantine-salvage byte compare). A NEW lenient plan
		// decode with a different variable name fails this test loudly.
		const ALLOWED_FIRST_ARGS = new Set(['planPath', 'existingPath']);
		const offenders: string[] = [];
		const lenientCall =
			/readFileSync\(\s*([A-Za-z_$][\w$.]*)\s*,\s*['"]utf8['"]\s*\)/g;
		for (const file of listFilesRecursive(PLAN_SRC)) {
			const source = readFileSync(file, 'utf8');
			for (const match of source.matchAll(lenientCall)) {
				const firstArg = match[1];
				if (!ALLOWED_FIRST_ARGS.has(firstArg)) {
					const lineNo = source.slice(0, match.index).split('\n').length;
					offenders.push(
						`${file}:${lineNo}: lenient utf8 readFileSync on "${firstArg}"`,
					);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('approved-snapshot loaders read the verified prefix only', () => {
		const ledgerSource = readFileSync(join(PLAN_SRC, 'ledger.ts'), 'utf8');
		const loadLastApproved = ledgerSource.slice(
			ledgerSource.indexOf('export async function loadLastApprovedPlan'),
			ledgerSource.indexOf(
				'export async function loadLastPlanCriticApprovedSnapshot',
			),
		);
		const loadLastGate = ledgerSource.slice(
			ledgerSource.indexOf(
				'export async function loadLastPlanCriticApprovedSnapshot',
			),
			ledgerSource.indexOf('function findLastApprovedSnapshot'),
		);
		// Slice-marker integrity (#2531 feedback PRR-009): a renamed marker
		// makes indexOf return -1 and silently widens the slice window, so a
		// widened window must fail this test instead of passing vacuously.
		expect(ledgerSource.indexOf('export async function loadLastApprovedPlan')).toBeGreaterThanOrEqual(0);
		expect(
			ledgerSource.indexOf('export async function loadLastPlanCriticApprovedSnapshot'),
		).toBeGreaterThan(0);
		expect(ledgerSource.indexOf('function findLastApprovedSnapshot')).toBeGreaterThan(0);
		expect(loadLastApproved.includes('readLedgerEventsWithIntegrity')).toBe(
			true,
		);
		expect(loadLastGate.includes('readLedgerEventsWithIntegrity')).toBe(true);
		// Neither loader body may contain a bare readLedgerEvents( call (the
		// lenient reader). The WithIntegrity name contains the substring, so
		// match the exact call shape.
		const bareLenient = /(?<!With)readLedgerEvents\(/;
		expect(bareLenient.test(loadLastApproved)).toBe(false);
		expect(bareLenient.test(loadLastGate)).toBe(false);
	});
});
