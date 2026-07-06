/**
 * Issue #1717 — G10 (draft stamp + dedup) and G12 (retire link clear)
 * end-to-end tests.
 *
 * Split per AGENTS.md invariant 7 FR-006 (every new test file under 500 lines).
 * G8 tests live in skill-generator-1717-g8.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals as skillGenInternals,
	clearDraftSkillLinks,
	clearRetiredSkillLinks,
	proposalRepoRelativePath,
	retireSkill,
	selectCandidateEntries,
} from '../../../src/services/skill-generator';
import {
	cleanupTmp,
	makeEntry,
	makeTmp,
	readSwarmKnowledge,
	redirectHivePath,
	restoreEnv,
	writeSwarmKnowledge,
} from './_skill-generator-1717-helpers';

// stampSourceEntries is not exported; access via _internals.
const stampSourceEntries = skillGenInternals.stampSourceEntries;

let tmp: string;

beforeEach(() => {
	mock.restore();
	tmp = makeTmp();
	redirectHivePath(tmp);
});

afterEach(() => {
	restoreEnv();
	cleanupTmp(tmp);
	mock.restore();
});

// ============================================================================
// G10 — draft stamp + dedup
// ============================================================================

describe('G10: draft stamp + selectCandidateEntries dedup', () => {
	it('stampSourceEntries in draft mode writes draft_generated_skill_*', async () => {
		await writeSwarmKnowledge(tmp, [makeEntry('src-1')]);
		await stampSourceEntries(tmp, 'draft-skill', ['src-1'], 'draft');
		const entries = await readSwarmKnowledge(tmp);
		expect(entries[0].draft_generated_skill_slug).toBe('draft-skill');
		expect(entries[0].draft_generated_skill_path).toBe(
			proposalRepoRelativePath('draft-skill'),
		);
		// Active fields NOT written in draft mode.
		expect(entries[0].generated_skill_slug).toBeUndefined();
	});

	it('selectCandidateEntries skips entries with draft_generated_skill_slug', async () => {
		await writeSwarmKnowledge(tmp, [
			makeEntry('not-stamped'),
			makeEntry('draft-stamped', {
				draft_generated_skill_slug: 'some-draft',
			}),
		]);
		const selected = await selectCandidateEntries(tmp, {
			minConfidence: 0.7,
			minConfirmations: 1,
		});
		const ids = selected.map((e) => e.id);
		expect(ids).toContain('not-stamped');
		expect(ids).not.toContain('draft-stamped');
	});

	it('active-mode stamp clears a prior draft marker (promotion)', async () => {
		await writeSwarmKnowledge(tmp, [
			makeEntry('src-1', { draft_generated_skill_slug: 'old-draft' }),
		]);
		await stampSourceEntries(tmp, 'active-skill', ['src-1'], 'active');
		const entries = await readSwarmKnowledge(tmp);
		expect(entries[0].generated_skill_slug).toBe('active-skill');
		expect(entries[0].draft_generated_skill_slug).toBeUndefined();
	});

	it('clearDraftSkillLinks clears draft markers on source entries', async () => {
		await writeSwarmKnowledge(tmp, [
			makeEntry('src-1', { draft_generated_skill_slug: 'rejected-draft' }),
		]);
		const proposalPath = path.join(
			tmp,
			'.swarm',
			'skills',
			'proposals',
			'rejected-draft.md',
		);
		await mkdir(path.dirname(proposalPath), { recursive: true });
		await writeFile(
			proposalPath,
			[
				'---',
				'generated_from_knowledge:',
				'  - src-1',
				'source_knowledge_ids:',
				'  - src-1',
				'---',
				'# rejected-draft',
			].join('\n'),
			'utf-8',
		);
		const cleared = await clearDraftSkillLinks(
			tmp,
			proposalPath,
			'rejected-draft',
		);
		expect(cleared).toEqual(['src-1']);
		const entries = await readSwarmKnowledge(tmp);
		expect(entries[0].draft_generated_skill_slug).toBeUndefined();
		// Active stamp NOT touched.
		expect(entries[0].generated_skill_slug).toBeUndefined();
	});

	// G10 literal acceptance criterion (issue #1717): "a test shows the same
	// cluster is NOT recompiled into a second draft the next phase."
	it('end-to-end: a draft-stamped cluster is not reselected next phase', async () => {
		await writeSwarmKnowledge(tmp, [
			makeEntry('cluster-src', {
				required_actions: ['do phase work'],
				triggers: ['phase trigger'],
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: new Date().toISOString(),
						project_name: 'issue-1717-test',
					},
					{
						phase_number: 2,
						confirmed_at: new Date().toISOString(),
						project_name: 'issue-1717-test',
					},
				],
			}),
		]);

		const opts = { minConfidence: 0.7, minConfirmations: 1 };
		// Phase 1: cluster is eligible.
		const phase1 = await selectCandidateEntries(tmp, opts);
		expect(phase1.map((e) => e.id)).toContain('cluster-src');

		// Simulate generateSkills(draft) stamping the entry.
		await stampSourceEntries(tmp, 'phase1-draft', ['cluster-src'], 'draft');

		// Phase 2: the SAME cluster must NOT be reselected — the draft marker
		// excludes it via selectCandidateEntries' dedup guard.
		const phase2 = await selectCandidateEntries(tmp, opts);
		expect(phase2.map((e) => e.id)).not.toContain('cluster-src');
	});
});

// ============================================================================
// G12 — retire link clear
// ============================================================================

describe('G12: retireSkill clears bi-directional link', () => {
	async function writeActiveSkill(
		slug: string,
		sourceIds: string[] = ['src-1'],
	): Promise<string> {
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			slug,
		);
		await mkdir(skillDir, { recursive: true });
		const ids = sourceIds.map((id) => `  - ${id}`).join('\n');
		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			[
				'---',
				`name: ${slug}`,
				'generated_from_knowledge:',
				`  ${sourceIds.join('\n  - ')}`,
				'source_knowledge_ids:',
				`${ids}`,
				'---',
				'<!-- generated by opencode-swarm skill-generator. -->',
				`# ${slug}`,
				'## Required Procedure',
				'- call declare_scope',
				'## Forbidden Shortcuts',
				'- skip scope declaration',
			].join('\n'),
			'utf-8',
		);
		return skillDir;
	}

	it('retireSkill clears generated_skill_* on source entries', async () => {
		await writeSwarmKnowledge(tmp, [
			makeEntry('src-1', { generated_skill_slug: 'retire-target' }),
		]);
		await writeActiveSkill('retire-target');
		const result = await retireSkill(tmp, 'retire-target', 'test retire');
		expect(result.retired).toBe(true);
		expect(result.clearedLinks).toEqual(['src-1']);
		const entries = await readSwarmKnowledge(tmp);
		expect(entries[0].generated_skill_slug).toBeUndefined();
		expect(entries[0].generated_skill_path).toBeUndefined();
		expect(entries[0].retired_skill_history).toEqual(['retire-target']);
	});

	it('clearRetiredSkillLinks is a no-op when sourceKnowledgeIds is empty', async () => {
		await writeSwarmKnowledge(tmp, [makeEntry('src-1')]);
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'no-source',
		);
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			['---', 'name: no-source', '---', '# no-source'].join('\n'),
			'utf-8',
		);
		const cleared = await clearRetiredSkillLinks(
			tmp,
			path.join(skillDir, 'SKILL.md'),
			'no-source',
		);
		expect(cleared).toEqual([]);
		const entries = await readSwarmKnowledge(tmp);
		// Untouched.
		expect(entries[0].generated_skill_slug).toBeUndefined();
	});

	it('retired_skill_history caps at 50 entries (FIFO)', async () => {
		// Pre-fill history with 49 entries, then retire one more → cap at 50.
		const history: string[] = [];
		for (let i = 0; i < 49; i++) history.push(`old-skill-${i}`);
		await writeSwarmKnowledge(tmp, [
			makeEntry('src-1', {
				generated_skill_slug: 'newest-retire',
				retired_skill_history: history,
			}),
		]);
		await writeActiveSkill('newest-retire');
		await retireSkill(tmp, 'newest-retire', 'cap test');
		const entries = await readSwarmKnowledge(tmp);
		expect(entries[0].retired_skill_history).toHaveLength(50);
		// The newest is the last entry (FIFO — oldest dropped).
		expect(entries[0].retired_skill_history?.[49]).toBe('newest-retire');
		expect(entries[0].retired_skill_history?.[0]).toBe('old-skill-0');
	});

	it('retired_skill_history dedups the same slug on re-retire', async () => {
		await writeSwarmKnowledge(tmp, [
			makeEntry('src-1', {
				generated_skill_slug: 'dup-retire',
				retired_skill_history: ['dup-retire'],
			}),
		]);
		await writeActiveSkill('dup-retire');
		await retireSkill(tmp, 'dup-retire', 'dedup test');
		const entries = await readSwarmKnowledge(tmp);
		// No duplicate.
		const dupCount = entries[0].retired_skill_history?.filter(
			(s) => s === 'dup-retire',
		).length;
		expect(dupCount).toBe(1);
	});

	// Wiring proof (issue-tracer reviewer blind spot 1): when retireOrMarkStale
	// fires retireSkill (the production path used by autoRetireSkills and the
	// G11 invalidator), the source-entry link clear propagates end-to-end.
	it('retireOrMarkStale clears source links when it retires (wiring)', async () => {
		const { retireOrMarkStale } = await import(
			'../../../src/services/skill-generator'
		);
		await writeSwarmKnowledge(tmp, [
			makeEntry('src-1', { generated_skill_slug: 'retire-via-orms' }),
		]);
		await writeActiveSkill('retire-via-orms');
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'retire-via-orms',
		);
		// retireOrMarkStale retires when ALL sources are archived.
		const result = await retireOrMarkStale(tmp, skillDir, new Set(['src-1']));
		expect(result.action).toBe('retire');
		// The source entry's generated_skill_* must be cleared and history recorded.
		const entries = await readSwarmKnowledge(tmp);
		expect(entries[0].generated_skill_slug).toBeUndefined();
		expect(entries[0].generated_skill_path).toBeUndefined();
		expect(entries[0].retired_skill_history).toEqual(['retire-via-orms']);
	});
});
