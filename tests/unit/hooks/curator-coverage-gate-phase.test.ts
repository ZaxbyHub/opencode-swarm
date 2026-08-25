/**
 * Issue #2038 final critic, C2 — deny-path coverage for the TWO curator gate
 * call sites that `curator-coverage-gate.test.ts` does not reach, plus the
 * durable `curator_skipped` counter.
 *
 * `08b` F5 claimed the gate could be deleted from all three
 * `isUsageWindowUsable` call sites in `src/hooks/curator.ts` with no test
 * failing; the fix that followed only closed the auto-retire site (`:493`).
 * The final critic re-ran the mutation against the full consumer set and found
 * the other two still unprotected:
 *
 *   - `curator.ts:2011`  — skill revision (inside `runCuratorPhase` §8b)
 *   - `curator.ts:2147`  — promoted-external staleness retire (§8c)
 *
 * Both live inside `runCuratorPhase`, not `autoRetireSkills`, which is why the
 * `autoRetireSkills`-driven file could not see them. Each site is pinned here
 * by a matched DENY / ALLOW pair, so a test cannot pass merely because the site
 * was unreachable: the ALLOW case proves the fixture actually arrives at the
 * decision, and the DENY case proves the gate is the only thing stopping it.
 *
 * The third F5 gap — `recordCuratorSkips` stubbed everywhere, so the durable
 * counter had no executing test — is closed by the last case, which runs the
 * REAL implementation against a real `.swarm` directory and reads the counter
 * back off disk.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resetGlobalEventBus } from '../../../src/background/event-bus.js';
import { _internals, runCuratorPhase } from '../../../src/hooks/curator.js';
import type { CuratorConfig } from '../../../src/hooks/curator-types';
import {
	MAX_REVISION_CALLS_PER_PHASE,
	REVISION_VIOLATION_THRESHOLD,
} from '../../../src/services/skill-reviser.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };

const CONFIG: CuratorConfig = {
	enabled: true,
	init_enabled: false,
	phase_enabled: true,
	max_summary_tokens: 1000,
	min_knowledge_confidence: 0.5,
	compliance_report: false,
	suppress_warnings: true,
	drift_inject_max_chars: 1000,
};

/** floorPerSkill in force for these fixtures — the gate's incomplete-coverage floor. */
const FLOOR = 20;

/**
 * Fixed mtime for the promoted-external fixture. `runCuratorPhase` derives
 * `ageDays` from the skill file's mtime and refuses to retire below a 60-day
 * floor, so the file must simply be old — a FIXED absolute past date satisfies
 * that for every possible run time without reading the wall clock, which keeps
 * the fixture deterministic and the file clear of the `check-test-clock.sh`
 * real-clock rule.
 */
const BACKDATED_MTIME = new Date('2020-01-01T00:00:00.000Z');

function makeMockFn<T extends (...args: any[]) => any>(fn: T) {
	const calls: Parameters<T>[] = [];
	const mockFn = ((...args: Parameters<T>) => {
		calls.push(args);
		return fn(...args);
	}) as T & { calls: Parameters<T>[] };
	mockFn.calls = calls;
	return mockFn;
}

function skillPathFor(dir: string, slug: string): string {
	return path.join(dir, '.opencode', 'skills', 'generated', slug, 'SKILL.md');
}

/**
 * Write a REAL SKILL.md at the path `buildPromotedExternalInputFromSkill`
 * derives from the slug. That helper does its own `existsSync` / `readFileSync`
 * and is not behind an `_internals` seam, so a stubbed `readFileAsync` does not
 * reach it: if the file is missing it returns `null`, the §8c loop `continue`s,
 * and the gate at `:2147` is never evaluated — a test that passes for the wrong
 * reason. `ageDays` comes from the file mtime, so it is backdated here rather
 * than mocked.
 */
function writePromotedExternalSkill(dir: string, slug: string): string {
	const skillPath = skillPathFor(dir, slug);
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(
		skillPath,
		[
			'---',
			`name: ${slug}`,
			'skill_origin: promoted_external',
			'version: 1',
			'---',
			'',
			'# body',
			'',
		].join('\n'),
		'utf-8',
	);
	fs.utimesSync(skillPath, BACKDATED_MTIME, BACKDATED_MTIME);
	return skillPath;
}

