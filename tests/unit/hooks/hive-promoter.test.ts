/**
 * Verification tests for hive-promoter.ts (transactional, #1847).
 *
 * These tests exercise the REAL transactional contract: every hive write goes
 * through `transactHiveStore`, which acquires the directory lock, reads the
 * current hive, runs the mutation, validates, enforces the cap, stages audit
 * appends, and persists atomically. Tests isolate the hive store by redirecting
 * `process.env.HOME` to a per-test temp directory (the hive path resolver reads
 * HOME live), and inject the cohort resolver + validateLesson via the
 * `_internals` DI seam (AGENTS.md invariant 7) rather than `mock.module`, which
 * leaks across test files in Bun's shared runner.
 *
 * Behavior coverage (ported from the pre-#1847 suite):
 *  - checkHivePromotions: route 1 (3-phase), route 2 (fast-track), route 3
 *    (age) + negatives; validation-fail reject path; hive_enabled=false early
 *    exit; dedup skip; actionable-directive carry-over; cross-project
 *    advancement at 3 distinct projects; same-run double-count prevention;
 *    weighted encounter scores (cross/same/min/max).
 *  - promoteToHive / promoteFromSwarm: validation error, near-duplicate
 *    short-circuit, not-found throw, field carry-over, source_project basename,
 *    canonical path/field names, lineage, override semantics.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	promises as fsPromises,
	mkdir,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFile,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	checkHivePromotions,
	createHivePromoterHook,
	promoteFromSwarm,
	promoteToHive,
} from '../../../src/hooks/hive-promoter.js';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';

const realReadKnowledge = _internals.readSwarmEntries;

/**
 * Read raw JSONL lines from a path (no normalization). Used to assert on the
 * exact on-disk content written by the transaction.
 */
async function readRawHive(): Promise<HiveKnowledgeEntry[]> {
	const fp = resolveHiveKnowledgePath();
	try {
		const content = await fsPromises.readFile(fp, 'utf-8');
		return content
			.split('\n')
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as HiveKnowledgeEntry);
	} catch {
		return [];
	}
}

async function writeSwarmEntries(
	dir: string,
	entries: SwarmKnowledgeEntry[],
): Promise<void> {
	const fp = resolveSwarmKnowledgePath(dir);
	await fsPromises.mkdir(path.dirname(fp), { recursive: true });
	await fsPromises.writeFile(
		fp,
		entries.map((e) => JSON.stringify(e)).join('\n') +
			(entries.length > 0 ? '\n' : ''),
		'utf-8',
	);
}

async function writeHiveEntries(entries: HiveKnowledgeEntry[]): Promise<void> {
	const fp = resolveHiveKnowledgePath();
	await fsPromises.mkdir(path.dirname(fp), { recursive: true });
	await fsPromises.writeFile(
		fp,
		entries.map((e) => JSON.stringify(e)).join('\n') +
			(entries.length > 0 ? '\n' : ''),
		'utf-8',
	);
}

/** A fixed cohort identity so tests do not shell out to git. */
const FIXED_COHORT = {
	cohortId: 'cohort-aaaa11112222',
	source: 'remote' as const,
	normalizedRemote: 'github.com/test/repo',
	degraded: false,
};

function makeConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.8,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 2,
		same_project_weight: 1.0,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1.0,
		encounter_increment: 0.1,
		max_encounter_score: 10.0,
		default_max_phases: 10,
		todo_max_phases: 3,
		sweep_enabled: true,
		confidence_floor_action: 'demote',
		confidence_floor_min_outcomes: 3,
		confidence_floor_signal_threshold: 0,
		contradiction_threshold_action: 'quarantine',
		contradiction_quarantine_threshold: 3,
		contradiction_quarantine_window_days: 30,
		promoted_demotion_min_negative_phases: 3,
		promoted_demotion_signal_threshold: -0.3,
		promotion_min_terminal_applications: 0,
		promotion_min_distinct_cohorts: 0,
		directive_min_confidence: 0.75,
		...overrides,
	};
}

/** Build a swarm entry confirmed across N phases (route 1 eligibility). */
function makeSwarmEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: 'swarm-1',
		tier: 'swarm',
		lesson: 'Use bun for fast test execution across the project',
		category: 'process',
		tags: ['testing', 'performance'],
		scope: 'global',
		confidence: 0.7,
		status: 'promoted',
		hive_eligible: true,
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00Z',
				project_name: 'projectA',
			},
			{
				phase_number: 2,
				confirmed_at: '2026-01-02T00:00:00Z',
				project_name: 'projectA',
			},
			{
				phase_number: 3,
				confirmed_at: '2026-01-03T00:00:00Z',
				project_name: 'projectA',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		project_name: 'projectA',
		...overrides,
	};
}

