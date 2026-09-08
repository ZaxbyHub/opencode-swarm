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
	test('no lenient utf8 decode of plan.json remains under src/plan/', () => {
		const offenders: string[] = [];
		for (const file of listFilesRecursive(PLAN_SRC)) {
			const lines = readFileSync(file, 'utf8').split('\n');
			lines.forEach((line, index) => {
				if (/readFileSync\([^)]*planJsonPath[^)]*,\s*'utf8'\s*\)/.test(line)) {
					offenders.push(`${file}:${index + 1}: ${line.trim()}`);
				}
			});
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
