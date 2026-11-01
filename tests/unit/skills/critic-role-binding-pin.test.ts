import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Text pin for the Phase 8 "Critic role binding" policy paragraph
// (swarm-pr-review feedback round, 2026-11-01). Guards against silent
// loss of the binding clauses the installed condensed copies must mirror:
// pinned-first resolution, the eligibility requirement (model independence
// from the reviewer), the disclosed same-family degraded gate, the Profile A
// carve-out, and the defective-copy rule.
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
		expect(flat).toContain('degraded-independence disclosure');
		expect(flat).toContain('the generic fallback does not apply');
		expect(flat).toContain('correct it, do not follow it');
	});

	test('the pre-synthesis gate carries the critic independence slot', () => {
		expect(flat).toContain('critic agent type / independence:');
		expect(flat).toContain('restricts the verdict to REQUEST_CHANGES or INCOMPLETE');
	});
});
