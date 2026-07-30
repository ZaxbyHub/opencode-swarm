/**
 * Actionability floor on promotion (issue #1821 Workstream A3).
 *
 * `evaluatePromotionPolicy` is the ONE evaluator shared by all three promote
 * paths — auto (`checkHivePromotions`), `promoteToHive` (direct text), and
 * `promoteFromSwarm` (by swarm id). This file proves the new
 * `actionability_floor` gate actually blocks on every one of them, that
 * `--force` still overrides while recording the failed gate durably, and that
 * `promotion_require_actionable: false` restores legacy behavior.
 *
 * Uses the real transactional contract via temp-dir I/O + the `_internals` DI
 * seam (AGENTS.md invariant 7), not `mock.module`.
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
	promoteFromSwarm,
	promoteToHive,
} from '../../../src/hooks/hive-promoter.js';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import { ACTIONABLE_FIELDS, makeConfig, readRawHive } from './hive-fixtures.js';

const FIXED_COHORT = {
	cohortId: 'cohort-a3-floor',
	source: 'remote' as const,
	normalizedRemote: 'github.com/t/r',
	degraded: false,
};

const PROSE_LESSON = 'Code quality matters a great deal to this whole team';

/**
 * A swarm entry that clears every OTHER gate (fast-track route 2, active
 * status, no floor demotion, zero evidence thresholds) and carries NO
 * predicate and NO scope — so `actionability_floor` is the only thing that can
 * refuse it.
 */
function proseOnlySwarmEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: 'swarm-prose',
		tier: 'swarm',
		lesson: PROSE_LESSON,
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
		project_name: 'projectA',
		...overrides,
	};
}

async function writeSwarmEntries(
	dir: string,
	entries: SwarmKnowledgeEntry[],
): Promise<void> {
	const fp = resolveSwarmKnowledgePath(dir);
	await fsPromises.mkdir(path.dirname(fp), { recursive: true });
	await fsPromises.writeFile(
		fp,
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		'utf-8',
	);
}