function verdicts(
	skillPath: string,
	verdict: 'violated' | 'compliant',
	n: number,
) {
	return Array.from({ length: n }, (_unused, i) => ({
		skillPath,
		complianceVerdict: verdict,
		agentName: 'agent',
		taskID: `task-${i}`,
		timestamp: '2026-01-01T00:00:00.000Z',
	}));
}

function incompleteCoverage(): Record<string, unknown> {
	return {
		complete: false,
		oldestRetained: null,
		newestRetained: null,
		entriesDropped: 500,
		skillsDropped: 3,
		floorPerSkill: FLOOR,
		truncatedRead: true,
	};
}

interface Harness {
	recordCuratorSkips: ReturnType<typeof makeMockFn>;
	reviseSkill: ReturnType<typeof makeMockFn>;
}

function installStubs(
	slug: string,
	skillPath: string,
	usage: unknown[],
	frontmatter: Record<string, unknown>,
): Harness {
	const recordCuratorSkips = makeMockFn(() => {});
	const reviseSkill = makeMockFn(() =>
		Promise.resolve({ revised: true, newVersion: 2, quotaConsumed: true }),
	);
	_internals.listSkills = makeMockFn(() =>
		Promise.resolve({
			active: [{ slug, path: skillPath, title: slug, description: slug }],
			draft: [],
			proposals: [],
		}),
	) as any;
	_internals.readSkillUsageEntriesWithCoverage = makeMockFn(() => ({
		entries: usage,
		coverage: incompleteCoverage(),
	})) as any;
	_internals.parseDraftFrontmatter = makeMockFn(() => frontmatter) as any;
	_internals.readFileAsync = makeMockFn(() =>
		Promise.resolve('---\nversion: 1\n---\nbody'),
	) as any;
	_internals.readKnowledge = makeMockFn(() => Promise.resolve([])) as any;
	// §9 runs its own gate + `recordCuratorSkips` call; stubbing it keeps the
	// spy's call list to exactly [§8b, §8c].
	_internals.autoRetireSkills = makeMockFn(() => Promise.resolve([])) as any;
	_internals.recordCuratorSkips = recordCuratorSkips as any;
	_internals.reviseSkill = reviseSkill as any;
	return { recordCuratorSkips, reviseSkill };
}

