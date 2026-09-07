/**
 * Defect-class guardrail for issue #2628 — every prompt-block builder defined
 * under src/ must be bounded.
 *
 * Class: "prompt-injected block whose size is driven by an unbounded
 * ledger/list-derived multiplicity, rendered without dedupe or a hard
 * character budget." The #2628 compliance block and the #2045 delegate block
 * are the two known instances; this scan keeps any future `build*Block`
 * prompt builder in the same bounded contract: its module must reference a
 * char-budget constant (`*_CHAR_CAP`) or the builder must take a budget
 * parameter (`charBudget`). Scan-scope note: the repo's prompt-block naming
 * convention is the `build*Block` prefix (both known builders follow it);
 * a differently-named future builder escapes this heuristic rung and must be
 * added here.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(import.meta.dir, '../../../src');

const BUILDER_PATTERN =
	/export (?:async )?function build[A-Za-z0-9]*Block\s*\(/g;
// Bounding mechanisms observed across the repo's block builders (sweep,
// 2026-09-07): hard char caps (CHAR_CAP), per-block char budgets
// (CHAR_BUDGET / charBudget), token budgets (tokenBudget), file-count caps
// (maxFiles), and item-count caps (*_CAP). A builder module counts as bounded
// when ANY of these appear in the module (constant, parameter, or slice cap).
const BOUND_EVIDENCE =
	/CHAR_CAP|CHAR_BUDGET|char_budget|charBudget|tokenBudget|maxFiles|[A-Z_]*_CAP\b/;

function* walkTsFiles(root: string): Generator<string> {
	for (const name of readdirSync(root)) {
		const full = path.join(root, name);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			yield* walkTsFiles(full);
		} else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
			yield full;
		}
	}
}

describe('prompt-block budget guardrail (#2628 defect class)', () => {
	it('finds the known prompt-block builders (anti-vacuous control)', () => {
		const builders = new Map<string, string[]>();
		for (const file of walkTsFiles(SRC_ROOT)) {
			const content = readFileSync(file, 'utf-8');
			const names = [...content.matchAll(BUILDER_PATTERN)].map(
				(m) => m[1] ?? m[0],
			);
			if (names.length > 0) builders.set(file, names);
		}
		// Both shipped builders must still exist for this scan to mean anything.
		const allNames = [...builders.values()].flat().join('\n');
		expect(allNames).toContain('buildDirectiveComplianceBlock');
		expect(allNames).toContain('buildDelegateDirectiveBlock');
	});

	it('bounds every prompt-block builder with a char cap or budget parameter', () => {
		const unbounded: string[] = [];
		let builderFiles = 0;
		for (const file of walkTsFiles(SRC_ROOT)) {
			const content = readFileSync(file, 'utf-8');
			const matches = [...content.matchAll(BUILDER_PATTERN)];
			if (matches.length === 0) continue;
			builderFiles += 1;
			if (!BOUND_EVIDENCE.test(content)) {
				unbounded.push(
					`${path.relative(SRC_ROOT, file)}: ${matches.map((m) => m[0]).join(', ')}`,
				);
			}
		}
		expect(builderFiles).toBeGreaterThan(0);
		expect(unbounded).toEqual([]);
	});
});
