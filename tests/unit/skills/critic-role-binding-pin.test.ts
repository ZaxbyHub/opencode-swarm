import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Text pin for the Phase 8 "Critic role binding" policy paragraph
// (swarm-pr-review feedback round, 2026-11-01). Guards against silent
// loss of the binding clauses the installed condensed copies must mirror:
// pinned-first resolution, the eligibility requirement (model independence
// from the reviewer), the never-a-generic-swap rule, the disclosed
// same-family degraded gate, the Hard Rule 14 failure definition, the
// Profiles B/C fallback scoping with its Profile A carve-out, the
// identity-not-exposed rule, the defective-copy rule, the pre-synthesis
// gate's critic-independence slot with its DEGRADED-only verdict
// restriction, and the provenance identity bullet.
const ROOT = join(import.meta.dir, '..', '..', '..');
const SKILL = join(ROOT, '.opencode', 'skills', 'swarm-pr-review', 'SKILL.md');

describe('critic role binding policy pin (swarm-pr-review Phase 8)', () => {
	const content = readFileSync(SKILL, 'utf-8');
	// Normalize whitespace so needles survive markdown line wrapping.
	const flat = content.replace(/\s+/g, ' ');

	test('the binding paragraph exists with its load-bearing clauses', () => {
		expect(flat).toContain('**Critic role binding (all profiles).**');
		expect(flat).toContain('ELIGIBLE type');
		expect(flat).toContain("not the reviewer's model family");
		expect(flat).toContain('never a generic swap for it');
		expect(flat).toContain('degraded-independence disclosure');
		expect(flat).toContain('no pinned critic type exists on the roster at all');
		expect(flat).toContain('Hard Rule 14 initial attempt plus its two retries');
		expect(flat).toContain(
			'a fallback that also fails surfaces BLOCKED per Hard Rule 14',
		);
		expect(flat).toContain(
			'no pinned critic is eligible: the pinned critic serves with the disclosure',
		);
		expect(flat).toContain('the generic fallback does not apply');
		expect(flat).toContain('correct it, do not follow it');
	});

	test('the pre-synthesis gate carries the critic independence slot', () => {
		expect(flat).toContain('critic agent type / independence:');
		expect(flat).toContain('independent generic fallback');
		expect(flat).toContain('N/A — no critic dispatch');
		expect(flat).toContain('only DEGRADED restricts the verdict, to REQUEST_CHANGES or INCOMPLETE');
	});

	test('the verdict table and provenance carry the gate consequence', () => {
		expect(flat).toContain(
			'and the Pre-Synthesis critic-independence gate is not DEGRADED',
		);
		expect(flat).toContain(
			'- critic agent type / model independence for the critic gate,',
		);
	});
});