async function readHiveEvents(): Promise<Record<string, unknown>[]> {
	const eventsPath = path.join(
		path.dirname(resolveHiveKnowledgePath()),
		'shared-knowledge-events.jsonl',
	);
	const raw = await fsPromises.readFile(eventsPath, 'utf-8').catch(() => '');
	return raw
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('actionability floor on promotion (#1821 A3)', () => {
	let tempHome: string;
	let swarmDir: string;
	let realHome: string | undefined;

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-a3-')));
		realHome = process.env.HOME;
		process.env.HOME = tempHome;
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
		}
		swarmDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-a3-')));
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

	describe('all three promote paths are blocked', () => {
		it('auto promotion skips a prose-only entry and says why', async () => {
			const summary = await checkHivePromotions(
				[proseOnlySwarmEntry()],
				makeConfig(),
				swarmDir,
			);
			expect(summary.new_promotions).toBe(0);
			expect(await readRawHive()).toHaveLength(0);
			expect((summary.diagnostics ?? []).join(' ')).toContain(
				'actionability_floor',
			);
		});

		it('promoteToHive (direct text) is blocked without actionability fields', async () => {
			const msg = await promoteToHive(swarmDir, PROSE_LESSON);
			expect(msg).toContain('Promotion blocked by policy');
			expect(msg).toContain('actionability_floor');
			expect(await readRawHive()).toHaveLength(0);
		});

		it('promoteFromSwarm is blocked for a prose-only source entry', async () => {
			await writeSwarmEntries(swarmDir, [proseOnlySwarmEntry()]);
			const msg = await promoteFromSwarm(swarmDir, 'swarm-prose');
			expect(msg).toContain('Promotion blocked by policy');
			expect(msg).toContain('actionability_floor');
			expect(await readRawHive()).toHaveLength(0);
		});

		it('the hive-fast-track stand-in does NOT bypass the floor', async () => {
			// promoteToHive synthesizes a stand-in tagged 'hive-fast-track' to
			// authorize the eligibility_route gate. That authorization is scoped to
			// that gate only: the direct-text path must still be actionable, so a
			// bare `/swarm promote "<prose>"` cannot self-satisfy the floor.
			const msg = await promoteToHive(swarmDir, PROSE_LESSON);
			expect(msg).toContain('actionability_floor');
			expect(msg).not.toContain('Promoted to hive');
		});
	});

	describe('--force override', () => {
		it('records override_failed_gates=[actionability_floor] durably (direct text)', async () => {
			const msg = await promoteToHive(swarmDir, PROSE_LESSON, undefined, {
				force: true,
				reason: 'legacy prose lesson migrated by an operator',
			});
			expect(msg).toContain('Promoted to hive');

			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].lineage?.actor).toBe('manual-override');
			expect(hive[0].lineage?.override_failed_gates).toEqual([
				'actionability_floor',
			]);

			const overrideEvents = (await readHiveEvents()).filter(
				(e) => e.actor === 'manual-override',
			);
			expect(overrideEvents).toHaveLength(1);
			expect(overrideEvents[0].override_failed_gates).toEqual([
				'actionability_floor',
			]);
		});

		it('records the failed floor gate on the from-swarm path too', async () => {
			await writeSwarmEntries(swarmDir, [proseOnlySwarmEntry()]);
			const msg = await promoteFromSwarm(swarmDir, 'swarm-prose', {
				force: true,
				reason: 'operator accepts this prose lesson',
			});
			expect(msg).toContain('Promoted lesson');
			const hive = await readRawHive();
			expect(hive[0].lineage?.override_failed_gates).toEqual([
				'actionability_floor',
			]);
		});
	});

	describe('promotion_require_actionable=false restores legacy behavior', () => {
		const legacyConfig = makeConfig({ promotion_require_actionable: false });

		it('auto promotion accepts a prose-only entry again', async () => {
			const summary = await checkHivePromotions(
				[proseOnlySwarmEntry()],
				legacyConfig,
				swarmDir,
			);
			expect(summary.new_promotions).toBe(1);
			expect(await readRawHive()).toHaveLength(1);
		});

		it('promoteToHive accepts prose-only text with actor=manual (no override)', async () => {
			const msg = await promoteToHive(
				swarmDir,
				PROSE_LESSON,
				undefined,
				undefined,
				legacyConfig,
			);
			expect(msg).toContain('Promoted to hive');
			const hive = await readRawHive();
			expect(hive[0].lineage?.actor).toBe('manual');
			expect(hive[0].lineage?.override_failed_gates).toBeUndefined();
		});

		it('promoteFromSwarm accepts a prose-only source entry again', async () => {
			await writeSwarmEntries(swarmDir, [proseOnlySwarmEntry()]);
			const msg = await promoteFromSwarm(
				swarmDir,
				'swarm-prose',
				undefined,
				legacyConfig,
			);
			expect(msg).toContain('Promoted lesson');
			expect(await readRawHive()).toHaveLength(1);
		});
	});

	describe('direct-text actionability fields are satisfiable AND persisted', () => {
		// Regression (#1821 A3): the direct-text write path was the ONLY one of
		// the three missing `...carryActionableFields(...)`, so fields that had
		// just satisfied the policy gate were dropped on write and the promoted
		// hive entry came back non-actionable.
		it('promoteToHive persists the supplied predicate + scope', async () => {
			const msg = await promoteToHive(
				swarmDir,
				'Always run the type checker before opening a pull request',
				undefined,
				undefined,
				undefined,
				{
					...ACTIONABLE_FIELDS,
					applies_to_agents: ['coder'],
					forbidden_actions: ['skip the type checker'],
					verification_checks: ['tsc --noEmit'],
				},
			);
			expect(msg).toContain('Promoted to hive');
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].applies_to_tools).toEqual(
				ACTIONABLE_FIELDS.applies_to_tools,
			);
			expect(hive[0].required_actions).toEqual(
				ACTIONABLE_FIELDS.required_actions,
			);
			expect(hive[0].applies_to_agents).toEqual(['coder']);
			expect(hive[0].forbidden_actions).toEqual(['skip the type checker']);
			expect(hive[0].verification_checks).toEqual(['tsc --noEmit']);
			// A satisfied floor is recorded as an ordinary manual promotion — no
			// override audit, which is the whole point of making the path
			// satisfiable rather than forcing everyone through --force.
			expect(hive[0].lineage?.actor).toBe('manual');
		});

		it('normalizes supplied lists: dedupes case-insensitively and caps at 20', async () => {
			const many = Array.from({ length: 30 }, (_, i) => `action-${i}`);
			const msg = await promoteToHive(
				swarmDir,
				'Bound every external subprocess with an explicit timeout value',
				undefined,
				undefined,
				undefined,
				{
					applies_to_tools: ['Write', 'write', 'WRITE'],
					required_actions: many,
				},
			);
			expect(msg).toContain('Promoted to hive');
			const hive = await readRawHive();
			// Case-insensitive dedupe keeps the first occurrence's casing.
			expect(hive[0].applies_to_tools).toEqual(['Write']);
			expect(hive[0].required_actions).toHaveLength(20);
			expect(hive[0].required_actions?.[19]).toBe('action-19');
		});

		it('empty supplied lists are omitted, not persisted as empty arrays', async () => {
			const msg = await promoteToHive(
				swarmDir,
				'Keep the plan ledger authoritative for all plan state changes',
				undefined,
				undefined,
				undefined,
				{ ...ACTIONABLE_FIELDS, forbidden_actions: [] },
			);
			expect(msg).toContain('Promoted to hive');
			const hive = await readRawHive();
			expect(hive[0].forbidden_actions).toBeUndefined();
		});
	});
});
