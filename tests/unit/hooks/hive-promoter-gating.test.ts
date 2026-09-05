/**
 * Gating tests for the hive promoter hook (issue #2472 W2 / frozen check C3).
 *
 * The promoter hook runs on EVERY tool.execute.after; before W2 it ran a full
 * promotion pass (swarm-store read → cohort git spawn → evidence read → hive
 * transaction → curator-summary read) unconditionally — for read-only tools,
 * empty stores, and back-to-back write bursts alike. These tests pin the three
 * gates added in W2:
 *
 *  1. Tool-class gate — a non-write tool returns before even the swarm-store
 *     read (zero `readSwarmEntries` calls).
 *  2. Empty-candidates gate — an empty store returns before
 *     `resolveCohortId` / `loadPromotionEvidence` / `transactHiveStore` (zero
 *     calls across two write-tool invocations), while the one-time legacy
 *     curator-summary migration stays reachable at most once per directory per
 *     process (critic Round 2 item 1).
 *  3. Cadence floor — two back-to-back qualifying invocations run the
 *     promotion body at most once (`transactHiveStore` ≤ 1); a non-empty store
 *     keeps today's curator-summary ordering (the read still runs after the
 *     promotion body).
 *
 * Instrumentation mirrors the frozen check
 * (.agents/issue-traces/2472-hot-path-stalls-restart-safe/repro/check-c3.ts):
 * the `_internals` seam is swapped in place and restored in `finally`
 * (AGENTS.md invariant 7 — no `mock.module`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	_internals,
	createHivePromoterHook,
} from '../../../src/hooks/hive-promoter.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const real = {
	resolveCohortId: _internals.resolveCohortId,
	loadPromotionEvidence: _internals.loadPromotionEvidence,
	transactHiveStore: _internals.transactHiveStore,
	readSwarmEntries: _internals.readSwarmEntries,
	readCuratorSummary: _internals.readCuratorSummary,
};

const counts = {
	resolveCohortId: 0,
	loadPromotionEvidence: 0,
	transactHiveStore: 0,
	readSwarmEntries: 0,
	readCuratorSummary: 0,
};

function resetCounts(): void {
	for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
		counts[key] = 0;
	}
}

function installSeam(entriesProvider: () => unknown[]): void {
	// The `as any` casts mirror the frozen check's instrumentation style; the
	// repo's biome config does not flag `any` in tests.
	(_internals as unknown as Record<string, unknown>).resolveCohortId =
		async () => {
			counts.resolveCohortId++;
			return { cohortId: 'gating-cohort', source: 'path', degraded: true };
		};
	(_internals as unknown as Record<string, unknown>).loadPromotionEvidence =
		async () => {
			counts.loadPromotionEvidence++;
			return {};
		};
	(_internals as unknown as Record<string, unknown>).transactHiveStore =
		async () => {
			counts.transactHiveStore++;
			return {
				committed: true,
				return: {
					newPromotions: 0,
					encounters: 0,
					advancements: 0,
					total: 0,
				},
				diagnostics: [],
			};
		};
	(_internals as unknown as Record<string, unknown>).readSwarmEntries =
		async () => {
			counts.readSwarmEntries++;
			return entriesProvider();
		};
	(_internals as unknown as Record<string, unknown>).readCuratorSummary =
		async () => {
			counts.readCuratorSummary++;
			return null;
		};
}

function restoreSeam(): void {
	_internals.resolveCohortId = real.resolveCohortId;
	_internals.loadPromotionEvidence = real.loadPromotionEvidence;
	_internals.transactHiveStore = real.transactHiveStore;
	_internals.readSwarmEntries = real.readSwarmEntries;
	_internals.readCuratorSummary = real.readCuratorSummary;
}

/** A minimal ACTIVE swarm entry (mirrors the frozen check's fixture shape). */
function makeActiveEntry(id: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Gating fixture lesson ${id}: applies when running the promoter gating suite.`,
		category: 'process',
		tags: ['hive-fast-track'],
		scope: 'global',
		confidence: 1.0,
		status: 'promoted',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'hive-gating',
	};
}

describe('hive promoter hook gating (#2472 W2 / C3)', () => {
	let dir: string;
	let hook: (input: unknown, output: unknown) => Promise<void>;

	beforeEach(() => {
		dir = canonicalMkdtemp('hive-gating-');
		// Module-level gating state (cadence map + migration guard) survives
		// across test files in Bun's shared runner — start each test clean.
		_internals.resetPromoterGatingState();
		hook = createHivePromoterHook(dir, _internals.loadDefaultKnowledgeConfig());
	});

	afterEach(() => {
		_internals.resetPromoterGatingState();
		rmSync(dir, { recursive: true, force: true });
	});

	it('empty store + write tool ×2 → zero pre-candidate work', async () => {
		try {
			installSeam(() => []);
			resetCounts();
			await hook({ tool: 'write', sessionID: 'gating-empty' }, {});
			await hook({ tool: 'write', sessionID: 'gating-empty' }, {});
			expect(counts.resolveCohortId).toBe(0);
			expect(counts.loadPromotionEvidence).toBe(0);
			expect(counts.transactHiveStore).toBe(0);
		} finally {
			restoreSeam();
		}
	});

	it('non-write tool (read) → no readSwarmEntries call at all', async () => {
		try {
			installSeam(() => [makeActiveEntry('entry-1')]);
			resetCounts();
			await hook({ tool: 'read', sessionID: 'gating-read' }, {});
			expect(counts.readSwarmEntries).toBe(0);
			expect(counts.transactHiveStore).toBe(0);
		} finally {
			restoreSeam();
		}
	});

	it('non-empty store ×2 back-to-back → transactHiveStore runs at most once (cadence floor)', async () => {
		try {
			installSeam(() => [makeActiveEntry('entry-1')]);
			resetCounts();
			await hook({ tool: 'write', sessionID: 'gating-cadence' }, {});
			await hook({ tool: 'write', sessionID: 'gating-cadence' }, {});
			// Exactly 1: the first qualifying invocation MUST run the body, the
			// second MUST be floored (≤ 1 is the frozen C3 Phase B contract).
			expect(counts.transactHiveStore).toBe(1);
		} finally {
			restoreSeam();
		}
	});

	it('curator migration check runs once per directory (first empty call reads, subsequent ones do not)', async () => {
		try {
			installSeam(() => []);
			resetCounts();
			await hook({ tool: 'write', sessionID: 'gating-migration' }, {});
			expect(counts.readCuratorSummary).toBe(1);
			await hook({ tool: 'write', sessionID: 'gating-migration' }, {});
			await hook({ tool: 'write', sessionID: 'gating-migration' }, {});
			expect(counts.readCuratorSummary).toBe(1);
		} finally {
			restoreSeam();
		}
	});

	it('non-empty store keeps today’s curator-summary ordering (read after the promotion body)', async () => {
		try {
			installSeam(() => [makeActiveEntry('entry-1')]);
			resetCounts();
			await hook({ tool: 'write', sessionID: 'gating-ordering' }, {});
			expect(counts.transactHiveStore).toBe(1);
			expect(counts.readCuratorSummary).toBe(1);
		} finally {
			restoreSeam();
		}
	});
});
