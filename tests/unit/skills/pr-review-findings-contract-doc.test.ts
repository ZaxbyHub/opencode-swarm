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
import {
	PR_REVIEW_ARTIFACT_BOUNDARIES,
	PR_REVIEW_CRITIC_STATUSES,
	PR_REVIEW_FINDING_ACTIONS,
	PR_REVIEW_FINDING_STATUSES,
	PR_REVIEW_REVIEWER_CLASSIFICATIONS,
	PR_REVIEW_REVIEWER_EVIDENCE_TYPES,
	PR_REVIEW_SEVERITIES,
	PR_REVIEW_VERDICT_ROW_DESCRIPTORS,
	WritePrReviewArtifactArgsSchema,
} from '../../../src/background/pr-review-contract';

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

const DRY_RUN_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'.opencode',
	'skills',
	'swarm-pr-review',
	'references',
	'parser-dry-run.md',
);

const PROMPT_TEMPLATES_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'.opencode',
	'skills',
	'swarm-pr-review',
	'references',
	'prompt-templates.md',
);

const RECOVERABILITY_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'.opencode',
	'skills',
	'swarm-pr-review',
	'references',
	'lane-output-recoverability.md',
);

const readSkill = (): string => fs.readFileSync(SKILL_PATH, 'utf8');

function executableDialect(source: string): Record<string, string[]> {
	const block = source.match(
		/<!-- PR_REVIEW_EXECUTABLE_DIALECT_START -->([\s\S]*?)<!-- PR_REVIEW_EXECUTABLE_DIALECT_END -->/,
	)?.[1];
	if (!block) throw new Error('missing executable PR-review dialect block');
	return Object.fromEntries(
		block
			.trim()
			.split(/\r?\n/)
			.map((line) => {
				const [key, values] = line.split(': ');
				if (!key || !values) throw new Error(`malformed dialect line: ${line}`);
				return [key, values.split(' | ')];
			}),
	);
}

describe('skill dialect is structurally identical to the executable PR-review contract (#2333)', () => {
	test('reference enums and row roles match the central schemas exactly', () => {
		const dialect = executableDialect(fs.readFileSync(CONTRACT_PATH, 'utf8'));
		expect(dialect.reviewer_fields).toEqual([
			...PR_REVIEW_VERDICT_ROW_DESCRIPTORS.reviewer.fieldRoles,
		]);
		expect(dialect.critic_fields).toEqual([
			...PR_REVIEW_VERDICT_ROW_DESCRIPTORS.critic.fieldRoles,
		]);
		expect(dialect.reviewer_classifications).toEqual([
			...PR_REVIEW_REVIEWER_CLASSIFICATIONS,
		]);
		expect(dialect.reviewer_evidence_types).toEqual([
			...PR_REVIEW_REVIEWER_EVIDENCE_TYPES,
		]);
		expect(dialect.critic_statuses).toEqual([...PR_REVIEW_CRITIC_STATUSES]);
		expect(dialect.severities).toEqual([...PR_REVIEW_SEVERITIES]);
		expect(dialect.finding_statuses).toEqual([...PR_REVIEW_FINDING_STATUSES]);
		expect(dialect.finding_actions).toEqual([...PR_REVIEW_FINDING_ACTIONS]);
		expect(dialect.artifact_boundaries).toEqual([
			...PR_REVIEW_ARTIFACT_BOUNDARIES,
		]);
	});

	test('every live agent-facing verdict grammar uses the schema field roles', () => {
		const reviewerGrammar =
			PR_REVIEW_VERDICT_ROW_DESCRIPTORS.reviewer.fieldRoles
				.map((role, index) =>
					index === 0
						? PR_REVIEW_VERDICT_ROW_DESCRIPTORS.reviewer.marker
						: role,
				)
				.join(' | ');
		const criticGrammar = PR_REVIEW_VERDICT_ROW_DESCRIPTORS.critic.fieldRoles
			.map((role, index) =>
				index === 0 ? PR_REVIEW_VERDICT_ROW_DESCRIPTORS.critic.marker : role,
			)
			.join(' | ');
		const documents = [
			[SKILL_PATH, 1, 2],
			[PROMPT_TEMPLATES_PATH, 1, 2],
			[DRY_RUN_PATH, 1, 0],
		] as const;
		for (const [documentPath, reviewerCount, criticCount] of documents) {
			const lines = fs.readFileSync(documentPath, 'utf8').split(/\r?\n/);
			const reviewerLines = lines.filter((line) =>
				line.includes('[REVIEWED] |'),
			);
			const criticLines = lines.filter((line) => line.includes('[CRITIC] |'));
			expect(reviewerLines).toHaveLength(reviewerCount);
			expect(criticLines).toHaveLength(criticCount);
			for (const line of reviewerLines) expect(line).toContain(reviewerGrammar);
			for (const line of criticLines) expect(line).toContain(criticGrammar);
		}
	});

	test('the live reviewer classification tables contain the exact schema enums', () => {
		const source = readSkill();
		const tableValues = (start: string, end: string): string[] => {
			const section = source.slice(source.indexOf(start), source.indexOf(end));
			return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map(
				(match) => match[1],
			);
		};
		expect(
			tableValues(
				'### Reviewer classifications',
				'### Evidence classifications',
			),
		).toEqual([...PR_REVIEW_REVIEWER_CLASSIFICATIONS]);
		expect(
			tableValues('### Evidence classifications', 'Reviewer output format:'),
		).toEqual([...PR_REVIEW_REVIEWER_EVIDENCE_TYPES]);
	});

	test('tool schema accepts every documented finding enum and boundary token', () => {
		for (const boundary of PR_REVIEW_ARTIFACT_BOUNDARIES) {
			for (const status of PR_REVIEW_FINDING_STATUSES) {
				for (const nextAction of PR_REVIEW_FINDING_ACTIONS) {
					expect(
						WritePrReviewArtifactArgsSchema.safeParse({
							kind: 'findings',
							run_id: 'parity-run',
							pr_head_sha: 'abc123',
							boundary,
							records: [
								{
									finding_id: 'C-1',
									status,
									file_line: 'src/index.ts:1',
									evidence: 'schema parity',
									next_action: nextAction,
									severity: 'HIGH',
								},
							],
						}).success,
					).toBe(true);
				}
			}
		}
	});
});

