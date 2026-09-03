/**
 * Issue #2523 ratchet — exactly one plan-structure hash definition.
 *
 * The approval-baseline hash (`computePlanStructureHash`) must remain the ONLY
 * plan-structure hash exported from `src/plan/`. The retired overlapping name
 * (`computePlanHash`) must not reappear anywhere in `src/` — not as an export,
 * an alias, or a doc reference. The ledger digest (`computePlanLedgerHash`,
 * status-inclusive) and the plan-identity hash (`derivePlanIdentityHash`) are
 * distinct axes with their own names.
 *
 * This test fails if a second hash function over plan structure is
 * reintroduced under a new name, or if the old generic name sneaks back.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAN_DIR = join(import.meta.dir, '..', '..', '..', 'src', 'plan');
const SRC_DIR = join(import.meta.dir, '..', '..', '..', 'src');

function listFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full));
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** Extract `export [async] function NAME` / `export const NAME` names. */
function exportedNames(source: string): string[] {
	const names: string[] = [];
	const fn = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
	const cn = /export\s+const\s+([A-Za-z0-9_]+)/g;
	for (let m = fn.exec(source); m; m = fn.exec(source)) names.push(m[1]!);
	for (let m = cn.exec(source); m; m = cn.exec(source)) names.push(m[1]!);
	return names;
}

describe('plan hash single-definition ratchet (#2523)', () => {
	test('src/plan exports exactly the allowlisted hash-family names — one structure hash, one ledger digest', () => {
		// Any NEW hash-named export in src/plan fails this exact-set assertion
		// until it is consciously added here — forcing the "do we really need a
		// second plan hash?" decision the #2523 audit demanded.
		// normalizeExecutionProfileForHash is a field normalizer, not a digest;
		// derivePlanIdentityHash is the separate identity axis.
		const allowlist = new Set([
			'computePlanStructureHash', // THE approval-baseline hash (structure)
			'computePlanLedgerHash', // status-inclusive ledger digest
			'computeCurrentPlanHash', // reader helper → ledger digest of plan.json
			'derivePlanIdentityHash', // identity axis (swarm/title), not content
			'normalizeExecutionProfileForHash', // field normalizer, not a digest
		]);
		const found = new Set<string>();
		for (const file of listFiles(PLAN_DIR)) {
			const source = readFileSync(file, 'utf-8');
			for (const name of exportedNames(source)) {
				if (/hash/i.test(name)) found.add(name);
			}
		}
		expect([...found].sort()).toEqual([...allowlist].sort());
		// Within that allowlist, exactly one name identifies the plan-structure
		// hash and one the ledger digest.
		expect(found.has('computePlanStructureHash')).toBe(true);
		expect(found.has('computePlanLedgerHash')).toBe(true);
	});

	test('the ledger digest and reader helper are named as ledger hashes, not plan-structure hashes', () => {
		const ledgerSource = readFileSync(join(PLAN_DIR, 'ledger.ts'), 'utf-8');
		const exports = exportedNames(ledgerSource);
		expect(exports).toContain('computePlanLedgerHash');
		expect(exports).toContain('computeCurrentPlanHash');
		expect(exports).not.toContain('computePlanHash');
	});

	test('the retired overlapping name computePlanHash appears nowhere in src/', () => {
		const offenders: string[] = [];
		for (const file of listFiles(SRC_DIR)) {
			const source = readFileSync(file, 'utf-8');
			if (/\bcomputePlanHash\b/.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
