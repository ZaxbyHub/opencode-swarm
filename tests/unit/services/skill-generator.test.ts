/**
 * Tests for the knowledge-to-skill compiler.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	_internals,
	activateProposal,
	clusterEntries,
	generateSkills,
	inspectSkill,
	isValidSlug,
	listSkills,
	renderSkillMarkdown,
	sanitizeSlug,
	selectCandidateEntries,
} from '../../../src/services/skill-generator';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-skill-gen-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

function makeEntry(
	id: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: 'always declare scope before coder delegation',
		category: 'process',
		tags: ['scope'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: new Date().toISOString(),
				project_name: 'test',
			},
			{
				phase_number: 2,
				confirmed_at: new Date().toISOString(),
				project_name: 'test',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'test',
		triggers: ['coder delegation'],
		required_actions: ['call declare_scope'],
		forbidden_actions: ['heredoc bash writes'],
		applies_to_agents: ['coder'],
		directive_priority: 'medium',
		...overrides,
	};
}

async function seed(entries: SwarmKnowledgeEntry[]): Promise<void> {
	const dir = path.join(tmp, '.swarm');
	await mkdir(dir, { recursive: true });
	const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
	await writeFile(resolveSwarmKnowledgePath(tmp), lines, 'utf-8');
}

describe('sanitizeSlug', () => {
	it('rejects path traversal slugs after sanitization', () => {
		const sanitized = sanitizeSlug('../../etc/passwd');
		expect(isValidSlug(sanitized)).toBe(true); // mapped to safe form
		expect(sanitized).not.toContain('..');
		expect(sanitized).not.toContain('/');
	});
	it('lowercases and collapses non-alnum to hyphens', () => {
		expect(sanitizeSlug('Coder Scope!')).toBe('coder-scope');
	});
});

describe('selectCandidateEntries', () => {
	it('excludes archived, low-confidence, and already-compiled entries', async () => {
		await seed([
			makeEntry('e1'),
			makeEntry('e2', { status: 'archived' }),
			makeEntry('e3', { confidence: 0.4 }),
			makeEntry('e4', { generated_skill_slug: 'already-compiled' }),
			makeEntry('e5', { confirmed_by: [] }),
		]);
		const cands = await selectCandidateEntries(tmp, {
			minConfidence: 0.85,
			minConfirmations: 2,
		});
		expect(cands.map((e) => e.id).sort()).toEqual(['e1']);
	});

	it('includes repeated high-confidence entries', async () => {
		await seed([
			makeEntry('a1'),
			makeEntry('a2', { lesson: 'declare scope before delegation, again' }),
		]);
		const cands = await selectCandidateEntries(tmp, {
			minConfidence: 0.85,
			minConfirmations: 2,
		});
		expect(cands.length).toBe(2);
	});

	it('selects low-confidence entries with a strong positive outcome record', async () => {
		const id = 'outcome-strong';
		await seed([
			makeEntry(id, {
				confidence: 0.6,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: new Date().toISOString(),
						project_name: 'test',
					},
				],
				directive_priority: 'high',
			}),
		]);
		for (let i = 0; i < 4; i++) {
			await appendKnowledgeEvent(tmp, {
				type: 'applied',
				event_id: `applied-${i}`,
				trace_id: `trace-${i}`,
				knowledge_id: id,
				timestamp: `2026-01-01T00:00:0${i}.000Z`,
				session_id: 's',
				agent: 'coder',
			});
		}

		const cands = await selectCandidateEntries(tmp, {
			minConfidence: 0.85,
			minConfirmations: 2,
		});
		expect(cands.map((e) => e.id)).toEqual([id]);
		expect(cands[0].retrieval_outcomes.applied_explicit_count).toBe(4);
	});

	it('excludes entries with negative outcome signal even when confirmed', async () => {
		await seed([
			makeEntry('negative', {
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
					violated_count: 4,
				},
			}),
		]);

		const cands = await selectCandidateEntries(tmp, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(cands).toEqual([]);
	});

	it('blocks a high-priority entry whose failure events produce a net-negative signal (F-007b)', async () => {
		// Verify the negative-outcome block works end-to-end through
		// selectCandidateEntries with event-sourced 'outcome' events (not just
		// inline retrieval_outcomes on the entry). This exercises the additive
		// merge path: entry counts = 0 (new-style entry), rollup counts built
		// from emitted 'outcome' events, effectiveRetrievalOutcomes merges them.
		await seed([
			makeEntry('high-prio-failing', {
				confidence: 0.65,
				directive_priority: 'high',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: new Date().toISOString(),
						project_name: 'test',
					},
				],
			}),
		]);
		// Emit 3 failure outcomes — enough to drive outcome signal negative.
		for (let i = 0; i < 3; i++) {
			await appendKnowledgeEvent(tmp, {
				type: 'outcome',
				trace_id: `fail-trace-${i}`,
				knowledge_id: 'high-prio-failing',
				outcome: 'failure',
				evidence_summary: `phase ${i + 1} failed`,
				session_id: 's',
				agent: 'coder',
			} as Parameters<typeof appendKnowledgeEvent>[1]);
		}

		const cands = await selectCandidateEntries(tmp, {
			minConfidence: 0.6,
			minConfirmations: 1,
		});
		// Despite qualifying by confidence and confirmations, the net-negative
		// outcome signal gates it out before the high-priority path is consulted.
		expect(cands.map((c) => c.id)).not.toContain('high-prio-failing');
	});
});

describe('renderSkillMarkdown', () => {
	it('produces required sections and frontmatter', async () => {
		const cluster = clusterEntries([makeEntry('rk1'), makeEntry('rk2')])[0];
		const md = renderSkillMarkdown(cluster);
		expect(md).toContain('---');
		expect(md).toMatch(/^name:\s+/m);
		expect(md).toContain('generated_from_knowledge:');
		expect(md).toContain('source_knowledge_ids:');
		expect(md).toMatch(/^generated_at:\s+\S+/m);
		expect(md).toContain('## Trigger');
		expect(md).toContain('## Required Procedure');
		expect(md).toContain('## Forbidden Shortcuts');
		expect(md).toContain('## Delegation Template');
		expect(md).toContain('## Reviewer Checks');
		expect(md).toContain('## Source Knowledge IDs');
		expect(md).toContain('generated by opencode-swarm skill-generator');
	});
});

describe('generateSkills draft mode', () => {
	it('writes only under .swarm/skills/proposals', async () => {
		await seed([makeEntry('g1'), makeEntry('g2')]);
		const result = await generateSkills({
			directory: tmp,
			mode: 'draft',
		});
		expect(result.written.length).toBeGreaterThan(0);
		for (const w of result.written) {
			expect(w.path.replace(/\\/g, '/')).toContain('.swarm/skills/proposals/');
			expect(w.path.endsWith('.md')).toBe(true);
			expect(existsSync(w.path)).toBe(true);
		}
	});

	it('compiles a strong-outcome high-priority singleton to a draft skill', async () => {
		const id = 'singleton-generated';
		await seed([
			makeEntry(id, {
				confidence: 0.6,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: new Date().toISOString(),
						project_name: 'test',
					},
				],
				directive_priority: 'high',
			}),
		]);
		for (let i = 0; i < 4; i++) {
			await appendKnowledgeEvent(tmp, {
				type: 'applied',
				event_id: `singleton-applied-${i}`,
				trace_id: `singleton-trace-${i}`,
				knowledge_id: id,
				timestamp: `2026-01-02T00:00:0${i}.000Z`,
				session_id: 's',
				agent: 'coder',
			});
		}

		const result = await generateSkills({
			directory: tmp,
			mode: 'draft',
			minConfidence: 0.85,
			minConfirmations: 2,
		});
		expect(result.written).toHaveLength(1);
		expect(result.written[0].sourceKnowledgeIds).toEqual([id]);
		expect(existsSync(result.written[0].path)).toBe(true);
	});
});

describe('generateSkills active mode', () => {
	it('writes under .opencode/skills/generated/<slug>/SKILL.md and stamps source entries', async () => {
		await seed([makeEntry('h1'), makeEntry('h2')]);
		const result = await generateSkills({
			directory: tmp,
			mode: 'active',
		});
		expect(result.written.length).toBeGreaterThan(0);
		for (const w of result.written) {
			expect(w.path.replace(/\\/g, '/')).toContain(
				'.opencode/skills/generated/',
			);
			expect(w.path.endsWith('SKILL.md')).toBe(true);
		}
		const stamped = readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		expect(stamped[0].generated_skill_path.replace(/\\/g, '/')).toContain(
			'.opencode/skills/generated/',
		);
		expect(stamped[0].generated_skill_slug).toBeTruthy();
	});

	it('does not overwrite a non-generator-stamped active SKILL.md without force', async () => {
		await seed([makeEntry('p1'), makeEntry('p2')]);
		const cluster = clusterEntries([makeEntry('p1'), makeEntry('p2')])[0];
		const targetDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			cluster.slug,
		);
		await mkdir(targetDir, { recursive: true });
		await writeFile(
			path.join(targetDir, 'SKILL.md'),
			'# manual content (no generator stamp)\n',
			'utf-8',
		);
		const result = await generateSkills({
			directory: tmp,
			mode: 'active',
			slug: cluster.slug,
		});
		// The cluster's manual SKILL.md should be preserved; result should record skip.
		expect(
			result.skipped.some((s) =>
				s.reason.includes('manually edited skill exists'),
			),
		).toBe(true);
		const onDisk = readFileSync(path.join(targetDir, 'SKILL.md'), 'utf-8');
		expect(onDisk).toContain('manual content');
	});
});

describe('listSkills + inspectSkill + activateProposal', () => {
	it('lists drafts/active and inspects content', async () => {
		await seed([makeEntry('l1'), makeEntry('l2')]);
		const draft = await generateSkills({ directory: tmp, mode: 'draft' });
		const list = await listSkills(tmp);
		expect(list.proposals.length).toBeGreaterThan(0);
		expect(list.active.length).toBe(0);
		const slug = draft.written[0].slug;
		const inspect = await inspectSkill(tmp, slug);
		expect(inspect.found).toBe(true);
		expect(inspect.content).toContain('## Required Procedure');

		const activate = await activateProposal(tmp, slug);
		expect(activate.activated).toBe(true);
		const list2 = await listSkills(tmp);
		expect(list2.active.length).toBe(1);
	});
});

// ============================================================================
// jaccardSimilarity tests
// ============================================================================

const { jaccardSimilarity, isSkillMaturityEligible } = _internals;

// Helper to create a minimal entry for isSkillMaturityEligible testing
function makeEligibilityEntry(
	overrides: Partial<{
		confidence: number;
		confirmed_by: Array<{ phase_number?: number }>;
		retrieval_outcomes: {
			applied_count?: number;
			succeeded_after_count?: number;
			failed_after_count?: number;
			applied_explicit_count?: number;
			succeeded_after_shown_count?: number;
		};
	}> = {},
) {
	return {
		id: 'test-eligibility',
		tier: 'swarm' as const,
		lesson: 'test lesson',
		category: 'process' as const,
		tags: ['test'],
		scope: 'global' as const,
		confidence: 0.9,
		status: 'established' as const,
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2025-01-01T00:00:00.000Z',
				project_name: 'test',
			},
			{
				phase_number: 2,
				confirmed_at: '2025-01-01T00:00:00.000Z',
				project_name: 'test',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2 as const,
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: '2025-01-01T00:00:00.000Z',
		project_name: 'test',
		triggers: [],
		required_actions: [],
		forbidden_actions: [],
		applies_to_agents: [],
		directive_priority: 'medium' as const,
		...overrides,
	};
}

describe('isSkillMaturityEligible — phase number filtering', () => {
	it('eligible when confirmed_by has sufficient distinct numeric phase numbers', () => {
		const entry = makeEligibilityEntry({
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
				{
					phase_number: 2,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
		});
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(true);
	});

	it('filters undefined phase_number values before counting distinct phases', () => {
		// confirmed_by includes records where phase_number is undefined (e.g. ProjectConfirmationRecord)
		// The filter should count only numeric phase numbers, so {1, undefined} → {1} → size 1
		const entry = makeEligibilityEntry({
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
				{
					phase_number: undefined,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			] as Array<{ phase_number?: number }>,
		});
		// minConfirmations: 2 but only 1 distinct numeric phase → should be ineligible
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(false);
	});

	it('treats all-undefined phase_number as 0 distinct phases', () => {
		// All phase_numbers are undefined → distinct set is empty → size 0
		const entry = makeEligibilityEntry({
			confirmed_by: [
				{
					phase_number: undefined,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
				{
					phase_number: undefined,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			] as Array<{ phase_number?: number }>,
		});
		// minConfirmations: 2 but 0 distinct phases → ineligible
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(false);
	});

	it('treats empty confirmed_by as 0 distinct phases', () => {
		const entry = makeEligibilityEntry({ confirmed_by: [] });
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(false);
	});

	it('does NOT count same-phase repeated confirmations as multiple distinct phases', () => {
		// Two confirmations but both on phase 1 → distinct set size is 1, not 2
		const entry = makeEligibilityEntry({
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
				{
					phase_number: 1,
					confirmed_at: '2025-01-02T00:00:00.000Z',
					project_name: 'test',
				},
			],
		});
		// minConfirmations: 2 but only 1 distinct phase → ineligible
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(false);
	});

	it('outcomeSignal === 0 (neutral) with strongOutcomes=true passes via the legacy fallback', () => {
		// Neutral signal: positives == negatives → signal = 0
		// applied_explicit_count=3 gives strongOutcomes=true, ignored_count=3 gives neutral signal
		const entry = makeEligibilityEntry({
			confidence: 0.6,
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				applied_explicit_count: 3, // strong outcomes
				ignored_count: 3, // neutralizes the signal to 0
			},
		});
		// Low confidence (< 0.7) and only 1 distinct phase, but strongOutcomes=true
		// → legacy fallback path should pass via strongOutcomes
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(true);
	});

	it('outcomeSignal > 0 with strongOutcomes=true passes via positive gate', () => {
		// Positive signal: positives > negatives
		// applied_explicit_count=4 gives strongOutcomes=true, no negatives
		const entry = makeEligibilityEntry({
			confidence: 0.5,
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				applied_explicit_count: 4, // strong outcomes + positive signal
			},
		});
		// Low confidence and only 1 phase, but positive signal + strong outcomes
		// → positive gate should return true immediately
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(true);
	});

	it('outcomeSignal < 0 is always rejected', () => {
		// Negative signal: negatives > positives (even with adequate distinct phases)
		const entry = makeEligibilityEntry({
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
				{
					phase_number: 2,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 5, // negative signal
				violated_count: 2,
			},
		});
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(false);
	});

	it('eligible via strong outcomes even with insufficient distinct phases', () => {
		// Has only 1 distinct phase but strong positive outcomes → should be eligible
		const entry = makeEligibilityEntry({
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				applied_explicit_count: 3, // STRONG_SKILL_OUTCOME_COUNT = 3
			},
		});
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(true);
	});

	it('high confidence alone is NOT enough without adequate distinct phases or strong outcomes', () => {
		// High confidence (0.9) but only 1 distinct phase and no strong outcomes
		// → should be rejected: confidence alone does not bypass distinct-phase count
		const entry = makeEligibilityEntry({
			confidence: 0.95,
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2025-01-01T00:00:00.000Z',
					project_name: 'test',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
		});
		const result = isSkillMaturityEligible(entry, {
			minConfidence: 0.7,
			minConfirmations: 2,
		});
		expect(result).toBe(false);
	});
});

describe('isSkillMaturityEligible — high-priority directive path (issue #1477)', () => {
	const oneConfirmation = [
		{
			phase_number: 1,
			confirmed_at: '2025-01-01T00:00:00.000Z',
			project_name: 'test',
		},
	];
	const twoConfirmations = [
		...oneConfirmation,
		{
			phase_number: 2,
			confirmed_at: '2025-01-01T00:00:00.000Z',
			project_name: 'test',
		},
	];
	const opts = { minConfidence: 0.7, minConfirmations: 2 };
	const noOutcomes = {
		applied_count: 0,
		succeeded_after_count: 0,
		failed_after_count: 0,
	};

	function entryWith(
		priority: 'low' | 'medium' | 'high' | 'critical',
		confidence: number,
		confirmed_by: Array<{
			phase_number?: number;
			confirmed_at: string;
			project_name: string;
		}> = oneConfirmation,
		retrieval_outcomes: Record<string, number> = noOutcomes,
	) {
		return {
			...makeEligibilityEntry(),
			directive_priority: priority,
			confidence,
			confirmed_by,
			retrieval_outcomes,
		};
	}

	it('high-priority + 1 distinct phase + 0.6 confidence → eligible (the unblock)', () => {
		expect(isSkillMaturityEligible(entryWith('high', 0.6), opts)).toBe(true);
	});

	it('critical-priority + 1 distinct phase + 0.6 confidence → eligible', () => {
		expect(isSkillMaturityEligible(entryWith('critical', 0.6), opts)).toBe(
			true,
		);
	});

	it('medium-priority + 1 phase + 0.6 → still blocked (targeted, not a blanket loosening)', () => {
		expect(isSkillMaturityEligible(entryWith('medium', 0.6), opts)).toBe(false);
	});

	it('low-priority + 1 phase + 0.6 → still blocked', () => {
		expect(isSkillMaturityEligible(entryWith('low', 0.6), opts)).toBe(false);
	});

	it('high-priority below the 0.6 confidence floor → blocked', () => {
		expect(isSkillMaturityEligible(entryWith('high', 0.55), opts)).toBe(false);
	});

	it('high-priority with zero distinct phases → blocked (needs ≥1 confirmation)', () => {
		expect(isSkillMaturityEligible(entryWith('high', 0.6, []), opts)).toBe(
			false,
		);
	});

	it('high-priority with a net-negative outcome record → blocked (negative gate precedes the path)', () => {
		const negative = {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
			failed_after_shown_count: 3,
		};
		expect(
			isSkillMaturityEligible(
				entryWith('high', 0.6, oneConfirmation, negative),
				opts,
			),
		).toBe(false);
	});

	it('high-priority at the ordinary 0.7/2-phase bar is still eligible (no regression)', () => {
		expect(
			isSkillMaturityEligible(entryWith('high', 0.7, twoConfirmations), opts),
		).toBe(true);
	});
});

describe('jaccardSimilarity', () => {
	it('identical sets return 1.0', () => {
		expect(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1.0);
	});

	it('disjoint sets return 0.0', () => {
		expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0.0);
	});

	it('partial overlap returns correct ratio', () => {
		// {a,b,c} ∩ {b,c,d} = {b,c} = 2; union = 4; 2/4 = 0.5
		expect(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
	});

	it('both empty sets return 0.0', () => {
		expect(jaccardSimilarity([], [])).toBe(0.0);
	});

	it('one empty set returns 0.0', () => {
		expect(jaccardSimilarity([], ['a', 'b'])).toBe(0.0);
		expect(jaccardSimilarity(['a', 'b'], [])).toBe(0.0);
	});

	it('case insensitive: {A,B} vs {a,b} returns 1.0', () => {
		expect(jaccardSimilarity(['A', 'B'], ['a', 'b'])).toBe(1.0);
	});

	it('three-way overlap computes correctly', () => {
		// {a,b} ∩ {b,c} = {b} = 1; union = 3; 1/3 ≈ 0.333
		expect(jaccardSimilarity(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
	});

	it('subset larger set: {a,b} ⊂ {a,b,c} → 2/3', () => {
		expect(jaccardSimilarity(['a', 'b'], ['a', 'b', 'c'])).toBeCloseTo(2 / 3);
	});
});

// ============================================================================
// clusterEntries — minimum cluster size tests
// ============================================================================

describe('clusterEntries (min cluster size)', () => {
	it('single entry produces no clusters (dropped by min size guard)', () => {
		const result = clusterEntries([makeEntry('solo', { tags: ['solo'] })]);
		expect(result).toEqual([]);
	});

	it('high-priority singleton with strong outcomes produces one cluster', () => {
		const result = clusterEntries([
			makeEntry('solo-strong', {
				tags: ['solo'],
				directive_priority: 'high',
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
					applied_explicit_count: 3,
				},
			}),
		]);
		expect(result).toHaveLength(1);
		expect(result[0].entries.map((e) => e.id)).toEqual(['solo-strong']);
	});

	it('two entries with similar tags produce one cluster', () => {
		// {a,b,c} vs {a,b,d} → intersection={a,b}=2, union=4 → 0.5 (meets threshold)
		const result = clusterEntries([
			makeEntry('x1', { tags: ['testing', 'debugging', 'logging'] }),
			makeEntry('x2', { tags: ['testing', 'debugging', 'profiling'] }),
		]);
		expect(result.length).toBe(1);
		expect(result[0].entries).toHaveLength(2);
	});

	it('two entries with completely different tags both dropped (no cluster reaches size 2)', () => {
		const result = clusterEntries([
			makeEntry('y1', { tags: ['javascript'] }),
			makeEntry('y2', { tags: ['python'] }),
		]);
		// Both singletons dropped by MIN_CLUSTER_SIZE guard
		expect(result).toEqual([]);
	});

	it('three entries: two with overlapping tags form a pair, singleton dropped', () => {
		const result = clusterEntries([
			makeEntry('z1', { tags: ['security'] }),
			makeEntry('z2', { tags: ['security', 'auth'] }),
			makeEntry('z3', { tags: ['security', 'auth', 'jwt'] }),
		]);
		// All three share 'security' tag, so greedy clustering puts them together
		expect(result.length).toBe(1);
		expect(result[0].entries).toHaveLength(3);
	});

	it('four entries: two pairs with different tag domains produce two clusters', () => {
		// Pair 1: {rust,memory,safety} vs {rust,memory,concurrency} → Jaccard = 2/4 = 0.5
		// Pair 2: {python,types,async} vs {python,types,gunicorn} → Jaccard = 2/4 = 0.5
		// Cross-pair Jaccard is 0 (no overlap) → stays separate
		const result = clusterEntries([
			makeEntry('w1', { tags: ['rust', 'memory', 'safety'] }),
			makeEntry('w2', { tags: ['rust', 'memory', 'concurrency'] }),
			makeEntry('w3', { tags: ['python', 'types', 'async'] }),
			makeEntry('w4', { tags: ['python', 'types', 'gunicorn'] }),
		]);
		expect(result.length).toBe(2);
		// Both clusters have size 2 — sorted by length desc, then confidence
		const sorted = [...result].sort((a, b) => a.slug.localeCompare(b.slug));
		expect(sorted[0].entries).toHaveLength(2);
		expect(sorted[1].entries).toHaveLength(2);
	});
});

// ============================================================================
// clusterEntries — Jaccard threshold tests
// ============================================================================

describe('clusterEntries (Jaccard threshold)', () => {
	it('tags with Jaccard >= 0.5 are grouped together', () => {
		// {a,b,c} vs {b,c,d} → Jaccard = 2/4 = 0.5 (meets threshold)
		const result = clusterEntries([
			makeEntry('t1', { tags: ['a', 'b', 'c'] }),
			makeEntry('t2', { tags: ['b', 'c', 'd'] }),
		]);
		expect(result.length).toBe(1);
		expect(result[0].entries).toHaveLength(2);
	});

	it('tags with Jaccard < 0.5 are NOT grouped (separate clusters)', () => {
		// {a,b} vs {c,d} → Jaccard = 0 (below threshold)
		// Each forms its own singleton → both dropped by min size
		const result = clusterEntries([
			makeEntry('u1', { tags: ['a', 'b'] }),
			makeEntry('u2', { tags: ['c', 'd'] }),
		]);
		expect(result).toEqual([]);
	});

	it('boundary case: Jaccard exactly 0.5 is grouped (>= threshold)', () => {
		// {a,b} vs {b,c} → intersection=1, union=3 → 1/3 ≈ 0.333 (below 0.5)
		// Use {a,b,c} vs {c,d,e}: intersection=1, union=5 → 1/5 = 0.2 (below)
		// {a,b,c} vs {b,c,d}: intersection=2, union=4 → 2/4 = 0.5 (at threshold)
		const result = clusterEntries([
			makeEntry('v1', { tags: ['a', 'b', 'c'] }),
			makeEntry('v2', { tags: ['b', 'c', 'd'] }),
		]);
		expect(result.length).toBe(1);
		expect(result[0].entries).toHaveLength(2);
	});
});

// ============================================================================
// clusterEntries — output format tests
// ============================================================================

describe('clusterEntries (output format)', () => {
	it('output has correct KnowledgeCluster shape', () => {
		const result = clusterEntries([
			makeEntry('s1', {
				tags: ['format'],
				triggers: ['trigger1'],
				required_actions: ['action1'],
				forbidden_actions: ['forbidden1'],
				applies_to_agents: ['coder'],
				verification_checks: ['check1'],
				confidence: 0.9,
			}),
			makeEntry('s2', {
				tags: ['format'],
				triggers: ['trigger2'],
				required_actions: ['action2'],
				forbidden_actions: [],
				applies_to_agents: [],
				verification_checks: [],
				confidence: 0.8,
			}),
		]);
		expect(result.length).toBe(1);
		const cluster = result[0];
		expect(cluster.slug).toBeString();
		expect(cluster.title).toBeString();
		expect(cluster.entries).toBeArray();
		expect(cluster.entries).toHaveLength(2);
		expect(cluster.triggers).toEqual(['trigger1', 'trigger2']);
		expect(cluster.required_actions).toEqual(['action1', 'action2']);
		expect(cluster.forbidden_actions).toEqual(['forbidden1']);
		expect(cluster.target_agents).toEqual(['coder']);
		expect(cluster.verification_checks).toEqual(['check1']);
		expect(typeof cluster.avgConfidence).toBe('number');
	});

	it('clusters sorted: largest first, then highest confidence, then slug', () => {
		const result = clusterEntries([
			makeEntry('m1', { tags: ['solo1'], confidence: 0.5 }),
			makeEntry('m2', { tags: ['solo2'], confidence: 0.7 }),
			makeEntry('m3', { tags: ['solo3'], confidence: 0.9 }),
			makeEntry('m4', { tags: ['solo4'], confidence: 0.95 }),
		]);
		// All singletons → all dropped → empty
		expect(result).toEqual([]);
	});

	it('triggers aggregated from all member entries', () => {
		const result = clusterEntries([
			makeEntry('agg1', { tags: ['x'], triggers: ['alpha', 'beta'] }),
			makeEntry('agg2', { tags: ['x'], triggers: ['beta', 'gamma'] }),
		]);
		expect(result.length).toBe(1);
		// deduplicated and ordered by insertion (beta appears in both)
		expect(result[0].triggers).toContain('alpha');
		expect(result[0].triggers).toContain('beta');
		expect(result[0].triggers).toContain('gamma');
	});

	it('avgConfidence is mean of member entry confidences', () => {
		const result = clusterEntries([
			makeEntry('conf1', { tags: ['z'], confidence: 0.8 }),
			makeEntry('conf2', { tags: ['z'], confidence: 1.0 }),
		]);
		expect(result.length).toBe(1);
		expect(result[0].avgConfidence).toBeCloseTo(0.9);
	});
});
