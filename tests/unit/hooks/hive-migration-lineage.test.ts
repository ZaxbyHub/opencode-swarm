/**
 * Migration & lineage gate (issue #1847 §"Required tests").
 *
 * Verifies:
 *  - Mixed legacy/new hive records normalize and persist idempotently inside
 *    the transaction; a no-op mutation does NOT rewrite disk.
 *  - Old records receive NO synthetic application credit.
 *  - Source UUID / cohort / evidence remain traceable after promotion.
 *  - Failure during migration/validation leaves a valid rollback source (the
 *    prior file is intact; no partial committed file).
 *  - Lineage is preserved and merged (merged_from retains the losing id).
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
import {
	_internals as _internals_hiveTxn,
	transactHiveStore,
} from '../../../src/hooks/hive-transaction.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';

const FIXED_COHORT = {
	cohortId: 'cohort-mig-aaa',
	source: 'remote' as const,
	normalizedRemote: 'github.com/t/r',
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

function legacyHiveEntry(
	overrides: Partial<HiveKnowledgeEntry> = {},
): HiveKnowledgeEntry {
	return {
		id: 'legacy-1',
		tier: 'hive',
		lesson: 'A legacy hive lesson that predates the lineage schema entirely',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.6,
		status: 'established',
		// Legacy: no cohort_id on confirmations, no lineage block.
		confirmed_by: [
			{ project_name: 'old-project', confirmed_at: '2025-01-01T00:00:00Z' },
		],
		retrieval_outcomes: {
			applied_count: 5, // frozen v1 legacy value — must NOT be credited.
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2025-01-01T00:00:00Z',
		updated_at: '2025-01-01T00:00:00Z',
		source_project: 'old-project',
		encounter_score: 1.0,
		...overrides,
	};
}

async function readRawHive(): Promise<HiveKnowledgeEntry[]> {
	try {
		const content = await fsPromises.readFile(
			resolveHiveKnowledgePath(),
			'utf-8',
		);
		return content
			.split('\n')
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as HiveKnowledgeEntry);
	} catch {
		return [];
	}
}

describe('hive migration & lineage gate (#1847)', () => {
	let tempHome: string;
	let swarmDir: string;
	let realHome: string | undefined;

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-mig-')));
		realHome = process.env.HOME;
		process.env.HOME = tempHome;
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
		}
		swarmDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-mig-')));
		_internals.resolveCohortId = mock(async () => FIXED_COHORT);
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

	describe('lineage preservation', () => {
		it('promoted entry preserves source entry id, cohort, and promotion event id', async () => {
			const swarm: SwarmKnowledgeEntry = {
				id: 'src-uuid-123',
				tier: 'swarm',
				lesson: 'A traceable lesson about preserving promotion lineage now',
				category: 'process',
				tags: ['hive-fast-track'],
				scope: 'global',
				confidence: 0.7,
				status: 'promoted',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'p',
			};
			await checkHivePromotions([swarm], makeConfig(), swarmDir);
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].lineage?.source_entry_id).toBe('src-uuid-123');
			expect(hive[0].lineage?.source_cohort_id).toBe(FIXED_COHORT.cohortId);
			expect(hive[0].lineage?.promotion_event_id).toBeTruthy();
			expect(hive[0].lineage?.actor).toBe('auto');
		});
	});

	describe('mixed-schema idempotency', () => {
		it('a no-op mutation over a legacy hive does NOT rewrite the file', async () => {
			const legacy = legacyHiveEntry();
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			const original = `${JSON.stringify(legacy)}\n`;
			await fsPromises.writeFile(resolveHiveKnowledgePath(), original, 'utf-8');
			const mtimeBefore = (await fsPromises.stat(resolveHiveKnowledgePath()))
				.mtimeMs;

			// A no-op transaction: mutate returns noop.
			await transactHiveStore(async (ctx) => ({
				kind: 'noop' as const,
				return: undefined,
			}));

			const contentAfter = await fsPromises.readFile(
				resolveHiveKnowledgePath(),
				'utf-8',
			);
			expect(contentAfter).toBe(original);
			// The transaction must not rewrite on a no-op.
			const mtimeAfter = (await fsPromises.stat(resolveHiveKnowledgePath()))
				.mtimeMs;
			expect(mtimeAfter).toBe(mtimeBefore);
		});

		it('legacy records receive NO synthetic cohort_id or lineage on read', async () => {
			const legacy = legacyHiveEntry();
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(legacy)}\n`,
				'utf-8',
			);
			// A read+noop transaction loads the entry; the on-disk record is
			// unchanged (no synthetic cohort/lineage back-fill written).
			let observed: HiveKnowledgeEntry[] = [];
			await transactHiveStore(async (ctx) => {
				observed = ctx.entries;
				return { kind: 'noop' as const, return: undefined };
			});
			expect(observed).toHaveLength(1);
			// The legacy confirmed_by record still has no cohort_id.
			expect(observed[0].confirmed_by[0].cohort_id).toBeUndefined();
			// Frozen v1 applied_count is preserved as-is (NOT credited as evidence).
			expect(observed[0].retrieval_outcomes.applied_count).toBe(5);
		});
	});

	describe('rollback on validation failure', () => {
		it('a validation failure inside the transaction leaves the prior file intact', async () => {
			const legacy = legacyHiveEntry();
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			const original = `${JSON.stringify(legacy)}\n`;
			await fsPromises.writeFile(resolveHiveKnowledgePath(), original, 'utf-8');

			// Attempt a commit that produces an INVALID entry (missing id).
			const result = await transactHiveStore(async () => ({
				kind: 'commit' as const,
				entries: [
					// Invalid: no id, no lesson.
					{ tier: 'hive' } as HiveKnowledgeEntry,
				],
				return: undefined,
			}));

			expect(result.committed).toBe(false);
			expect(result.diagnostics.length).toBeGreaterThan(0);
			// The prior file is intact — no partial committed file.
			const contentAfter = await fsPromises.readFile(
				resolveHiveKnowledgePath(),
				'utf-8',
			);
			expect(contentAfter).toBe(original);
		});
	});

	describe('cap inside the transaction (no separate enforceKnowledgeCap)', () => {
		it('cap enforcement happens inside the same commit, evicting excess entries', async () => {
			// Seed 2 entries, then commit a 3rd with maxEntries=2.
			const e1 = legacyHiveEntry({
				id: 'h1',
				lesson: 'first hive lesson about capping entries',
			});
			const e2 = legacyHiveEntry({
				id: 'h2',
				lesson: 'second hive lesson about capping entries',
			});
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`,
				'utf-8',
			);

			const result = await transactHiveStore(async (ctx) => {
				const e3 = legacyHiveEntry({
					id: 'h3',
					lesson: 'third hive lesson about capping entries now',
					status: 'candidate',
				});
				return {
					kind: 'commit' as const,
					entries: [...ctx.entries, e3],
					maxEntries: 2,
					return: undefined,
				};
			});
			expect(result.committed).toBe(true);
			const hive = await readRawHive();
			// Cap was applied inside the commit → at most 2 entries survive.
			expect(hive.length).toBeLessThanOrEqual(2);
		});

		it('cap priority: an inactive (archived) entry is evicted before an active one (PRR-6)', async () => {
			const active = legacyHiveEntry({
				id: 'h-active',
				lesson: 'an active established hive lesson that should survive cap',
				status: 'established',
			});
			const archived = legacyHiveEntry({
				id: 'h-archived',
				lesson: 'an archived hive lesson that should be evicted by cap',
				status: 'archived',
			});
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(active)}\n${JSON.stringify(archived)}\n`,
				'utf-8',
			);
			// Commit a 3rd entry with maxEntries=2 → one must be evicted.
			const extra = legacyHiveEntry({
				id: 'h-extra',
				lesson: 'an extra hive lesson forcing the cap to evict one entry',
				status: 'established',
			});
			await transactHiveStore(async (ctx) => ({
				kind: 'commit' as const,
				entries: [...ctx.entries, extra],
				maxEntries: 2,
				return: undefined,
			}));
			const hive = await readRawHive();
			expect(hive).toHaveLength(2);
			// The archived (inactive, priority 0) entry is evicted; active survives.
			const ids = hive.map((h) => h.id);
			expect(ids).toContain('h-active');
			expect(ids).not.toContain('h-archived');
		});
	});

	describe('lineage merge (F-001)', () => {
		it('a near-duplicate promotion records the losing source id in merged_from', async () => {
			// Seed the hive with an existing entry.
			const existing = legacyHiveEntry({
				id: 'hive-existing',
				lesson: 'Use bun for fast test execution across the project',
				lineage: { actor: 'auto', source_entry_id: 'src-old' },
			});
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(existing)}\n`,
				'utf-8',
			);
			// Run checkHivePromotions with a near-duplicate swarm entry (same lesson).
			const { checkHivePromotions, _internals } = await import(
				'../../../src/hooks/hive-promoter.js'
			);
			const swarm: SwarmKnowledgeEntry = {
				id: 'src-new-dup',
				tier: 'swarm',
				lesson: 'Use bun for fast test execution across the project',
				category: 'process',
				tags: ['hive-fast-track'],
				scope: 'global',
				confidence: 0.7,
				status: 'promoted',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'p',
			};
			_internals.resolveCohortId = mock(async () => FIXED_COHORT);
			_internals.validateLesson = mock(() => ({
				valid: true,
				layer: 1,
				reason: '',
				severity: 'none' as const,
			})) as unknown as typeof _internals.validateLesson;
			_internals.loadPromotionEvidence = mock(
				async () => ({}),
			) as unknown as typeof _internals.loadPromotionEvidence;

			await checkHivePromotions([swarm], makeConfig(), swarmDir);
			const hive = await readRawHive();
			// The near-duplicate was NOT added as a new entry (dedup)...
			expect(hive).toHaveLength(1);
			// ...but its source id was recorded in merged_from (provenance preserved).
			expect(hive[0].lineage?.merged_from).toContain('src-new-dup');
		});
	});

	describe('confirmed_by backfill (PRR-2)', () => {
		it('a legacy hive record with missing confirmed_by loads as [] and does not throw', async () => {
			// Hand-write a malformed record with NO confirmed_by field.
			const malformed = {
				id: 'malformed-1',
				tier: 'hive',
				lesson: 'a malformed legacy hive record missing confirmed_by field',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'established',
				// confirmed_by intentionally OMITTED
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2025-01-01T00:00:00Z',
				updated_at: '2025-01-01T00:00:00Z',
				source_project: 'old',
				encounter_score: 1.0,
			};
			await fsPromises.mkdir(path.dirname(resolveHiveKnowledgePath()), {
				recursive: true,
			});
			await fsPromises.writeFile(
				resolveHiveKnowledgePath(),
				`${JSON.stringify(malformed)}\n`,
				'utf-8',
			);
			// A read+noop transaction must NOT throw on the missing confirmed_by.
			let observed: HiveKnowledgeEntry[] = [];
			const result = await transactHiveStore(async (ctx) => {
				observed = ctx.entries;
				return { kind: 'noop' as const, return: undefined };
			});
			expect(result.committed).toBe(false);
			expect(observed).toHaveLength(1);
			// normalizeEntry backfilled confirmed_by to [] in memory.
			expect(Array.isArray(observed[0].confirmed_by)).toBe(true);
			expect(observed[0].confirmed_by).toEqual([]);
		});
	});

	describe('lock-acquire fail-safe (PRR-5)', () => {
		it('transactHiveStore returns committed:false + diagnostics on lock failure (never hangs)', async () => {
			// Inject a lockfile mock that always rejects acquire.
			const origLock = _internals_hiveTxn.lockfile;
			_internals_hiveTxn.lockfile = {
				lock: mock(async () => {
					throw new Error('simulated lock contention');
				}),
			} as unknown as typeof origLock;
			try {
				const result = await transactHiveStore(async () => ({
					kind: 'commit' as const,
					entries: [],
					return: 'should-not-reach',
				}));
				expect(result.committed).toBe(false);
				expect(result.return).toBeUndefined();
				expect(result.diagnostics.length).toBeGreaterThan(0);
				expect(result.diagnostics.join(' ')).toContain('lock acquire failed');
			} finally {
				_internals_hiveTxn.lockfile = origLock;
			}
		});
	});
});
