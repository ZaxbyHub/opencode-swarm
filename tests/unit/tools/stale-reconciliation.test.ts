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

import { _internals } from '../../../src/tools/stale-reconciliation';

const { run_stale_reconciliation } = _internals;

// Capture real fs functions at module load time — before any _internals injection.
// These are the fallback targets for the mock delegates.
const realReaddir = _internals.readdir;
const realReadFile = _internals.readFile;
const realExistsSync = _internals.existsSync;

// Module-level mocks — injected into _internals in beforeEach
const mockClearSkillStale = mock(async (_skillPath: string) => {});
const mockRetireOrMarkStale = mock(async () => ({
	action: 'stale' as const,
	slug: '',
	skillDir: '',
}));
const mockGetArchivedKnowledgeIds = mock(async () => new Set<string>());
const mockReadKnowledge = mock(async () => []);

const mockParseDraftFrontmatterImpl = (content: string) => {
	const match = content.match(/source_knowledge_ids:\s*\n((?:\s+-\s+.+\n?)*)/);
	if (!match) return { sourceKnowledgeIds: [] as string[] };
	const ids: string[] = [];
	for (const line of match[1].split('\n')) {
		const idMatch = line.match(/^\s+-\s+(.+)$/);
		if (idMatch) ids.push(idMatch[1].trim());
	}
	return { sourceKnowledgeIds: ids };
};

const mockParseDraftFrontmatter = mock(mockParseDraftFrontmatterImpl);

function setupParseDraftFrontmatterImpl() {
	mockParseDraftFrontmatter.mockImplementation(mockParseDraftFrontmatterImpl);
}

const mockResolveSwarmKnowledgePath = mock((_dir: string) =>
	path.join('.swarm', 'knowledge.jsonl'),
);
const mockResolveHiveKnowledgePath = mock(() => '/fake/hive/path.jsonl');

// readdir mock: delegates to real fs for existing dirs, returns [] for missing dirs.
// Implemented via mockImplementation (re-set in beforeEach after mockClear) because
// mockReset() in afterEach resets the implementation back to the initial stub.
const mockReaddir = mock(async () => []);
const mockReadFile = mock(async () => '');
const mockExistsSync = mock(() => true);

function setupReaddirImpl() {
	mockReaddir.mockImplementation(
		async (dir: string, options?: { withFileTypes?: boolean }) => {
			try {
				return await realReaddir(dir, options);
			} catch {
				return [];
			}
		},
	);
}

function setupReadFileImpl() {
	mockReadFile.mockImplementation(async (filePath: string, encoding: string) => {
		return realReadFile(filePath, encoding);
	});
}

function setupExistsSyncImpl() {
	mockExistsSync.mockImplementation((path: string) => {
		return realExistsSync(path);
	});
}

// Set initial implementation at module load time
setupReaddirImpl();
setupReadFileImpl();
setupExistsSyncImpl();
setupParseDraftFrontmatterImpl();

