/**
 * Tests for run_stale_reconciliation tool.
 *
 * Covers:
 * - Happy path: returns {found: 0, skills: []} when no affected skills
 * - Marks skills stale when source knowledge is archived
 * - Marks skills stale when source knowledge is deleted (not in store)
 * - When clear=true, clears stale markers for affected skills
 * - When clear=false, marks affected skills stale
 * - Handles missing directories gracefully
 * - Skips skills without source_knowledge_ids
 * - Skips skills without SKILL.md
 * - Error handling: invalid directory
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mockClearSkillStale = mock(async (_skillPath: string) => {});
const mockRetireOrMarkStale = mock(async () => ({
	action: 'stale' as const,
	slug: '',
	skillDir: '',
}));
const mockGetArchivedKnowledgeIds = mock(async () => new Set<string>());
const mockReadKnowledge = mock(async () => []);

const mockParseDraftFrontmatter = mock((content: string) => {
	const match = content.match(/source_knowledge_ids:\s*\n((?:\s+-\s+.+\n?)*)/);
	if (!match) return { sourceKnowledgeIds: [] as string[] };
	const ids: string[] = [];
	for (const line of match[1].split('\n')) {
		const idMatch = line.match(/^\s+-\s+(.+)$/);
		if (idMatch) ids.push(idMatch[1].trim());
	}
	return { sourceKnowledgeIds: ids };
});

// Module-level mock — must be before the tool import
mock.module('../../../src/services/skill-generator.js', () => ({
	clearSkillStale: mockClearSkillStale,
	retireOrMarkStale: mockRetireOrMarkStale,
	parseDraftFrontmatter: mockParseDraftFrontmatter,
	listSkills: async () => ({ drafts: [], active: [], stale: [] }),
	generateSkills: async () => ({}),
	activateProposal: async () => ({}),
	inspectSkill: async () => ({}),
	regenerateSkill: async () => ({}),
}));

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	getArchivedKnowledgeIds: mockGetArchivedKnowledgeIds,
	readKnowledge: mockReadKnowledge,
	resolveSwarmKnowledgePath: mock((dir: string) =>
		path.join(dir, '.swarm', 'knowledge.jsonl'),
	),
	resolveHiveKnowledgePath: mock(() => '/fake/hive/path.jsonl'),
}));

import { _internals } from '../../../src/tools/stale-reconciliation';

const { run_stale_reconciliation } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockClearSkillStale.mockClear();
	mockRetireOrMarkStale.mockClear();
	mockGetArchivedKnowledgeIds.mockClear();
	mockReadKnowledge.mockClear();
	mockParseDraftFrontmatter.mockClear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'stale-reconciliation-test-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	process.chdir(originalCwd);
	try {
		await fs.rm(tmp, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

async function createSkillDir(
	base: string,
	slug: string,
	skillContent = '---\nsource_knowledge_ids:\n  - test-id-1\n---\n',
): Promise<void> {
	const skillDir = path.join(tmp, base, slug);
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent);
}

describe('run_stale_reconciliation tool', () => {
	it('returns {found: 0, skills: []} when no affected skills', async () => {
		await createSkillDir('.opencode/skills/generated', 'active-skill');
		await createSkillDir('.swarm/skills/proposals', 'draft-skill');

		mockGetArchivedKnowledgeIds.mockResolvedValueOnce(new Set([]));
		mockReadKnowledge.mockResolvedValueOnce([{ id: 'test-id-1' }]);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: false }, tmp),
		);
		expect(result.found).toBe(0);
		expect(result.skills).toEqual([]);
	});

	it('marks skills stale when source knowledge is archived', async () => {
		await createSkillDir('.opencode/skills/generated', 'stale-active');

		mockGetArchivedKnowledgeIds.mockResolvedValueOnce(new Set(['test-id-1']));
		mockReadKnowledge.mockResolvedValueOnce([]);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: false }, tmp),
		);
		expect(result.found).toBe(1);
		expect(result.skills[0].slug).toBe('stale-active');
		expect(result.skills[0].action).toBe('marked_stale');
		expect(mockRetireOrMarkStale).toHaveBeenCalledTimes(1);
	});

	it('marks skills stale when source knowledge is deleted', async () => {
		await createSkillDir('.opencode/skills/generated', 'deleted-source');

		mockGetArchivedKnowledgeIds.mockResolvedValueOnce(new Set([]));
		mockReadKnowledge.mockResolvedValueOnce([]);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: false }, tmp),
		);
		expect(result.found).toBe(1);
		expect(result.skills[0].slug).toBe('deleted-source');
		expect(result.skills[0].action).toBe('marked_stale');
	});

	it('when clear=true, clears stale markers for affected skills', async () => {
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'stale-skill',
		);
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nsource_knowledge_ids:\n  - test-id-1\n---\n',
		);
		await fs.writeFile(path.join(skillDir, 'stale.marker'), 'Test');

		mockGetArchivedKnowledgeIds.mockResolvedValueOnce(new Set(['test-id-1']));
		mockReadKnowledge.mockResolvedValueOnce([]);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: true }, tmp),
		);
		expect(result.found).toBe(1);
		expect(result.skills[0].slug).toBe('stale-skill');
		expect(result.skills[0].action).toBe('cleared');
		expect(mockClearSkillStale).toHaveBeenCalledTimes(1);
	});

	it('handles missing directories gracefully', async () => {
		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: false }, tmp),
		);
		expect(result.found).toBe(0);
		expect(result.skills).toEqual([]);
	});

	it('skips skills without source_knowledge_ids', async () => {
		await createSkillDir(
			'.opencode/skills/generated',
			'no-ids',
			'---\nname: test\n---\n',
		);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: false }, tmp),
		);
		expect(result.found).toBe(0);
	});

	it('skips skills without SKILL.md', async () => {
		await fs.mkdir(
			path.join(tmp, '.opencode', 'skills', 'generated', 'no-skill-md'),
			{ recursive: true },
		);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: false }, tmp),
		);
		expect(result.found).toBe(0);
	});

	it('does not clear markers for unaffected skills', async () => {
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'active-skill',
		);
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nsource_knowledge_ids:\n  - active-id\n---\n',
		);
		await fs.writeFile(path.join(skillDir, 'stale.marker'), 'Test');

		mockGetArchivedKnowledgeIds.mockResolvedValueOnce(new Set([]));
		mockReadKnowledge.mockResolvedValueOnce([{ id: 'active-id' }]);

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: true }, tmp),
		);
		expect(result.found).toBe(0);
		expect(mockClearSkillStale).not.toHaveBeenCalled();
	});

	it('handles clearSkillStale rejection gracefully', async () => {
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'stale-skill',
		);
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nsource_knowledge_ids:\n  - test-id-1\n---\n',
		);
		await fs.writeFile(path.join(skillDir, 'stale.marker'), 'Test');

		mockGetArchivedKnowledgeIds.mockResolvedValueOnce(new Set(['test-id-1']));
		mockReadKnowledge.mockResolvedValueOnce([]);
		mockClearSkillStale.mockRejectedValueOnce(new Error('clear failed'));

		const result = JSON.parse(
			await run_stale_reconciliation.execute({ clear: true }, tmp),
		);
		expect(result.found).toBe(0);
	});

	describe('_internals seam', () => {
		it('exposes run_stale_reconciliation via _internals', () => {
			expect(_internals.run_stale_reconciliation).toBeDefined();
			expect(typeof _internals.run_stale_reconciliation.execute).toBe(
				'function',
			);
		});
	});
});
