/**
 * Recurrence guardrail for the #2960/#3322/#3330/#3331 defect class (trace
 * 3331-underscore-derivation-class, Component 7): agent-name -> (role, swarm-id)
 * derivation must go through ONE shared guarded helper (`deriveSwarmIdentity`,
 * src/config/schema.ts), never through a per-site naive first-underscore split or
 * an unguarded length-delta slice.
 *
 * RED at base (the 12 length-delta sites across 10 files, plus the retired
 * naive .match form this guardrail now also detects), GREEN after the fix.
 * Predicates run over WHITESPACE-NORMALIZED file text so multiline slices
 * match, and the walk is recursive over src/.
 *
 * ENFORCED SHAPES — the shipped claim is exactly this set, no wider (#3617
 * review PRR-002): naive agent-name splitting via .replace(/^[^_]+_/, ''),
 * the retired .match(/^([^_]+)_/) helper body, .split('_')[0] / .at(0), and
 * direct .slice/.substring(0, a.length - b.length - 1) arithmetic in both
 * operand orders. Generic .slice(0, -n) truncation and two-operand
 * a.length - b.length (no -1) slices are NOT agent-name-specific shapes and
 * are deliberately NOT predicates (35+ non-derivation hits at head); the
 * known residual derivation sites using those shapes are recorded in the PR
 * body's Considered table instead of being allowlisted here.
 *
 * Allowlist (each entry is a derivation that deliberately does NOT use the
 * helper, with its justification):
 * - src/config/schema.ts — the helper's own definition carries the slice.
 * - src/hooks/full-auto-delegation.ts — prefix-EMPTINESS policy gate (deny a raw
 *   name with no non-empty prefix before the canonical role); helper semantics
 *   would widen the deny to separator forms the policy admits by design
 *   (plan-critic round 1, finding 2).
 * - src/failures/action-identity.ts — invariant-9 action-digest canonicalization
 *   (trim+lowercase byte-stability); after this fix its value is hashed into
 *   digests only and is never consumed as a swarm id (plan-critic rounds 2-3).
 *
 * Negative fixture (must NOT be flagged): src/hooks/extractors.ts:699 computes an
 * output-budget bound inside Math.max — the arithmetic is not a direct slice
 * derivation of an agent name.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ALLOWLIST: Readonly<Record<string, string>> = {
	'src/config/schema.ts': 'deriveSwarmIdentity definition itself',
	'src/hooks/full-auto-delegation.ts':
		'prefix-emptiness policy gate (round-1 F2 exception)',
	'src/failures/action-identity.ts':
		'invariant-9 digest canonicalization (round-2 F3 / round-3 R3-1 exception)',
	// #3617 feedback PRR-005/F-01: the pre-#3330 trigger-matching form kept as
	// an explicit COMPATIBILITY leg so pre-upgrade triggerAgents entries
	// ('custom' for 'acme_custom') keep firing; deliberately naive-shaped and
	// pinned by tests/unit/hooks/incremental-verify-negative-trigger.test.ts.
	'src/hooks/incremental-verify.ts': 'base-compat trigger arm (PRR-005)',
};

// P1: naive first-underscore extraction in ANY of the shapes the class has
// actually used: the legacy .replace(/^[^_]+_/, ''), the retired
// .match(/^([^_]+)_/) helper body, and the idiomatic .split('_')[0] / .at(0).
const NAIVE_FIRST_UNDERSCORE = new RegExp(
	[
		/\.replace\(\s*\/\^\[\^_\]\+_\/\s*,\s*(['"])\1\s*\)/.source,
		/\.match\(\s*\/\^\(\[\^_\]\+\)_\/\s*\)/.source,
		/\.split\(['"]_['"]\)\s*(\[\s*0\s*\]|\.at\(\s*0\s*\))/.source,
	].join('|'),
);

// P2: a DIRECT .slice(0, …)/.substring(0, …) call whose second argument is the
// bare length-delta arithmetic X.length - Y.length - 1 in EITHER operand
// order (optional trailing comma for prettier-wrapped multiline calls after
// whitespace normalization).
const LENGTH_DELTA_SLICE = new RegExp(
	[
		/\.(?:slice|substring)\(\s*0\s*,\s*[A-Za-z0-9_$.]+\.length\s*-\s*[A-Za-z0-9_$.]+\.length\s*-\s*1\s*,?\s*\)/.source,
		/\.(?:slice|substring)\(\s*0\s*,\s*[A-Za-z0-9_$.]+\.length\s*-\s*1\s*-\s*[A-Za-z0-9_$.]+\.length\s*,?\s*\)/.source,
	].join('|'),
);

function walk(dir: string, out: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
}

describe('agent-name derivation census (issue #3330 recurrence guardrail)', () => {
	test('no naive or unguarded swarm-id derivation outside the allowlist', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const srcRoot = path.join(repoRoot, 'src');
		const files: string[] = [];
		walk(srcRoot, files);
		expect(files.length).toBeGreaterThan(100); // sanity: the walk reached src/

		const flagged: string[] = [];
		for (const full of files) {
			const rel = path.relative(repoRoot, full).split(path.sep).join('/');
			if (ALLOWLIST[rel]) continue;
			const raw = fs.readFileSync(full, 'utf8');
			const normalized = raw.replace(/\s+/g, ' ');
			if (NAIVE_FIRST_UNDERSCORE.test(normalized)) {
				flagged.push(`${rel}: naive first-underscore replace`);
			}
			if (LENGTH_DELTA_SLICE.test(normalized)) {
				flagged.push(`${rel}: unguarded length-delta slice`);
			}
		}
		// Extractors.ts's Math.max budget arithmetic must not be flagged (it is
		// not a direct slice call with inline delta arithmetic).
		expect(flagged.some((f) => f.startsWith('src/hooks/extractors.ts'))).toBe(
			false,
		);
		expect(flagged).toEqual([]);
	}, 30_000);

	test('allowlist entries still exist and are pinned (no silent removal)', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		for (const rel of Object.keys(ALLOWLIST)) {
			expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
		}
	});
});