// Module-level references to original functions (saved/restored in beforeEach/afterEach)
let originalClearSkillStale: typeof _internals.clearSkillStale;
let originalRetireOrMarkStale: typeof _internals.retireOrMarkStale;
let originalParseDraftFrontmatter: typeof _internals.parseDraftFrontmatter;
let originalGetArchivedKnowledgeIds: typeof _internals.getArchivedKnowledgeIds;
let originalReadKnowledge: typeof _internals.readKnowledge;
let originalResolveSwarmKnowledgePath: typeof _internals.resolveSwarmKnowledgePath;
let originalResolveHiveKnowledgePath: typeof _internals.resolveHiveKnowledgePath;
let originalReaddir: typeof _internals.readdir;
let originalReadFile: typeof _internals.readFile;
let originalExistsSync: typeof _internals.existsSync;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	// Save originals and inject mocks into _internals
	originalClearSkillStale = _internals.clearSkillStale;
	originalRetireOrMarkStale = _internals.retireOrMarkStale;
	originalParseDraftFrontmatter = _internals.parseDraftFrontmatter;
	originalGetArchivedKnowledgeIds = _internals.getArchivedKnowledgeIds;
	originalReadKnowledge = _internals.readKnowledge;
	originalResolveSwarmKnowledgePath = _internals.resolveSwarmKnowledgePath;
	originalResolveHiveKnowledgePath = _internals.resolveHiveKnowledgePath;
	originalReaddir = _internals.readdir;
	originalReadFile = _internals.readFile;
	originalExistsSync = _internals.existsSync;

	_internals.clearSkillStale = mockClearSkillStale;
	_internals.retireOrMarkStale = mockRetireOrMarkStale;
	_internals.parseDraftFrontmatter = mockParseDraftFrontmatter;
	_internals.getArchivedKnowledgeIds = mockGetArchivedKnowledgeIds;
	_internals.readKnowledge = mockReadKnowledge;
	_internals.resolveSwarmKnowledgePath = mockResolveSwarmKnowledgePath;
	_internals.resolveHiveKnowledgePath = mockResolveHiveKnowledgePath;
	_internals.readdir = mockReaddir;
	_internals.readFile = mockReadFile;
	_internals.existsSync = mockExistsSync;

	mockClearSkillStale.mockClear();
	mockRetireOrMarkStale.mockClear();
	mockGetArchivedKnowledgeIds.mockClear();
	mockReadKnowledge.mockClear();
	mockParseDraftFrontmatter.mockClear();
	mockResolveSwarmKnowledgePath.mockClear();
	mockResolveHiveKnowledgePath.mockClear();
	mockReaddir.mockClear();
	mockReadFile.mockClear();
	mockExistsSync.mockClear();
	// Re-set implementation after mockClear (mockClear preserves impl, but be explicit)
	setupReaddirImpl();
	setupReadFileImpl();
	setupExistsSyncImpl();
	setupParseDraftFrontmatterImpl();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'stale-reconciliation-test-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	// Restore original functions to prevent cross-test leakage
	_internals.clearSkillStale = originalClearSkillStale;
	_internals.retireOrMarkStale = originalRetireOrMarkStale;
	_internals.parseDraftFrontmatter = originalParseDraftFrontmatter;
	_internals.getArchivedKnowledgeIds = originalGetArchivedKnowledgeIds;
	_internals.readKnowledge = originalReadKnowledge;
	_internals.resolveSwarmKnowledgePath = originalResolveSwarmKnowledgePath;
	_internals.resolveHiveKnowledgePath = originalResolveHiveKnowledgePath;
	_internals.readdir = originalReaddir;
	_internals.readFile = originalReadFile;
	_internals.existsSync = originalExistsSync;

	// Reset mock implementation state
	mockClearSkillStale.mockReset();
	mockRetireOrMarkStale.mockReset();
	mockGetArchivedKnowledgeIds.mockReset();
	mockReadKnowledge.mockReset();
	mockParseDraftFrontmatter.mockReset();
	mockResolveSwarmKnowledgePath.mockReset();
	mockResolveHiveKnowledgePath.mockReset();
	mockReaddir.mockReset();
	mockReadFile.mockReset();
	mockExistsSync.mockReset();
	mockParseDraftFrontmatter.mockReset();

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

		it('exposes clearSkillStale via _internals', () => {
			expect(typeof _internals.clearSkillStale).toBe('function');
		});

		it('exposes retireOrMarkStale via _internals', () => {
			expect(typeof _internals.retireOrMarkStale).toBe('function');
		});

		it('exposes parseDraftFrontmatter via _internals', () => {
			expect(typeof _internals.parseDraftFrontmatter).toBe('function');
		});

		it('exposes knowledge-store functions via _internals', () => {
			expect(typeof _internals.getArchivedKnowledgeIds).toBe('function');
			expect(typeof _internals.readKnowledge).toBe('function');
			expect(typeof _internals.resolveSwarmKnowledgePath).toBe('function');
			expect(typeof _internals.resolveHiveKnowledgePath).toBe('function');
		});

		it('exposes fs functions via _internals', () => {
			expect(typeof _internals.readdir).toBe('function');
			expect(typeof _internals.readFile).toBe('function');
			expect(typeof _internals.existsSync).toBe('function');
		});
	});
});
