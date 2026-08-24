/**
 * Issue #2279 — the producer-facing contract must not drift from enforcement.
 *
 * The ONLY producer of PR-review findings records is an agent following
 * `.opencode/skills/swarm-pr-review/SKILL.md`; no `src/` code composes them. So
 * when the gate tightened to require `severity`, the skill's copyable example
 * and its "Minimum field contract" list became the actual break surface — and
 * nothing tested them. The final critic caught a copy-paste template that the
 * gate now rejects verbatim.
 *
 * These tests pin the doc against the enum the gate enforces, so the two cannot
 * silently diverge again.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	CANDIDATE_SEVERITIES,
	FINDINGS_SEVERITIES,
} from '../../../src/background/candidate-contract';

const SKILL_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'.opencode',
	'skills',
	'swarm-pr-review',
	'SKILL.md',
);

const CONTRACT_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'.opencode',
	'skills',
	'swarm-pr-review',
	'references',
	'findings-persistence-contract.md',
);

const readSkill = (): string => fs.readFileSync(SKILL_PATH, 'utf8');

/** The copyable findings-record example under "must include at least". */
function exampleRecord(source: string): Record<string, unknown> {
	const anchor = source.indexOf('Each persisted finding record must include');
	expect(anchor).toBeGreaterThan(-1);
	const match = source.slice(anchor).match(/\{"finding_id"[^\n]*\}/);
	if (!match) throw new Error('no copyable findings-record example found');
	return JSON.parse(match[0]) as Record<string, unknown>;
}

describe('swarm-pr-review producer contract matches enforcement (#2279)', () => {
	test('the copyable example carries a severity', () => {
		// A template that omits severity is rejected by the gate with
		// `severity expected …, got (omitted)` — i.e. the doc would be handing the
		// agent a payload guaranteed to fail.
		expect(exampleRecord(readSkill())).toHaveProperty('severity');
	});

	test('the example severity is legal at post_explorer', () => {
		const severity = exampleRecord(readSkill()).severity as string;
		// The example depicts a record projecting a discovered `[CANDIDATE]` row,
		// so its severity must come from the CANDIDATE vocabulary — a candidate row
		// can never declare NONE. (NONE IS legal at `post_explorer` for the
		// mechanically derived CLEAN-REVIEW sentinel, which has no row; the example
		// is not that case.)
		expect(CANDIDATE_SEVERITIES as readonly string[]).toContain(severity);
		expect(severity).not.toBe('NONE');
	});

	test('the minimum field contract enumerates severity', () => {
		const source = readSkill();
		const start = source.indexOf('Minimum field contract:');
		expect(start).toBeGreaterThan(-1);
		// Bounded to the bullet list that follows the heading.
		const section = source.slice(start, start + 2000);
		expect(section).toMatch(/^- `severity`:/m);
		// The list is an affirmative enumeration; a reader treats an absent field
		// as optional, which is exactly the drift this pins.
		expect(section).toMatch(/REQUIRED/);
	});

	test('the contract reference documents the full findings dialect', () => {
		const contract = fs.readFileSync(CONTRACT_PATH, 'utf8');
		for (const severity of FINDINGS_SEVERITIES) {
			expect(contract).toContain(severity);
		}
		// The removed rule must stay removed: omission is no longer a remedy.
		// Scanned sentence-by-sentence rather than with one wide regex. An earlier
		// version of this check was silently inert, so the shape here is chosen to
		// be directly checkable: does any single sentence pair omit-language with
		// the field name?
		const sentences = contract
			.replace(/\s+/g, ' ')
			.split(/(?<=\.)\s+/)
			.map((sentence) => sentence.toLowerCase());
		const omissionRules = sentences.filter(
			(sentence) =>
				/\bomit(s|ted|ting)?\b/.test(sentence) &&
				sentence.includes('severity') &&
				// The contract legitimately describes REJECTING an omitted severity,
				// which is the opposite of prescribing omission.
				!sentence.includes('(omitted)') &&
				!sentence.includes('omitting it') &&
				!sentence.includes('is gone'),
		);
		expect(omissionRules).toEqual([]);
		expect(contract).not.toContain('omit field');
		// And the field must be affirmatively described as required.
		expect(contract).toContain('`severity` is REQUIRED');
	});

	test('the skill no longer advertises severity as prose inside evidence', () => {
		// Pre-#2279 the skill told the agent to put "severity/action notes in
		// `evidence`", which trains exactly the wrong model now that severity is a
		// validated field compared against an authority.
		expect(readSkill()).not.toContain('severity/action notes in `evidence`');
	});
});
