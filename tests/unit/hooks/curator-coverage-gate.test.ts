/**
 * Issue #2038 implementation review F5 — the curator per-skill usage-window
 * coverage gate (`isUsageWindowUsable` / `isSkillWindowTrustworthy`) had ZERO
 * deny-path test coverage: every case in curator-auto-retire.test.ts used a
 * `complete: true` fixture with a sample >= curatorMinSample (10), and
 * `recordCuratorSkips` was stubbed to a no-op everywhere. Deleting the gate
 * from all three `src/hooks/curator.ts` call sites broke no test.
 *
 * This file adds the missing negative-path cases against the CURRENT rule in
 * `isSkillWindowTrustworthy` (`src/hooks/skill-usage-pending.ts`), which was
 * updated by the F2 fix so the `curatorMinSample`/`floorPerSkill` floor
 * applies ONLY when coverage is incomplete:
 *
 *   (i)  coverage.complete === true  -> always trustworthy, no floor at all.
 *   (ii) coverage.complete === false -> trustworthy iff
 *        retainedCount >= curatorMinSample (10) AND
 *        retainedCount >= floorPerSkill (20).
 *
 * Kept in a separate file (rather than growing curator-auto-retire.test.ts)
 * because that file has only 14 lines of FR-006 cap headroom versus
 * origin/main and must not grow further.
 */

import { afterEach, describe, expect, test } from 'bun:test';

function makeMockFn<T extends (...args: any[]) => any>(fn: T) {
	const calls: Parameters<T>[] = [];
	const mockFn = ((...args: Parameters<T>) => {
		calls.push(args);
		return fn(...args);
	}) as T & { calls: Parameters<T>[] };
	mockFn.calls = calls;
	return mockFn;
}

import { _internals } from '../../../src/hooks/curator.js';

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

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

function verdicts(skillPath: string, verdict: 'violated' | 'ok', n: number) {
	return Array.from({ length: n }, () => ({
		skillPath,
		complianceVerdict: verdict,
	}));
}

/** Common test scaffolding: one skill, a fixed coverage/usage fixture, and a
 * spy-counted (never a real-I/O, never a silent stub) `recordCuratorSkips`. */
function setupCommonMocks(
	skillPath: string,
	coverage: Record<string, unknown>,
	usage: unknown[],
) {
	const mockRetireSkill = makeMockFn(() => Promise.resolve());
	const mockRecordCuratorSkips = makeMockFn(() => {});
	_internals.listSkills = makeMockFn(() =>
		Promise.resolve({
			active: [makeSkill('gated-skill', skillPath)],
			draft: [],
			proposals: [],
		}),
	);
	_internals.readSkillUsageEntriesWithCoverage = makeMockFn(() => ({
		entries: usage,
		coverage,
	})) as any;
	_internals.retireSkill = mockRetireSkill;
	_internals.recordCuratorSkips = mockRecordCuratorSkips;
	_internals.parseDraftFrontmatter = makeMockFn(() => ({
		sourceKnowledgeIds: [],
	}));
	_internals.readKnowledge = makeMockFn(() => Promise.resolve([]));
	_internals.readFileAsync = makeMockFn(() => Promise.resolve(''));
	return { mockRetireSkill, mockRecordCuratorSkips };
}

describe('curator coverage gate — deny path (issue #2038 F5)', () => {
	const directory = '/fake/dir';
	const skillPath = '/fake/dir/.opencode/skills/generated/gated-skill/SKILL.md';

	test('incomplete coverage + window below floorPerSkill (but >= curatorMinSample) with >30% violations: retirement is SKIPPED and recordCuratorSkips receives exactly 1', async () => {
		// 12 entries: >= curatorMinSample (10) but < floorPerSkill (20).
		// 5/12 violated (~42%) clears the violation-rate threshold on its own —
		// only the coverage gate can be blocking retireSkill here. Fails if
		// `isUsageWindowUsable(coverage, skillUsage.length)` is deleted from the
		// call site in `src/hooks/curator.ts`, because then nothing would stop
		// the violation-rate branch from calling retireSkill.
		const usage = [
			...verdicts(skillPath, 'violated', 5),
			...verdicts(skillPath, 'ok', 7),
		];
		const coverage = {
			complete: false,
			oldestRetained: null,
			newestRetained: null,
			entriesDropped: 10,
			skillsDropped: 0,
			floorPerSkill: 20,
			truncatedRead: true,
		};
		const { mockRetireSkill, mockRecordCuratorSkips } = setupCommonMocks(
			skillPath,
			coverage,
			usage,
		);

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(0);
		expect(mockRetireSkill.calls).toHaveLength(0);
		expect(mockRecordCuratorSkips.calls).toHaveLength(1);
		expect(mockRecordCuratorSkips.calls[0]).toEqual([directory, 1]);
	});

	test('incomplete coverage + window AT floorPerSkill with >30% violations: retirement still FIRES (#1770/#1822 regression guard — the gate is not a kill switch)', async () => {
		// Exactly floorPerSkill (20) entries, coverage incomplete: the floor
		// clause makes this window trustworthy even though global coverage is
		// truncated. Fails if either the floor comparison is tightened to
		// exclude the boundary, or if the whole gate collapses to "always deny
		// on incomplete coverage" (the earlier-draft bug the doc comment in
		// curator.ts explicitly warns against).
		const usage = [
			...verdicts(skillPath, 'violated', 7),
			...verdicts(skillPath, 'ok', 13),
		];
		const coverage = {
			complete: false,
			oldestRetained: null,
			newestRetained: null,
			entriesDropped: 500,
			skillsDropped: 3,
			floorPerSkill: 20,
			truncatedRead: true,
		};
		const { mockRetireSkill, mockRecordCuratorSkips } = setupCommonMocks(
			skillPath,
			coverage,
			usage,
		);

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(1);
		expect(mockRetireSkill.calls).toHaveLength(1);
		expect(mockRecordCuratorSkips.calls).toHaveLength(1);
		expect(mockRecordCuratorSkips.calls[0]).toEqual([directory, 0]);
	});

	test('complete coverage + a small sample (below curatorMinSample) with 100% violations: retirement FIRES — the floor does not apply on complete coverage (F2 fix)', async () => {
		// Only 3 entries, all violated (100%). `coverage.complete: true` must
		// short-circuit `isSkillWindowTrustworthy` to `true` unconditionally, per
		// the current rule in `src/hooks/skill-usage-pending.ts`
		// (`if (coverage.complete) return true;` BEFORE the curatorMinSample
		// check). Fails if that early return is removed/reordered so the
		// curatorMinSample floor applies even on complete coverage.
		const usage = verdicts(skillPath, 'violated', 3);
		const coverage = {
			complete: true,
			oldestRetained: null,
			newestRetained: null,
			entriesDropped: 0,
			skillsDropped: 0,
			floorPerSkill: 20,
			truncatedRead: false,
		};
		const { mockRetireSkill, mockRecordCuratorSkips } = setupCommonMocks(
			skillPath,
			coverage,
			usage,
		);

		const observations = await _internals.autoRetireSkills(
			directory,
			'/fake/knowledge',
		);

		expect(observations).toHaveLength(1);
		expect(mockRetireSkill.calls).toHaveLength(1);
		expect(mockRecordCuratorSkips.calls).toHaveLength(1);
		expect(mockRecordCuratorSkips.calls[0]).toEqual([directory, 0]);
	});
});
