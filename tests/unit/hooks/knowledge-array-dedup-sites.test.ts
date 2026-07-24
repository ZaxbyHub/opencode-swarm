/**
 * Call-site regression tests for the positional-cap defect class
 * (issue #1821 Lane 0b).
 *
 * Each `describe` below pins one of the six sites that used a bare
 * `.slice(0, 20)` with no deduplication. Before the fix, duplicates survived
 * AND — because the cap counted positions rather than distinct values — evicted
 * distinct values off the end of the array. Every site now routes through
 * `dedupeCapped`.
 *
 * Sites 1 and 2 (knowledge_add) live in
 * tests/unit/tools/knowledge-add-dedup.test.ts.
 *
 * No mocks: every function under test is pure and exported.
 */

import { describe, expect, it } from 'bun:test';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { parseStructuredCuratorBlocks } from '../../../src/hooks/curator.js';
import { insightCandidateToEntry } from '../../../src/hooks/knowledge-curator.js';
import type { InsightCandidate } from '../../../src/hooks/micro-reflector.js';
import { parseMicroCandidates } from '../../../src/hooks/micro-reflector.js';

const config = KnowledgeConfigSchema.parse({});

function candidate(extra: Partial<InsightCandidate> = {}): InsightCandidate {
	return {
		lesson: 'Re-run the failing test before declaring the fix complete',
		category: 'testing',
		tags: [],
		applies_to_agents: ['coder'],
		required_actions: ['run the failing test before finishing'],
		source: {
			kind: 'micro_reflection',
			task_id: 't-1',
			agent: 'coder',
			outcome: 'failure_test',
			trajectory_steps: 3,
		},
		created_at: '2026-01-01T00:00:00.000Z',
		...extra,
	};
}

describe('#1821 site 3 — regression: knowledge-curator insightCandidateToEntry tags', () => {
	it('dedupes tags case-insensitively, keeping the first casing', () => {
		const entry = insightCandidateToEntry(
			candidate({ tags: ['Testing', 'testing', 'TESTING', 'ci-cd'] }),
			'proj',
			2,
			config,
		);
		expect(entry.tags).toEqual(['Testing', 'ci-cd']);
	});

	it('keeps distinct tags a positional slice would have evicted', () => {
		const entry = insightCandidateToEntry(
			candidate({
				tags: [
					...Array.from({ length: 15 }, () => 'flaky'),
					...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
				],
			}),
			'proj',
			2,
			config,
		);
		expect(entry.tags).toHaveLength(11);
		expect(entry.tags).toContain('keep-5');
		expect(entry.tags).toContain('keep-9');
	});

	it('still caps distinct tags at 20', () => {
		const entry = insightCandidateToEntry(
			candidate({ tags: Array.from({ length: 30 }, (_, i) => `t-${i}`) }),
			'proj',
			2,
			config,
		);
		expect(entry.tags).toHaveLength(20);
	});

	it('drops non-string tags (the bare slice let them through)', () => {
		const entry = insightCandidateToEntry(
			candidate({
				tags: ['ok', 5, null, 'fine'] as unknown as string[],
			}),
			'proj',
			2,
			config,
		);
		expect(entry.tags).toEqual(['ok', 'fine']);
	});

	it('returns [] when tags is not an array', () => {
		const entry = insightCandidateToEntry(
			candidate({ tags: 'testing' as unknown as string[] }),
			'proj',
			2,
			config,
		);
		expect(entry.tags).toEqual([]);
	});
});

describe('#1821 site 4 — regression: micro-reflector parseMicroCandidates arrays', () => {
	const meta = {
		agent: 'coder' as const,
		outcome: 'failure_test' as const,
		taskId: 't-1',
		steps: 3,
	};

	function parseOne(fields: Record<string, unknown>) {
		const response = JSON.stringify([
			{
				lesson: 'Re-run the failing test before declaring the fix complete',
				category: 'testing',
				...fields,
			},
		]);
		return parseMicroCandidates(response, meta);
	}

	it('dedupes duplicate required_actions', () => {
		const out = parseOne({
			applies_to_agents: ['coder'],
			required_actions: ['run tests', 'run tests', 'RUN TESTS', 'lint'],
		});
		expect(out).toHaveLength(1);
		expect(out[0].required_actions).toEqual(['run tests', 'lint']);
	});

	it('keeps distinct directives a positional slice would have evicted', () => {
		const out = parseOne({
			applies_to_agents: ['coder'],
			required_actions: [
				...Array.from({ length: 15 }, () => 'same action'),
				...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
			],
		});
		expect(out).toHaveLength(1);
		expect(out[0].required_actions).toHaveLength(11);
		expect(out[0].required_actions).toContain('keep-5');
		expect(out[0].required_actions).toContain('keep-9');
	});

	it('still truncates each item to 200 chars', () => {
		const out = parseOne({
			applies_to_agents: ['coder'],
			required_actions: ['z'.repeat(500)],
		});
		expect(out[0].required_actions?.[0]).toHaveLength(200);
	});

	it('truncates BEFORE deduping, so truncation can create a duplicate', () => {
		const shared = 'q'.repeat(200);
		const out = parseOne({
			applies_to_agents: ['coder'],
			required_actions: [`${shared}AAA`, `${shared}BBB`],
		});
		expect(out[0].required_actions).toEqual([shared]);
	});

	it('caps distinct directives at 20 (validateActionableFields max)', () => {
		const out = parseOne({
			applies_to_agents: ['coder'],
			required_actions: Array.from({ length: 25 }, (_, i) => `action-${i}`),
		});
		expect(out).toHaveLength(1);
		expect(out[0].required_actions).toHaveLength(20);
	});

	it('dedupes applies_to_agents without dropping the candidate', () => {
		const out = parseOne({
			applies_to_agents: ['coder', 'coder', 'reviewer'],
			required_actions: ['run tests'],
		});
		expect(out[0].applies_to_agents).toEqual(['coder', 'reviewer']);
	});
});