/** The copyable findings-record example under "must include at least". */
function exampleRecord(source: string): Record<string, unknown> {
	const anchor = source.indexOf('Each persisted finding record must include');
	expect(anchor).toBeGreaterThan(-1);
	const match = source.slice(anchor).match(/\{"finding_id"[^\n]*\}/);
	if (!match) throw new Error('no copyable findings-record example found');
	return JSON.parse(match[0]) as Record<string, unknown>;
}

describe('parser receipt docs match the code that emits them (PRR-005/PRR-006)', () => {
	// These two references were edited by this change but had no doc-to-code pin,
	// so they could silently drift from the fields the parser actually emits.
	test('the entry skill names the receipt fields, not only the reference', () => {
		// SKILL.md is the declared producer-facing contract — an agent that only
		// reads the entry file must still learn these exist.
		const skill = readSkill();
		expect(skill).toContain('repair_kinds');
		expect(skill).toContain('clean_attestation_salvaged');
	});

	test('parser-dry-run documents every receipt field the parser can emit', () => {
		const dryRun = fs.readFileSync(DRY_RUN_PATH, 'utf8');
		for (const field of [
			'repair_kinds',
			'clean_attestation_salvaged',
			'clean_attestation_salvage_reason',
		]) {
			expect(dryRun).toContain(field);
		}
	});

	test('lane-output-recoverability enumerates every live recovery kind', () => {
		const doc = fs.readFileSync(RECOVERABILITY_PATH, 'utf8');
		// Derived from the closed union in pending-delegations.ts rather than
		// hand-listed, so a new kind cannot be added without updating the doc.
		const unionSource = fs.readFileSync(
			path.join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'src',
				'background',
				'pending-delegations.ts',
			),
			'utf8',
		);
		const union = unionSource.match(
			/export type BackgroundDelegationRecoveryKind =([\s\S]*?);/,
		);
		if (!union) {
			throw new Error(
				'BackgroundDelegationRecoveryKind union not found — update this pin rather than deleting it',
			);
		}
		const kinds = [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
		expect(kinds.length).toBeGreaterThanOrEqual(5);
		for (const kind of kinds) {
			expect(doc).toContain(kind);
		}
	});
});

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