describe('hive-promoter (transactional, #1847)', () => {
	let tempHome: string;
	let swarmDir: string;
	let realHome: string | undefined;

	beforeEach(() => {
		// Isolate the hive store by redirecting HOME to a per-test temp dir.
		// The hive path resolver reads process.env.HOME live each call.
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-test-')));
		realHome = process.env.HOME;
		process.env.HOME = tempHome;
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
		}

		swarmDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-')));

		// Inject a fixed cohort identity so tests don't shell out to git, and a
		// permissive validator. Restore in afterEach (invariant 7).
		_internals.resolveCohortId = mock(async () => FIXED_COHORT);
		_internals.validateLesson = mock(() => ({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		})) as unknown as typeof _internals.validateLesson;
		_internals.loadPromotionEvidence = mock(
			async () => ({}),
		) as unknown as typeof _internals.loadPromotionEvidence;
	});

	afterEach(() => {
		// Restore HOME + DI seams.
		if (realHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = realHome;
		}
		delete process.env.LOCALAPPDATA;
		_internals.readSwarmEntries = realReadKnowledge;
		rmSync(tempHome, { recursive: true, force: true });
		rmSync(swarmDir, { recursive: true, force: true });
		mock.restore();
	});

	describe('checkHivePromotions — promotion routes', () => {
		it('route 1: hive_eligible + 3 phases promotes to candidate with lineage', async () => {
			const entry = makeSwarmEntry();
			await writeSwarmEntries(swarmDir, [entry]);

			const summary = await checkHivePromotions(
				[entry],
				makeConfig(),
				swarmDir,
			);

			expect(summary.new_promotions).toBe(1);
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].status).toBe('candidate');
			expect(hive[0].confidence).toBe(0.5);
			expect(hive[0].confirmed_by).toEqual([]);
			expect(hive[0].source_project).toBe('projectA');
			expect(hive[0].encounter_score).toBe(1.0);
			// #1847 lineage: source entry id + source cohort preserved.
			expect(hive[0].lineage).toBeDefined();
			expect(hive[0].lineage?.source_entry_id).toBe('swarm-1');
			expect(hive[0].lineage?.source_cohort_id).toBe(FIXED_COHORT.cohortId);
			expect(hive[0].lineage?.actor).toBe('auto');
			expect(hive[0].lineage?.promotion_event_id).toBeTruthy();
		});

		it('route 1 negative: only 2 phases does NOT promote', async () => {
			// Recent created_at so route 3 (age) also does not fire.
			const entry = makeSwarmEntry({
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
				],
				created_at: new Date().toISOString(),
			});
			const summary = await checkHivePromotions(
				[entry],
				makeConfig(),
				swarmDir,
			);
			expect(summary.new_promotions).toBe(0);
			expect(await readRawHive()).toHaveLength(0);
		});

		it('route 2: hive-fast-track tag promotes regardless of phase count', async () => {
			const entry = makeSwarmEntry({
				tags: ['hive-fast-track'],
				hive_eligible: false,
				confirmed_by: [],
			});
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(1);
		});

		it('route 3: entry older than auto_promote_days promotes', async () => {
			const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
			const entry = makeSwarmEntry({
				hive_eligible: false,
				confirmed_by: [],
				created_at: old,
			});
			await checkHivePromotions(
				[entry],
				makeConfig({ auto_promote_days: 90 }),
				swarmDir,
			);
			expect(await readRawHive()).toHaveLength(1);
		});

		it('route 3 negative: entry not old enough is not promoted', async () => {
			const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
			const entry = makeSwarmEntry({
				hive_eligible: false,
				confirmed_by: [],
				created_at: recent,
			});
			await checkHivePromotions(
				[entry],
				makeConfig({ auto_promote_days: 90 }),
				swarmDir,
			);
			expect(await readRawHive()).toHaveLength(0);
		});

		it('hive_enabled=false early-exits with no store I/O', async () => {
			const entry = makeSwarmEntry();
			const summary = await checkHivePromotions(
				[entry],
				makeConfig({ hive_enabled: false }),
				swarmDir,
			);
			expect(summary.new_promotions).toBe(0);
			expect(await readRawHive()).toHaveLength(0);
		});

		it('already-in-hive near-duplicate is skipped', async () => {
			const entry = makeSwarmEntry();
			const existing: HiveKnowledgeEntry = {
				id: 'hive-existing',
				tier: 'hive',
				lesson: entry.lesson,
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				source_project: 'otherProject',
				encounter_score: 1.0,
			};
			await writeHiveEntries([existing]);

			const summary = await checkHivePromotions(
				[entry],
				makeConfig(),
				swarmDir,
			);
			expect(summary.new_promotions).toBe(0);
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].id).toBe('hive-existing');
		});

		it('carries actionable-directive fields across promotion', async () => {
			const entry = makeSwarmEntry({
				triggers: ['coder modifying src'],
				required_actions: ['run typecheck'],
				forbidden_actions: ['skip tests'],
				verification_checks: ['tsc --noEmit'],
				verification_predicate: 'grep:TODO:src/**',
				applies_to_agents: ['coder'],
				applies_to_tools: ['write'],
				directive_priority: 'high',
			});
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			const hive = await readRawHive();
			expect(hive[0].triggers).toEqual(['coder modifying src']);
			expect(hive[0].required_actions).toEqual(['run typecheck']);
			expect(hive[0].forbidden_actions).toEqual(['skip tests']);
			expect(hive[0].verification_checks).toEqual(['tsc --noEmit']);
			expect(hive[0].verification_predicate).toBe('grep:TODO:src/**');
			expect(hive[0].applies_to_agents).toEqual(['coder']);
			expect(hive[0].applies_to_tools).toEqual(['write']);
			expect(hive[0].directive_priority).toBe('high');
		});

		it('validation-fail reject path writes to rejected log, not hive knowledge', async () => {
			_internals.validateLesson = mock(() => ({
				valid: false,
				layer: 3,
				reason: 'too short',
				severity: 'error',
			})) as unknown as typeof _internals.validateLesson;
			const entry = makeSwarmEntry();
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(0);
			const rejectedPath = path.join(
				path.dirname(resolveHiveKnowledgePath()),
				'shared-learnings-rejected.jsonl',
			);
			const rejectedRaw = await fsPromises
				.readFile(rejectedPath, 'utf-8')
				.catch(() => '');
			expect(rejectedRaw).toContain('rejection_layer');
			expect(rejectedRaw).toContain('"rejection_layer":3');
		});
	});

	describe('checkHivePromotions — cross-project advancement + scoring', () => {
		it('advances candidate → established at 3 distinct cohorts', async () => {
			const existing: HiveKnowledgeEntry = {
				id: 'hive-1',
				tier: 'hive',
				lesson: 'Use bun for fast test execution across the project',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'candidate',
				confirmed_by: [
					{
						project_name: 'p1',
						cohort_id: 'c1',
						confirmed_at: '2026-01-01T00:00:00Z',
					},
					{
						project_name: 'p2',
						cohort_id: 'c2',
						confirmed_at: '2026-01-02T00:00:00Z',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				source_project: 'p1',
				encounter_score: 1.0,
				lineage: { actor: 'auto', source_cohort_id: 'c1' },
			};
			await writeHiveEntries([existing]);

			// Swarm entry near-duplicates the hive lesson, from a 3rd cohort.
			const swarm = makeSwarmEntry({
				project_name: 'p3',
				hive_eligible: false,
				confirmed_by: [],
				created_at: new Date().toISOString(),
			});
			const summary = await checkHivePromotions(
				[swarm],
				makeConfig(),
				swarmDir,
			);
			expect(summary.advancements).toBe(1);
			const hive = await readRawHive();
			expect(hive[0].status).toBe('established');
			expect(hive[0].confirmed_by).toHaveLength(3);
			// New confirmation carries the canonical cohort_id of the source.
			const newConf = hive[0].confirmed_by[2];
			expect(newConf.cohort_id).toBe(FIXED_COHORT.cohortId);
		});

		it('does not double-count the same cohort already in confirmed_by', async () => {
			const existing: HiveKnowledgeEntry = {
				id: 'hive-1',
				tier: 'hive',
				lesson: 'Use bun for fast test execution across the project',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'candidate',
				confirmed_by: [
					{
						project_name: 'projectA',
						cohort_id: FIXED_COHORT.cohortId,
						confirmed_at: '2026-01-01T00:00:00Z',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				source_project: 'projectA',
				encounter_score: 1.0,
				lineage: { actor: 'auto', source_cohort_id: FIXED_COHORT.cohortId },
			};
			await writeHiveEntries([existing]);
			const swarm = makeSwarmEntry({ project_name: 'projectA' });
			const summary = await checkHivePromotions(
				[swarm],
				makeConfig(),
				swarmDir,
			);
			expect(summary.encounters_incremented).toBe(0);
			expect(summary.advancements).toBe(0);
		});

		it('weighted encounter score: cross-project uses cross_project_weight', async () => {
			const existing: HiveKnowledgeEntry = {
				id: 'hive-1',
				tier: 'hive',
				lesson: 'Use bun for fast test execution across the project',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'established',
				confirmed_by: [
					{
						project_name: 'p1',
						cohort_id: 'c1',
						confirmed_at: '2026-01-01T00:00:00Z',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				source_project: 'p1',
				encounter_score: 1.0,
				lineage: { actor: 'auto', source_cohort_id: 'c1' },
			};
			await writeHiveEntries([existing]);
			const swarm = makeSwarmEntry({ project_name: 'pOther' });
			const summary = await checkHivePromotions(
				[swarm],
				makeConfig({
					encounter_increment: 0.1,
					cross_project_weight: 1.0,
				}),
				swarmDir,
			);
			expect(summary.encounters_incremented).toBe(1);
			const hive = await readRawHive();
			// 1.0 + 0.1 * 1.0 = 1.1
			expect(hive[0].encounter_score).toBeCloseTo(1.1, 5);
		});

		it('respects max_encounter_score clamp', async () => {
			const existing: HiveKnowledgeEntry = {
				id: 'hive-1',
				tier: 'hive',
				lesson: 'Use bun for fast test execution across the project',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'established',
				confirmed_by: [
					{
						project_name: 'p1',
						cohort_id: 'c1',
						confirmed_at: '2026-01-01T00:00:00Z',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				source_project: 'p1',
				encounter_score: 4.99,
				lineage: { actor: 'auto', source_cohort_id: 'c1' },
			};
			await writeHiveEntries([existing]);
			const swarm = makeSwarmEntry({ project_name: 'pOther' });
			await checkHivePromotions(
				[swarm],
				makeConfig({ max_encounter_score: 5.0 }),
				swarmDir,
			);
			const hive = await readRawHive();
			expect(hive[0].encounter_score).toBe(5.0);
		});
	});

	describe('promoteToHive — manual direct promotion', () => {
		it('writes to the canonical hive path with lineage + canonical fields', async () => {
			const msg = await promoteToHive(
				swarmDir,
				'Always run the full test suite before merging a pull request',
			);
			expect(msg).toContain('Promoted to hive');
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].scope).toBe('global');
			expect(hive[0].retrieval_outcomes).toBeDefined();
			expect(hive[0].confidence).toBe(1.0);
			expect(hive[0].status).toBe('promoted');
			expect(hive[0].tier).toBe('hive');
			expect(hive[0].lineage?.actor).toBe('manual');
			expect(hive[0].lineage?.source_cohort_id).toBe(FIXED_COHORT.cohortId);
			// schema_version is KNOWLEDGE_SCHEMA_VERSION, not hardcoded 1 (M3 fix).
			expect(hive[0].schema_version).toBe(2);
			// source_project = basename of directory.
			expect(hive[0].source_project).toBe(path.basename(swarmDir));
		});

		it('near-duplicate short-circuits with no write', async () => {
			const lesson =
				'Always run the full test suite before merging a pull request';
			await writeHiveEntries([
				{
					id: 'existing',
					tier: 'hive',
					lesson,
					category: 'process',
					tags: [],
					scope: 'global',
					confidence: 0.6,
					status: 'established',
					confirmed_by: [],
					retrieval_outcomes: {
						applied_count: 0,
						succeeded_after_count: 0,
						failed_after_count: 0,
					},
					schema_version: 2,
					created_at: '2026-01-01T00:00:00Z',
					updated_at: '2026-01-01T00:00:00Z',
					source_project: 'p1',
					encounter_score: 1.0,
				},
			]);
			const msg = await promoteToHive(swarmDir, lesson);
			expect(msg).toContain('already exists');
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].id).toBe('existing');
		});

		it('validation error rejects without writing', async () => {
			_internals.validateLesson = mock(() => ({
				valid: false,
				layer: 1,
				reason: 'too short',
				severity: 'error',
			})) as unknown as typeof _internals.validateLesson;
			const msg = await promoteToHive(swarmDir, 'x');
			expect(msg).toContain('rejected by validator');
			expect(await readRawHive()).toHaveLength(0);
		});
	});

	describe('promoteFromSwarm — manual swarm-id promotion', () => {
		it('promotes by swarm id, preserving fields + lineage', async () => {
			const swarm = makeSwarmEntry({
				tags: ['security'],
				scope: 'global',
				category: 'security',
				project_name: 'projectA',
				lesson: 'Never commit secrets into the repository source tree ever',
			});
			await writeSwarmEntries(swarmDir, [swarm]);
			const msg = await promoteFromSwarm(swarmDir, 'swarm-1');
			expect(msg).toContain('Promoted lesson swarm-1 from swarm to hive');
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].lesson).toBe(swarm.lesson);
			expect(hive[0].category).toBe('security');
			expect(hive[0].tags).toEqual(['security']);
			expect(hive[0].scope).toBe('global');
			expect(hive[0].source_project).toBe('projectA');
			expect(hive[0].lineage?.source_entry_id).toBe('swarm-1');
			expect(hive[0].lineage?.source_cohort_id).toBe(FIXED_COHORT.cohortId);
			// New hive id is generated (not the swarm id).
			expect(hive[0].id).not.toBe('swarm-1');
		});

		it('not-found throws referencing the swarm knowledge file', async () => {
			await expect(promoteFromSwarm(swarmDir, 'missing-id')).rejects.toThrow(
				/not found/,
			);
		});

		it('policy-pass promotes; policy-fail without force is blocked', async () => {
			// An entry that fails all 3 routes AND is not fast-track.
			const swarm = makeSwarmEntry({
				hive_eligible: false,
				tags: [],
				confirmed_by: [],
				created_at: new Date().toISOString(), // too young for route 3
			});
			await writeSwarmEntries(swarmDir, [swarm]);
			const msg = await promoteFromSwarm(swarmDir, 'swarm-1');
			expect(msg).toContain('blocked by policy');
			expect(await readRawHive()).toHaveLength(0);
		});

		it('manual promotion honors the project config application-evidence threshold (MAJOR-1 fix)', async () => {
			// An old entry that passes eligibility route 3 (age) but has NO
			// validated terminal evidence. With a non-zero evidence threshold in
			// the REAL config, manual promotion must be blocked (no silent bypass).
			const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
			const swarm = makeSwarmEntry({
				hive_eligible: false,
				tags: [],
				confirmed_by: [],
				created_at: old,
			});
			await writeSwarmEntries(swarmDir, [swarm]);
			const evidenceConfig = makeConfig({
				promotion_min_terminal_applications: 3,
				promotion_min_distinct_cohorts: 2,
			});
			const msg = await promoteFromSwarm(
				swarmDir,
				'swarm-1',
				undefined,
				evidenceConfig,
			);
			expect(msg).toContain('blocked by policy');
			expect(await readRawHive()).toHaveLength(0);
		});

		it('policy-fail WITH --force --reason records an audited override', async () => {
			const swarm = makeSwarmEntry({
				hive_eligible: false,
				tags: [],
				confirmed_by: [],
				created_at: new Date().toISOString(),
			});
			await writeSwarmEntries(swarmDir, [swarm]);
			const msg = await promoteFromSwarm(swarmDir, 'swarm-1', {
				force: true,
				reason: 'operator override for critical hotfix lesson',
			});
			expect(msg).toContain('Promoted lesson');
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].lineage?.actor).toBe('manual-override');
			expect(hive[0].lineage?.reason).toBe(
				'operator override for critical hotfix lesson',
			);
			expect(hive[0].lineage?.override_failed_gates).toBeDefined();
			expect(
				(hive[0].lineage?.override_failed_gates ?? []).length,
			).toBeGreaterThan(0);
			// The override is durable: an audit line was staged to the hive events log.
			const eventsPath = path.join(
				path.dirname(resolveHiveKnowledgePath()),
				'shared-knowledge-events.jsonl',
			);
			const eventsRaw = await fsPromises
				.readFile(eventsPath, 'utf-8')
				.catch(() => '');
			expect(eventsRaw).toContain('"actor":"manual-override"');
			expect(eventsRaw).toContain('override_failed_gates');
		});
	});

	describe('createHivePromoterHook', () => {
		it('reads swarm entries and runs promotion', async () => {
			const entry = makeSwarmEntry();
			await writeSwarmEntries(swarmDir, [entry]);
			const hook = createHivePromoterHook(swarmDir, makeConfig());
			await hook({}, {});
			expect(await readRawHive()).toHaveLength(1);
		});
	});
});
