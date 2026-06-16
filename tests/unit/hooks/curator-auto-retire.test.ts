/**
 * Unit tests for curator.ts autoRetireSkills function.
 * Tests the auto-retirement health check logic via _internals DI seam.
 *
 * All mocking is done through the _internals DI seam — no mock.module calls.
 * This avoids Bun's known mock.module leak across test files.
 */

import { afterEach, describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Helper — plain function stub that records calls (avoids bun:test mock()
// pollution across test files in the shared test-runner process).
// ---------------------------------------------------------------------------
function makeMockFn<T extends (...args: any[]) => any>(fn: T) {
	const calls: Parameters<T>[] = [];
	const mockFn = ((...args: Parameters<T>) => {
		calls.push(args);
		return fn(...args);
	}) as T & { calls: Parameters<T>[] };
	mockFn.calls = calls;
	return mockFn;
}

// ---------------------------------------------------------------------------
// Import curator _internals — no module-level mocking required
// ---------------------------------------------------------------------------
import { _internals } from '../../../src/hooks/curator.js';

// ---------------------------------------------------------------------------
// Per-test setup/teardown — save and restore _internals references
// ---------------------------------------------------------------------------
const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

// ---------------------------------------------------------------------------
// Helper — build a minimal SkillManifest entry
// ---------------------------------------------------------------------------
function makeSkill(slug: string, skillPath: string) {
	return {
		slug,
		path: skillPath,
		title: `Skill ${slug}`,
		description: `Description for ${slug}`,
		trigger: `trigger-${slug}`,
		required_procedure: [] as string[],
		forbidden_shortcuts: [] as string[],
		target_agents: [] as string[],
		reviewer_checks: [] as string[],
		confidence: 0.85 as const,
		reason: `reason-${slug}`,
		source_knowledge_ids: [] as string[],
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('autoRetireSkills', () => {
	// -----------------------------------------------------------------------
	// TC1: Skill with violationRate > 0.3 → calls retireSkill with correct reason
	// -----------------------------------------------------------------------
	test('TC1: skill exceeding violation threshold is retired with violation reason', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'high-violation',
						'/fake/dir/.opencode/skills/generated/high-violation/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		const mockReadSkillUsageEntries = makeMockFn(() => [
			{
				skillPath:
					'file:/fake/dir/.opencode/skills/generated/high-violation/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/high-violation/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/high-violation/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/high-violation/SKILL.md',
				complianceVerdict: 'ok' as const,
			},
		]);

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = makeMockFn(() => ({
			sourceKnowledgeIds: [],
		}));
		_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
		_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(1);
		expect(observations[0]).toContain('high-violation');
		expect(observations[0]).toContain('violation rate');
		expect(mockRetireSkill.calls).toHaveLength(1);
		expect(mockRetireSkill.calls[0]).toEqual([
			directory,
			'high-violation',
			expect.stringContaining('violation rate'),
		]);
	});

	// -----------------------------------------------------------------------
	// TC2: Skill with violationRate <= 0.3 AND no archived sources → does NOT call retireSkill
	// -----------------------------------------------------------------------
	test('TC2: skill below violation threshold with no archived sources is NOT retired', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'healthy-skill',
						'/fake/dir/.opencode/skills/generated/healthy-skill/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		const mockReadSkillUsageEntries = makeMockFn(() => [
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/healthy-skill/SKILL.md',
				complianceVerdict: 'ok' as const,
			},
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/healthy-skill/SKILL.md',
				complianceVerdict: 'ok' as const,
			},
		]);

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = makeMockFn(() => ({
			sourceKnowledgeIds: [],
		}));
		_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
		_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(0);
		expect(mockRetireSkill.calls).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// TC3: Skill with zero usage entries BUT all source knowledge archived → calls retireSkill with "archived" reason
	// -----------------------------------------------------------------------
	test('TC3: skill with no usage but all sources archived is retired with archived reason', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'archived-skill',
						'/fake/dir/.opencode/skills/generated/archived-skill/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		const mockReadSkillUsageEntries = makeMockFn(() => []);
		const mockParseDraftFrontmatter = makeMockFn(() => ({
			sourceKnowledgeIds: ['src1', 'src2'],
		}));

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = mockParseDraftFrontmatter;
		// Use call-count-based mock: first call = swarm, subsequent = hive (empty).
		// This avoids duplicate entries when both swarm and hive knowledge are read.
		let readCallCount = 0;
		_internals.readKnowledge = makeMockFn(() => {
			readCallCount++;
			if (readCallCount === 1) {
				return Promise.resolve([
					{
						id: 'src1',
						status: 'archived' as const,
						lesson: 'l',
						confidence: 0.5,
						updated_at: '',
						created_at: '',
						tags: [],
						scope: 'global' as const,
						category: 'other' as const,
						retrieval_outcomes: {
							applied_count: 0,
							succeeded_after_count: 0,
							failed_after_count: 0,
						},
						schema_version: 1,
						confirmed_by: [],
					},
					{
						id: 'src2',
						status: 'archived' as const,
						lesson: 'l',
						confidence: 0.5,
						updated_at: '',
						created_at: '',
						tags: [],
						scope: 'global' as const,
						category: 'other' as const,
						retrieval_outcomes: {
							applied_count: 0,
							succeeded_after_count: 0,
							failed_after_count: 0,
						},
						schema_version: 1,
						confirmed_by: [],
					},
				]);
			}
			// Subsequent calls (hive) return empty
			return Promise.resolve([]);
		});
		_internals.readFileAsync = makeMockFn(() =>
			Promise.resolve('---\nsourceKnowledgeIds:\n  - src1\n  - src2\n---\n'),
		);

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(1);
		expect(observations[0]).toContain('archived-skill');
		expect(observations[0]).toContain('archived');
		expect(mockRetireSkill.calls).toHaveLength(1);
		expect(mockRetireSkill.calls[0]).toEqual([
			directory,
			'archived-skill',
			'auto-retire: all source knowledge entries archived',
		]);
	});

	// -----------------------------------------------------------------------
	// TC4: Skill with zero usage entries AND no archived sources → does NOT call retireSkill
	// -----------------------------------------------------------------------
	test('TC4: skill with no usage and no archived sources is NOT retired', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'unused-skill',
						'/fake/dir/.opencode/skills/generated/unused-skill/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		const mockReadSkillUsageEntries = makeMockFn(() => []);
		// No sourceKnowledgeIds → no archived check
		const mockParseDraftFrontmatter = makeMockFn(() => ({
			sourceKnowledgeIds: [],
		}));

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = mockParseDraftFrontmatter;
		_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
		_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(0);
		expect(mockRetireSkill.calls).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// TC5: Skill with no frontmatter/source IDs → skip archived check, only check violation rate
	// -----------------------------------------------------------------------
	test('TC5: skill with no frontmatter skips archived check and only evaluates violation rate', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'no-fm-skill',
						'/fake/dir/.opencode/skills/generated/no-fm-skill/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		// 2 violations out of 3 = 66% > 30% → should retire
		const mockReadSkillUsageEntries = makeMockFn(() => [
			{
				skillPath: '/fake/dir/.opencode/skills/generated/no-fm-skill/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath: '/fake/dir/.opencode/skills/generated/no-fm-skill/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath: '/fake/dir/.opencode/skills/generated/no-fm-skill/SKILL.md',
				complianceVerdict: 'ok' as const,
			},
		]);
		// parseDraftFrontmatter returns null → skips archived check
		const mockParseDraftFrontmatter = makeMockFn(() => null);

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = mockParseDraftFrontmatter;
		_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
		_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(1);
		expect(observations[0]).toContain('no-fm-skill');
		expect(mockRetireSkill.calls).toHaveLength(1);
	});

	// -----------------------------------------------------------------------
	// TC6: retireSkill throws → caught, does not propagate (fail-open)
	// -----------------------------------------------------------------------
	test('TC6: retireSkill error is caught and does not propagate', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() =>
			Promise.reject(new Error('retireSkill failed')),
		);
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'fail-retire',
						'/fake/dir/.opencode/skills/generated/fail-retire/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		const mockReadSkillUsageEntries = makeMockFn(() => [
			{
				skillPath: '/fake/dir/.opencode/skills/generated/fail-retire/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath: '/fake/dir/.opencode/skills/generated/fail-retire/SKILL.md',
				complianceVerdict: 'ok' as const,
			},
		]);

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = makeMockFn(() => ({
			sourceKnowledgeIds: [],
		}));
		_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
		_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));

		// Should NOT throw — fail-open
		await expect(
			_internals.autoRetireSkills(directory, '/fake/knowledge'),
		).resolves.toBeDefined();
	});

	// -----------------------------------------------------------------------
	// TC7: listSkills throws → caught, does not propagate (fail-open)
	// -----------------------------------------------------------------------
	test('TC7: listSkills error is caught and does not propagate', async () => {
		const mockListSkills = makeMockFn(() =>
			Promise.reject(new Error('listSkills failed')),
		);

		_internals.listSkills = mockListSkills;

		// Should NOT throw — fail-open
		await expect(
			_internals.autoRetireSkills('/fake/dir', '/fake/knowledge'),
		).resolves.toBeDefined();
	});

	// -----------------------------------------------------------------------
	// TC8: Multiple skills: one meets violation threshold, one meets archived threshold → both retired
	// -----------------------------------------------------------------------
	test('TC8: multiple skills meeting different thresholds are both retired', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'violation-skill',
						'/fake/dir/.opencode/skills/generated/violation-skill/SKILL.md',
					),
					makeSkill(
						'archived-skill',
						'/fake/dir/.opencode/skills/generated/archived-skill/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		// violation-skill: 1/2 = 50% > 30%; archived-skill: no usage
		const mockReadSkillUsageEntries = makeMockFn(() => [
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/violation-skill/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath:
					'/fake/dir/.opencode/skills/generated/violation-skill/SKILL.md',
				complianceVerdict: 'ok' as const,
			},
		]);
		// First skill (violation-skill): no source IDs
		// Second skill (archived-skill): has source IDs pointing to archived entries
		let parseCallCount = 0;
		const mockParseDraftFrontmatter = makeMockFn(() => {
			parseCallCount++;
			if (parseCallCount === 1) return { sourceKnowledgeIds: [] };
			return { sourceKnowledgeIds: ['src1'] };
		});

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = mockParseDraftFrontmatter;
		// Use call-count-based mock: first call = swarm, subsequent = hive (empty).
		// This avoids duplicate entries when both swarm and hive knowledge are read.
		let readCallCount = 0;
		_internals.readKnowledge = makeMockFn(() => {
			readCallCount++;
			if (readCallCount === 1) {
				return Promise.resolve([
					{
						id: 'src1',
						status: 'archived' as const,
						lesson: 'l',
						confidence: 0.5,
						updated_at: '',
						created_at: '',
						tags: [],
						scope: 'global' as const,
						category: 'other' as const,
						retrieval_outcomes: {
							applied_count: 0,
							succeeded_after_count: 0,
							failed_after_count: 0,
						},
						schema_version: 1,
						confirmed_by: [],
					},
				]);
			}
			// Subsequent calls (hive) return empty
			return Promise.resolve([]);
		});
		_internals.readFileAsync = makeMockFn(() =>
			Promise.resolve('---\nsourceKnowledgeIds:\n  - src1\n---\n'),
		);

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(2);
		expect(observations.some((o) => o.includes('violation-skill'))).toBe(true);
		expect(observations.some((o) => o.includes('archived-skill'))).toBe(true);
		expect(mockRetireSkill.calls).toHaveLength(2);
	});

	// -----------------------------------------------------------------------
	// TC9: substring safety — slug that is a substring of another slug does NOT match
	// e.g. slug "test" should NOT match path ".../test-skill/SKILL.md"
	// -----------------------------------------------------------------------
	test('TC9: slug does not match as substring of another skill path', async () => {
		const directory = '/fake/dir';

		const mockRetireSkill = makeMockFn(() => Promise.resolve());
		const mockListSkills = makeMockFn(() =>
			Promise.resolve({
				active: [
					makeSkill(
						'test',
						'/fake/dir/.opencode/skills/generated/test/SKILL.md',
					),
				],
				draft: [],
				proposals: [],
			}),
		);
		// Usage entries for a DIFFERENT skill ("test-skill") — should NOT match slug "test"
		const mockReadSkillUsageEntries = makeMockFn(() => [
			{
				skillPath: '/fake/dir/.opencode/skills/generated/test-skill/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath: '/fake/dir/.opencode/skills/generated/test-skill/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
			{
				skillPath: '/fake/dir/.opencode/skills/generated/test-skill/SKILL.md',
				complianceVerdict: 'violation' as const,
			},
		]);

		_internals.listSkills = mockListSkills;
		_internals.readSkillUsageEntries = mockReadSkillUsageEntries;
		_internals.retireSkill = mockRetireSkill;
		_internals.parseDraftFrontmatter = makeMockFn(() => ({
			sourceKnowledgeIds: [],
		}));
		_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
		_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		// "test" skill should have zero usage entries (test-skill paths should NOT match)
		expect(observations).toHaveLength(0);
		expect(mockRetireSkill.calls).toHaveLength(0);
	});
});