describe('#1821 site 6 — regression: curator evidence_refs', () => {
	function parseFindings(evidence_refs: unknown) {
		return parseStructuredCuratorBlocks(
			[
				'```json knowledge_application_findings',
				JSON.stringify([
					{
						knowledge_id: 'k-1',
						verdict: 'applied',
						expected_behavior: 'ran the tests',
						observed_behavior: 'tests ran',
						evidence_refs,
					},
				]),
				'```',
			].join('\n'),
		);
	}

	it('dedupes duplicate evidence refs case-insensitively', () => {
		const out = parseFindings([
			'plan.md:42',
			'plan.md:42',
			'PLAN.MD:42',
			'x.ts:1',
		]);
		expect(out.diagnostics).toEqual([]);
		expect(out.findings[0].evidence_refs).toEqual(['plan.md:42', 'x.ts:1']);
	});

	it('keeps distinct refs a positional slice would have evicted', () => {
		const out = parseFindings([
			...Array.from({ length: 15 }, () => 'same.ts:1'),
			...Array.from({ length: 10 }, (_, i) => `keep-${i}.ts:1`),
		]);
		expect(out.findings[0].evidence_refs).toHaveLength(11);
		expect(out.findings[0].evidence_refs).toContain('keep-5.ts:1');
		expect(out.findings[0].evidence_refs).toContain('keep-9.ts:1');
	});

	it('does NOT truncate individual refs (site has no per-item cap)', () => {
		const longRef = `${'p'.repeat(400)}.ts:1`;
		const out = parseFindings([longRef]);
		expect(out.findings[0].evidence_refs).toEqual([longRef]);
	});

	it('still caps distinct refs at 20 and filters non-strings', () => {
		const out = parseFindings([
			...Array.from({ length: 25 }, (_, i) => `r-${i}.ts:1`),
			7,
			null,
		]);
		expect(out.findings[0].evidence_refs).toHaveLength(20);
	});

	it('returns [] when evidence_refs is not an array', () => {
		const out = parseFindings('plan.md:42');
		expect(out.findings[0].evidence_refs).toEqual([]);
	});
});

describe('#1821 site 5 — regression: curator arrayOfStrings in skill_candidates', () => {
	function parseCandidate(fields: Record<string, unknown>) {
		return parseStructuredCuratorBlocks(
			[
				'```json skill_candidates',
				JSON.stringify([
					{
						slug: 'run-tests',
						title: 'Run tests before finishing',
						source_knowledge_ids: ['k-1'],
						...fields,
					},
				]),
				'```',
			].join('\n'),
		);
	}

	it('dedupes required_procedure case-insensitively', () => {
		const out = parseCandidate({
			required_procedure: ['step one', 'STEP ONE', 'step two'],
		});
		expect(out.diagnostics).toEqual([]);
		expect(out.candidates[0].required_procedure).toEqual([
			'step one',
			'step two',
		]);
	});

	it('keeps distinct steps a positional slice would have evicted', () => {
		const out = parseCandidate({
			forbidden_shortcuts: [
				...Array.from({ length: 15 }, () => 'never skip tests'),
				...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
			],
		});
		expect(out.candidates[0].forbidden_shortcuts).toHaveLength(11);
		expect(out.candidates[0].forbidden_shortcuts).toContain('keep-5');
		expect(out.candidates[0].forbidden_shortcuts).toContain('keep-9');
	});

	it('still truncates each item to 200 chars', () => {
		const out = parseCandidate({ target_agents: ['w'.repeat(500)] });
		expect(out.candidates[0].target_agents[0]).toHaveLength(200);
	});

	it('truncates BEFORE deduping, so truncation can create a duplicate', () => {
		const shared = 'v'.repeat(200);
		const out = parseCandidate({
			reviewer_checks: [`${shared}AAA`, `${shared}BBB`],
		});
		expect(out.candidates[0].reviewer_checks).toEqual([shared]);
	});

	it('still returns [] for a non-array and caps distinct values at 20', () => {
		const out = parseCandidate({
			required_procedure: 'not an array',
			reviewer_checks: Array.from({ length: 25 }, (_, i) => `check-${i}`),
		});
		expect(out.candidates[0].required_procedure).toEqual([]);
		expect(out.candidates[0].reviewer_checks).toHaveLength(20);
	});
});
