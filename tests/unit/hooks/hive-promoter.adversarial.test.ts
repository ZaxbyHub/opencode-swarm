/**
 * Adversarial security/edge-case tests for hive-promoter.ts (transactional, #1847).
 *
 * These tests attack vectors — malformed inputs, oversized payloads, injection
 * attempts, boundary violations, abuse of the promotion system. They exercise
 * the REAL transactional contract via real temp-dir I/O + the `_internals` DI
 * seam (AGENTS.md invariant 7), NOT `mock.module` (which leaks across test
 * files in Bun's shared runner and cannot observe the transaction).
 *
 * Happy-path tests live in hive-promoter.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	promises as fsPromises,
	mkdtempSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	checkHivePromotions,
} from '../../../src/hooks/hive-promoter.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import { ACTIONABLE_FIELDS, makeConfig, readRawHive } from './hive-fixtures.js';

const FIXED_COHORT = {
	cohortId: 'cohort-adv-aaa111',
	source: 'remote' as const,
	normalizedRemote: 'github.com/test/repo',
	degraded: false,
};

/**
 * Carries `ACTIONABLE_FIELDS` so the fixture clears the default-ON #1821 A3
 * `actionability_floor` gate — these scenarios attack other axes. Negative
 * coverage for the floor itself lives in hive-actionability-floor.test.ts.
 */
function makeSwarmEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: 'swarm-1',
		tier: 'swarm',
		lesson: 'Valid lesson about testing strategies for the project',
		category: 'testing',
		tags: ['testing', 'quality'],
		scope: 'global',
		confidence: 0.8,
		status: 'candidate',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2024-01-01T00:00:00Z',
				project_name: 'project-a',
			},
			{
				phase_number: 2,
				confirmed_at: '2024-01-02T00:00:00Z',
				project_name: 'project-a',
			},
			{
				phase_number: 3,
				confirmed_at: '2024-01-03T00:00:00Z',
				project_name: 'project-a',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		hive_eligible: true,
		project_name: 'project-a',
		...ACTIONABLE_FIELDS,
		...overrides,
	};
}

