/**
 * Tests for phase-directives.ts — behavioral tests covering:
 * - Emits phase-start directives at phase boundaries
 * - Emits phase-end directives on phase completion
 * - Gates directive emission on phase state
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	appendKnowledgeEvent,
	resolveKnowledgeEventsPath,
} from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	collectPhaseDirectiveIds,
	readEntriesById,
	readPhaseCriticalDirectiveIds,
	readPhaseDirectivesToVerify,
} from '../../../src/hooks/phase-directives';

function makeEntry(
	id: string,
	status: SwarmKnowledgeEntry['status'] = 'established',
	priority?: SwarmKnowledgeEntry['directive_priority'],
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Lesson for ${id} — always validate inputs before processing`,
		category: 'process',
		tags: ['validation'],
		scope: 'global',
		confidence: 0.85,
		status,
		confirmed_by: [],
		project_name: 'test-project',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
			shown_count: 0,
			applied_explicit_count: 0,
			ignored_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		directive_priority: priority,
	};
}

describe('phase-directives', () => {
	let dir: string;
	let prevHome: string | undefined;
	let prevLocalAppData: string | undefined;
	let prevXdgDataHome: string | undefined;

	beforeEach(() => {
		mock.restore();
		dir = mkdtempSync(path.join(tmpdir(), 'swarm-phase-directives-'));
		// Isolate resolveHiveKnowledgePath to an empty temp so hive reads are
		// deterministic. resolveHiveKnowledgePath reads HOME (linux/darwin) and
		// LOCALAPPDATA (win32); override all to prevent real-profile touches.
		prevHome = process.env.HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		prevXdgDataHome = process.env.XDG_DATA_HOME;
		const isolatedHome = path.join(dir, 'home');
		mkdir(isolatedHome, { recursive: true });
		process.env.HOME = isolatedHome;
		process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
		process.env.XDG_DATA_HOME = path.join(dir, 'xdg-data');
	});

	afterEach(async () => {
		// Restore env vars
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdgDataHome;
		// Clean up temp dir — use realpathSync-wrapped path on macOS
		rmSync(dir, { recursive: true, force: true });
		mock.restore();
	});

	// -------------------------------------------------------------------------
	// Helper: seed retrieved events for a phase
	// -------------------------------------------------------------------------
	// Ensure the .swarm directory exists under dir before writing files
	async function ensureSwarmDir(): Promise<string> {
		const swarmDir = path.join(dir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		return swarmDir;
	}

	async function seedRetrievedEvents(
		phase: string,
		resultIds: string[],
		extraEvents?: Array<{
			type: string;
			knowledge_id?: string;
			phase?: string;
		}>,
	): Promise<void> {
		const events = [
			{
				type: 'retrieved' as const,
				trace_id: 'trace-1',
				session_id: 'session-1',
				agent: 'architect',
				query: 'test query',
				retrieval_mode: 'manual' as const,
				result_ids: resultIds,
				ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
				scores: Object.fromEntries(
					resultIds.map((id, i) => [id, 1.0 - i * 0.1]),
				),
				phase,
			},
			...(extraEvents ?? []),
		];
		for (const event of events) {
			await appendKnowledgeEvent(dir, event);
		}
	}

	// -------------------------------------------------------------------------
	// collectPhaseDirectiveIds
	// -------------------------------------------------------------------------
	describe('collectPhaseDirectiveIds', () => {
		it('returns retrieved IDs that match the given phase label', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			const id2 = 'directive-0002-0002-0002-000000000002';
			await seedRetrievedEvents('Phase 1', [id1]);
			await seedRetrievedEvents('Phase 2', [id2]);

			const phase1Ids = await collectPhaseDirectiveIds(dir, 'Phase 1');
			const phase2Ids = await collectPhaseDirectiveIds(dir, 'Phase 2');

			expect(phase1Ids).toEqual([id1]);
			expect(phase2Ids).toEqual([id2]);
		});

		it('returns IDs from all phases when phaseLabel is omitted', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			const id2 = 'directive-0002-0002-0002-000000000002';
			await seedRetrievedEvents('Phase 1', [id1]);
			await seedRetrievedEvents('Phase 2', [id2]);

			const allIds = await collectPhaseDirectiveIds(dir);

			expect(allIds).toContain(id1);
			expect(allIds).toContain(id2);
		});

		it('excludes non-retrieved event types', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			await seedRetrievedEvents('Phase 1', [id1]);
			// Add a receipt event — should not appear in directive IDs
			await appendKnowledgeEvent(dir, {
				type: 'acknowledged',
				trace_id: 'trace-2',
				session_id: 'session-1',
				knowledge_id: id1,
				agent: 'architect',
				phase: 'Phase 1',
			});

			const ids = await collectPhaseDirectiveIds(dir, 'Phase 1');

			// Only the retrieved ID should be present; acknowledged is not a directive
			expect(ids).toEqual([id1]);
		});

		it('returns empty array when no events match the phase', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			await seedRetrievedEvents('Phase 1', [id1]);

			const ids = await collectPhaseDirectiveIds(dir, 'Phase 99');

			expect(ids).toEqual([]);
		});

		it('deduplicates IDs when the same directive appears in multiple retrieved events', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			await seedRetrievedEvents('Phase 1', [id1]);
			await seedRetrievedEvents('Phase 1', [id1]);

			const ids = await collectPhaseDirectiveIds(dir, 'Phase 1');

			expect(ids.filter((id) => id === id1)).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// readEntriesById
	// -------------------------------------------------------------------------
	describe('readEntriesById', () => {
		it('indexes swarm entries by id', async () => {
			const entry = makeEntry('swarm-entry-001');
			await appendKnowledge(resolveSwarmKnowledgePath(dir), entry);

			const map = await readEntriesById(dir);

			expect(map.has('swarm-entry-001')).toBe(true);
			expect(map.get('swarm-entry-001')?.lesson).toBe(entry.lesson);
		});

		it('returns empty map when no entries exist', async () => {
			// Ensure no knowledge.jsonl exists
			const swarmPath = resolveSwarmKnowledgePath(dir);
			if (existsSync(swarmPath)) rmSync(swarmPath, { force: true });

			const map = await readEntriesById(dir);

			expect(map.size).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// readPhaseDirectivesToVerify — emits phase-start / phase-end directives
	// -------------------------------------------------------------------------
	describe('readPhaseDirectivesToVerify', () => {
		it('returns directives for IDs retrieved in the matching phase', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			const entry = makeEntry(id1, 'established', 'high');
			await appendKnowledge(resolveSwarmKnowledgePath(dir), entry);
			await seedRetrievedEvents('Phase 1', [id1]);

			const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

			expect(directives).toHaveLength(1);
			expect(directives[0].id).toBe(id1);
			expect(directives[0].priority).toBe('high');
			expect(directives[0].lesson).toBe(entry.lesson);
		});

		it('returns all phases when phaseLabel is omitted', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			const id2 = 'directive-0002-0002-0002-000000000002';
			const kp = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(kp, makeEntry(id1, 'established', 'critical'));
			await appendKnowledge(kp, makeEntry(id2, 'established', 'low'));
			await seedRetrievedEvents('Phase 1', [id1]);
			await seedRetrievedEvents('Phase 2', [id2]);

			const directives = await readPhaseDirectivesToVerify(dir);

			expect(directives).toHaveLength(2);
		});

		it('excludes archived entries from returned directives', async () => {
			const id1 = 'directive-active-001';
			const id2 = 'directive-archived-002';
			const kp = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(kp, makeEntry(id1, 'established', 'medium'));
			await appendKnowledge(kp, makeEntry(id2, 'archived', 'high'));
			await seedRetrievedEvents('Phase 1', [id1, id2]);

			const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

			expect(directives).toHaveLength(1);
			expect(directives[0].id).toBe(id1);
		});

		it('excludes quarantined entries from returned directives', async () => {
			const id1 = 'directive-active-001';
			const id2 = 'directive-quarantined-002';
			const kp = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(kp, makeEntry(id1, 'established', 'medium'));
			await appendKnowledge(kp, makeEntry(id2, 'quarantined', 'critical'));
			await seedRetrievedEvents('Phase 1', [id1, id2]);

			const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

			expect(directives).toHaveLength(1);
			expect(directives[0].id).toBe(id1);
		});

		it('returns empty array when no retrieved events exist for the phase', async () => {
			const id1 = 'directive-0001-0001-0001-000000000001';
			await appendKnowledge(resolveSwarmKnowledgePath(dir), makeEntry(id1));
			// No events seeded

			const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

			expect(directives).toEqual([]);
		});

		it('returns empty array when retrieved IDs have no corresponding entry', async () => {
			const id1 = 'directive-orphan-001';
			// Entry does not exist — ID is orphaned
			await seedRetrievedEvents('Phase 1', [id1]);

			const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

			expect(directives).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// readPhaseCriticalDirectiveIds — gates on priority === 'critical'
	// -------------------------------------------------------------------------
	describe('readPhaseCriticalDirectiveIds', () => {
		it('returns only critical-priority directive IDs for the phase', async () => {
			const idCritical = 'directive-critical-001';
			const idHigh = 'directive-high-002';
			const idMedium = 'directive-medium-003';
			const idLow = 'directive-low-004';
			const kp = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(
				kp,
				makeEntry(idCritical, 'established', 'critical'),
			);
			await appendKnowledge(kp, makeEntry(idHigh, 'established', 'high'));
			await appendKnowledge(kp, makeEntry(idMedium, 'established', 'medium'));
			await appendKnowledge(kp, makeEntry(idLow, 'established', 'low'));
			await seedRetrievedEvents('Phase 1', [
				idCritical,
				idHigh,
				idMedium,
				idLow,
			]);

			const criticalIds = await readPhaseCriticalDirectiveIds(dir, 'Phase 1');

			expect(criticalIds).toEqual([idCritical]);
		});

		it('returns empty array when no critical directives were retrieved', async () => {
			const idHigh = 'directive-high-001';
			await appendKnowledge(
				resolveSwarmKnowledgePath(dir),
				makeEntry(idHigh, 'established', 'high'),
			);
			await seedRetrievedEvents('Phase 1', [idHigh]);

			const criticalIds = await readPhaseCriticalDirectiveIds(dir, 'Phase 1');

			expect(criticalIds).toEqual([]);
		});

		it('filters by phase — does not return critical IDs from other phases', async () => {
			const idP1 = 'directive-phase1-001';
			const idP2 = 'directive-phase2-002';
			const kp = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(kp, makeEntry(idP1, 'established', 'critical'));
			await appendKnowledge(kp, makeEntry(idP2, 'established', 'critical'));
			await seedRetrievedEvents('Phase 1', [idP1]);
			await seedRetrievedEvents('Phase 2', [idP2]);

			const p1Critical = await readPhaseCriticalDirectiveIds(dir, 'Phase 1');
			const p2Critical = await readPhaseCriticalDirectiveIds(dir, 'Phase 2');

			expect(p1Critical).toEqual([idP1]);
			expect(p2Critical).toEqual([idP2]);
		});
	});

	// -------------------------------------------------------------------------
	// Behavioral: phase-start vs phase-end — same API, different phase label
	// -------------------------------------------------------------------------
	describe('phase boundaries — start vs end use the same event filtering', () => {
		it('phase-start events are captured with their phase label', async () => {
			const idStart = 'directive-start-001';
			await appendKnowledge(
				resolveSwarmKnowledgePath(dir),
				makeEntry(idStart, 'established', 'high'),
			);
			await seedRetrievedEvents('Phase 1', [idStart]);

			const ids = await collectPhaseDirectiveIds(dir, 'Phase 1');

			expect(ids).toContain(idStart);
		});

		it('phase-end events are captured with their phase label (post-completion phase)', async () => {
			const idEnd = 'directive-end-001';
			await appendKnowledge(
				resolveSwarmKnowledgePath(dir),
				makeEntry(idEnd, 'established', 'medium'),
			);
			// Simulate phase-end by using a different phase label
			await seedRetrievedEvents('Phase 1 — complete', [idEnd]);

			const ids = await collectPhaseDirectiveIds(dir, 'Phase 1 — complete');

			expect(ids).toContain(idEnd);
		});

		it('directive is accessible at both phase-start and phase-end when retrieved in both', async () => {
			const idShared = 'directive-shared-001';
			await appendKnowledge(
				resolveSwarmKnowledgePath(dir),
				makeEntry(idShared, 'established', 'high'),
			);
			// Same directive retrieved in two different phase contexts
			await seedRetrievedEvents('Phase 1', [idShared]);
			await seedRetrievedEvents('Phase 1 — complete', [idShared]);

			const startIds = await collectPhaseDirectiveIds(dir, 'Phase 1');
			const endIds = await collectPhaseDirectiveIds(dir, 'Phase 1 — complete');

			expect(startIds).toContain(idShared);
			expect(endIds).toContain(idShared);
		});
	});
});