describe('curator coverage gate — runCuratorPhase call sites (issue #2038 C2)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('curator-coverage-gate-phase-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		Object.assign(_internals, originalInternals);
		resetGlobalEventBus();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Site 1 — src/hooks/curator.ts:2011 (skill revision, §8b)
	// -----------------------------------------------------------------------

	test('revision site: incomplete coverage + window below floorPerSkill SKIPS reviseSkill and counts one curator skip', async () => {
		const slug = 'rev-skill';
		const skillPath = skillPathFor(dir, slug);
		// 12 entries: >= curatorMinSample (10) but < floorPerSkill (20), so the
		// gate denies. 3/12 = 25% sits strictly inside the revision band
		// (> REVISION_VIOLATION_THRESHOLD, <= 0.3), so nothing but the gate can
		// stop `reviseSkill` here.
		const usage = [
			...verdicts(skillPath, 'violated', 3),
			...verdicts(skillPath, 'compliant', 9),
		];
		expect(3 / 12).toBeGreaterThan(REVISION_VIOLATION_THRESHOLD);
		expect(3 / 12).toBeLessThanOrEqual(0.3);
		expect(usage.length).toBeLessThan(FLOOR);

		const h = installStubs(slug, skillPath, usage, {
			skillOrigin: 'generated',
			version: 1,
			sourceKnowledgeIds: [],
		});

		const result = await runCuratorPhase(dir, 1, ['reviewer'], CONFIG, {});

		expect(h.reviseSkill.calls).toHaveLength(0);
		expect(result.digest.summary).not.toContain('revised');
		// §8b then §8c, in that order.
		expect(h.recordCuratorSkips.calls).toHaveLength(2);
		expect(h.recordCuratorSkips.calls[0]).toEqual([dir, 1]);
	});

	test('revision site: incomplete coverage + window AT floorPerSkill still REVISES — the gate is not a kill switch', async () => {
		const slug = 'rev-skill';
		const skillPath = skillPathFor(dir, slug);
		// Exactly floorPerSkill entries; 5/20 = 25%, same band as above.
		const usage = [
			...verdicts(skillPath, 'violated', 5),
			...verdicts(skillPath, 'compliant', 15),
		];
		expect(usage.length).toBe(FLOOR);

		const h = installStubs(slug, skillPath, usage, {
			skillOrigin: 'generated',
			version: 1,
			sourceKnowledgeIds: [],
		});

		const result = await runCuratorPhase(dir, 1, ['reviewer'], CONFIG, {});

		expect(h.reviseSkill.calls).toHaveLength(1);
		expect(h.reviseSkill.calls.length).toBeLessThanOrEqual(
			MAX_REVISION_CALLS_PER_PHASE,
		);
		expect(result.digest.summary).toContain(`skill '${slug}' revised to v2`);
		expect(h.recordCuratorSkips.calls[0]).toEqual([dir, 0]);
	});

	// -----------------------------------------------------------------------
	// Site 2 — src/hooks/curator.ts:2147 (promoted-external staleness, §8c)
	// -----------------------------------------------------------------------

	test('promoted-external site: incomplete coverage + window below floorPerSkill SKIPS the retire and counts one curator skip', async () => {
		const slug = 'pe-skill';
		const skillPath = writePromotedExternalSkill(dir, slug);
		// applied === 0 and 12 negative signals over a 120-day-old skill is
		// exactly `evaluatePromotedExternalStaleness`'s retire shape, so only the
		// coverage gate can stop the retirement.
		const usage = verdicts(skillPath, 'violated', 12);
		expect(usage.length).toBeLessThan(FLOOR);

		const h = installStubs(slug, skillPath, usage, {
			skillOrigin: 'promoted_external',
			version: 1,
			sourceKnowledgeIds: [],
		});

		const result = await runCuratorPhase(dir, 1, ['reviewer'], CONFIG, {});

		expect(result.digest.summary).not.toContain('retired');
		expect(
			fs.existsSync(path.join(path.dirname(skillPath), 'retired.marker')),
		).toBe(false);
		expect(fs.existsSync(skillPath)).toBe(true);
		expect(h.recordCuratorSkips.calls).toHaveLength(2);
		expect(h.recordCuratorSkips.calls[1]).toEqual([dir, 1]);
	});

	test('promoted-external site: incomplete coverage + window AT floorPerSkill still RETIRES', async () => {
		const slug = 'pe-skill';
		const skillPath = writePromotedExternalSkill(dir, slug);
		const usage = verdicts(skillPath, 'violated', FLOOR);

		const h = installStubs(slug, skillPath, usage, {
			skillOrigin: 'promoted_external',
			version: 1,
			sourceKnowledgeIds: [],
		});

		const result = await runCuratorPhase(dir, 1, ['reviewer'], CONFIG, {});

		expect(result.digest.summary).toContain(
			`promoted-external skill '${slug}' retired`,
		);
		expect(h.recordCuratorSkips.calls[1]).toEqual([dir, 0]);
	});

	// -----------------------------------------------------------------------
	// Third F5 gap — the durable `curator_skipped` counter, unstubbed
	// -----------------------------------------------------------------------

	test('the REAL recordCuratorSkips folds the pass total into the durable curator_skipped counter on disk', () => {
		const pendingPath = path.join(dir, '.swarm', 'skill-usage-pending.json');
		expect(fs.existsSync(pendingPath)).toBe(false);

		originalInternals.recordCuratorSkips(dir, 2);
		originalInternals.recordCuratorSkips(dir, 3);
		// Documented non-behavior: a non-positive total writes nothing at all.
		originalInternals.recordCuratorSkips(dir, 0);

		const doc = JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as {
			counters: Record<string, number>;
		};
		expect(doc.counters.curator_skipped).toBe(5);
		// It is a counter fold, not a store rewrite: nothing else moved.
		expect(doc.counters.dropped).toBe(0);
		expect(doc.counters.accepted).toBe(0);
	});

	test('the REAL recordCuratorSkips creates nothing when there is no .swarm directory', () => {
		const bare = canonicalMkdtemp('curator-skips-no-swarm-');
		try {
			originalInternals.recordCuratorSkips(bare, 4);
			expect(fs.existsSync(path.join(bare, '.swarm'))).toBe(false);
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});
});