describe('hive-promoter adversarial tests (transactional, #1847)', () => {
	let tempHome: string;
	let swarmDir: string;
	let realHome: string | undefined;

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-adv-')));
		realHome = process.env.HOME;
		process.env.HOME = tempHome;
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
		}
		swarmDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-adv-')));
		_internals.resolveCohortId = mock(async () => FIXED_COHORT);
		// Permissive validator by default; specific tests override severity.
		_internals.validateLesson = mock(() => ({
			valid: true,
			layer: 1,
			reason: '',
			severity: 'none' as const,
		})) as unknown as typeof _internals.validateLesson;
		_internals.loadPromotionEvidence = mock(
			async () => ({}),
		) as unknown as typeof _internals.loadPromotionEvidence;
	});

	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		delete process.env.LOCALAPPDATA;
		rmSync(tempHome, { recursive: true, force: true });
		rmSync(swarmDir, { recursive: true, force: true });
		mock.restore();
	});

	describe('SCENARIO 1: Empty swarm entries array', () => {
		it('should complete without errors and no hive write when swarm entries is empty', async () => {
			const summary = await checkHivePromotions([], makeConfig(), swarmDir);
			expect(summary.new_promotions).toBe(0);
			expect(summary.advancements).toBe(0);
			expect(await readRawHive()).toHaveLength(0);
		});
	});

	describe('SCENARIO 2: Null/undefined lesson in swarm entry', () => {
		it('should not crash when lesson is null (defensively skipped, no hive write)', async () => {
			const entry = makeSwarmEntry({ lesson: null as unknown as string });
			// Must not throw and must not write a garbage entry to the hive.
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(0);
		});

		it('should not crash when lesson is undefined', async () => {
			const entry = makeSwarmEntry({ lesson: undefined as unknown as string });
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(0);
		});
	});

	describe('SCENARIO 3: Negative auto_promote_days', () => {
		it('should promote eligible entries when auto_promote_days is negative (age threshold negative)', async () => {
			const entry = makeSwarmEntry({
				id: 'swarm-2',
				hive_eligible: false,
				tags: [],
				confirmed_by: [],
				created_at: new Date().toISOString(),
			});
			await checkHivePromotions(
				[entry],
				makeConfig({ auto_promote_days: -1 }),
				swarmDir,
			);
			// Negative threshold → even a brand-new entry is "old enough" (route 3).
			expect(await readRawHive()).toHaveLength(1);
		});
	});

	describe('SCENARIO 4: Zero dedup_threshold', () => {
		it('should treat any existing similar entry as a duplicate when dedup_threshold is 0', async () => {
			const entry = makeSwarmEntry();
			// Pre-seed the hive with a near-match (shares words).
			const existing: HiveKnowledgeEntry = {
				id: 'hive-existing',
				tier: 'hive',
				lesson: 'Valid lesson about testing strategies for the project',
				category: 'testing',
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
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				source_project: 'project-b',
				encounter_score: 1.0,
			};
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(existing)}\n`,
			);
			await checkHivePromotions(
				[entry],
				makeConfig({ dedup_threshold: 0 }),
				swarmDir,
			);
			// Threshold 0 → identical lesson is a duplicate → no new promotion.
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].id).toBe('hive-existing');
		});
	});

	describe('SCENARIO 5: Repeated hive-fast-track tag', () => {
		it('should promote only once even with repeated hive-fast-track tag', async () => {
			const entry = makeSwarmEntry({
				tags: ['hive-fast-track', 'hive-fast-track', 'hive-fast-track'],
				hive_eligible: false,
				confirmed_by: [],
			});
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(1);
		});
	});

	describe('SCENARIO 6: 3 confirmations from the SAME phase_number', () => {
		it('should NOT promote when all 3 confirmations share one phase (not distinct)', async () => {
			const entry = makeSwarmEntry({
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00Z',
						project_name: 'p',
					},
					{
						phase_number: 1,
						confirmed_at: '2024-01-02T00:00:00Z',
						project_name: 'p',
					},
					{
						phase_number: 1,
						confirmed_at: '2024-01-03T00:00:00Z',
						project_name: 'p',
					},
				],
				// Recent so route 3 (age) does not fire.
				created_at: new Date().toISOString(),
				tags: [],
			});
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			// Same phase repeated = 1 distinct phase → route 1 requires >= 3 distinct.
			expect(await readRawHive()).toHaveLength(0);
		});
	});

	describe('SCENARIO 7: 3 confirmations from the same project (hive advancement)', () => {
		it('should NOT advance to established with 3 confirmations from the same cohort', async () => {
			const existing: HiveKnowledgeEntry = {
				id: 'hive-1',
				tier: 'hive',
				lesson: 'Valid lesson about testing strategies for the project',
				category: 'testing',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'candidate',
				confirmed_by: [
					{
						project_name: 'p',
						cohort_id: FIXED_COHORT.cohortId,
						confirmed_at: '2024-01-01T00:00:00Z',
					},
					{
						project_name: 'p',
						cohort_id: FIXED_COHORT.cohortId,
						confirmed_at: '2024-01-02T00:00:00Z',
					},
					{
						project_name: 'p',
						cohort_id: FIXED_COHORT.cohortId,
						confirmed_at: '2024-01-03T00:00:00Z',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				source_project: 'p',
				encounter_score: 1.0,
				lineage: { actor: 'auto', source_cohort_id: FIXED_COHORT.cohortId },
			};
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(existing)}\n`,
			);
			const swarm = makeSwarmEntry({ project_name: 'p' });
			const summary = await checkHivePromotions(
				[swarm],
				makeConfig(),
				swarmDir,
			);
			// Same cohort repeated = 1 distinct → no advancement.
			expect(summary.advancements).toBe(0);
			const hive = await readRawHive();
			expect(hive[0].status).toBe('candidate');
		});
	});

	describe('SCENARIO 8: Lesson at char boundary', () => {
		it('should accept a lesson at exactly 280 chars (validator passes)', async () => {
			const entry = makeSwarmEntry({ lesson: 'a'.repeat(280) });
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(1);
		});

		it('should reject a lesson at 281 chars when validator flags it', async () => {
			_internals.validateLesson = mock(() => ({
				valid: false,
				layer: 2,
				reason: 'lesson too long',
				severity: 'error' as const,
			})) as unknown as typeof _internals.validateLesson;
			const entry = makeSwarmEntry({ lesson: 'a'.repeat(281) });
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(0);
		});
	});

	describe('SCENARIO 9: Lesson with injection characters', () => {
		it('should block a lesson with control characters before hive write (validator fails)', async () => {
			_internals.validateLesson = mock(() => ({
				valid: false,
				layer: 1,
				reason: 'control characters',
				severity: 'error' as const,
			})) as unknown as typeof _internals.validateLesson;
			const entry = makeSwarmEntry({ lesson: 'evil\u0000\u0001lesson' });
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(0);
		});
	});

	describe('SCENARIO 10: Large swarm entries array', () => {
		it('should process 1000 entries without hanging or error', async () => {
			const entries: SwarmKnowledgeEntry[] = [];
			for (let i = 0; i < 1000; i++) {
				entries.push(
					makeSwarmEntry({
						id: `swarm-${i}`,
						lesson: `Unique lesson number ${i} about a distinct topic`,
						hive_eligible: false,
						tags: ['hive-fast-track'],
						confirmed_by: [],
					}),
				);
			}
			const summary = await checkHivePromotions(
				entries,
				makeConfig(),
				swarmDir,
			);
			expect(summary.new_promotions).toBe(1000);
		});
	});

	describe('SCENARIO 11: hive_enabled undefined (falsy but not false)', () => {
		it('should NOT early-exit when hive_enabled is undefined', async () => {
			const config = makeConfig();
			// undefined is not === false, so promotion proceeds.
			(config as { hive_enabled?: boolean }).hive_enabled = undefined;
			const entry = makeSwarmEntry();
			// Cast: the test intentionally exercises the falsy-not-false branch.
			await checkHivePromotions([entry], config as KnowledgeConfig, swarmDir);
			expect(await readRawHive()).toHaveLength(1);
		});
	});

	describe('SCENARIO 12: invalid schema_version on swarm entry', () => {
		it('should use config.schema_version when entry has schema_version: 0', async () => {
			const entry = makeSwarmEntry({
				schema_version: 0,
			} as SwarmKnowledgeEntry);
			await checkHivePromotions(
				[entry],
				makeConfig({ schema_version: 2 }),
				swarmDir,
			);
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].schema_version).toBe(2);
		});
	});

	describe('Additional edge cases', () => {
		it('should handle an entry with an invalid created_at date gracefully', async () => {
			// Route 3 falls back to ageMs=0 (not old enough) — no crash.
			const entry = makeSwarmEntry({
				created_at: 'not-a-date',
				hive_eligible: false,
				tags: [],
				confirmed_by: [],
			});
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(0);
		});

		it('should handle an empty tags array without error', async () => {
			const entry = makeSwarmEntry({ tags: [] });
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(1);
		});

		it('should handle a missing hive_eligible property (undefined)', async () => {
			const entry = makeSwarmEntry({ hive_eligible: undefined });
			// hive_eligible undefined → route 1 fails; but entry is old (2024) → route 3 fires.
			await checkHivePromotions([entry], makeConfig(), swarmDir);
			expect(await readRawHive()).toHaveLength(1);
		});
	});
});
