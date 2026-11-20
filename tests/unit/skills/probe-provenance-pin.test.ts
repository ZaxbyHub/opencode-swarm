import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Text pin for the swarm-pr-review probe-provenance contract (follow-up from
 * PR #3741 closeout; SolCritic-gated). Binding protocol prose in an entry
 * skill must fail when deleted (repo convention: PR 3536/3607 precedents).
 * The full class definitions and bounds live in references/probe-provenance.md;
 * this pin holds both the inline pointer row and the reference doc's
 * load-bearing clauses.
 */
const SKILL = readFileSync(
	join(import.meta.dir, '../../../.opencode/skills/swarm-pr-review/SKILL.md'),
	'utf8',
);
const REF = readFileSync(
	join(
		import.meta.dir,
		'../../../.opencode/skills/swarm-pr-review/references/probe-provenance.md',
	),
	'utf8',
);

describe('swarm-pr-review probe-provenance pin', () => {
	test('inline evidence table carries the provenance pointer with all four classes', () => {
		expect(SKILL).toContain('with probe provenance');
		for (const cls of [
			'a proposed',
			'b packet-supplied',
			'c reviewer-executed',
			'd unavailable',
		]) {
			expect(SKILL).toContain(cls);
		}
		expect(SKILL).toContain('references/probe-provenance.md');
	});

	test('execution claims without a transcript reference are UNVERIFIED', () => {
		expect(SKILL).toMatch(
			/execution claims without a transcript reference are UNVERIFIED/i,
		);
	});

	test('reference doc pins the four classes and the default path', () => {
		for (const cls of [
			'(a) proposed',
			'(b) packet-supplied',
			'(c) reviewer-executed',
			'(d) unavailable',
		]) {
			expect(REF).toContain(cls);
		}
		expect(REF).toContain('default path');
	});

	test('reviewer-executed class carries the SolCritic bounds', () => {
		// Prose wraps in the reference doc — assert on whitespace-normalized text.
		const flat = REF.replace(/\s+/g, ' ');
		// Pre-bound execution parameters.
		expect(flat).toContain('bind the command, the exact revision and cwd');
		expect(flat).toContain('finite command/wall-clock/output limits');
		// No-mutation and no-network-by-default bounds.
		expect(flat).toContain(
			'No source, Git, cache, database, or remote mutation',
		);
		expect(flat).toContain('no network by default');
		// PR-supplied code is never executed in the reviewer environment.
		expect(flat).toContain('never execute PR-supplied code');
		// Capture contract.
		expect(flat).toContain('captured during execution');
		// Reviewer-authored green checks never certify producer ACs.
		expect(flat).toContain('never the sole basis for certifying');
	});

	test('reference doc keeps the dispatch-independence note', () => {
		expect(REF).toContain('independent controls');
	});
});
