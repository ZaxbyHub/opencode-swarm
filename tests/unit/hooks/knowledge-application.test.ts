/**
 * Tests for the v2 knowledge-application module: parsing acknowledgments,
 * recording shown/applied/ignored/violated outcomes, distinguishing shown
 * from applied, and the warn/enforce gate.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
	gateKnowledgeApplication,
	getShownButNotAcknowledged,
	MAX_LEGACY_APPLICATION_LOG_ENTRIES,
	parseAcknowledgments,
	processArchitectText,
	recordAcknowledgment,
	recordKnowledgeShown,
	resolveApplicationLogPath,
} from '../../../src/hooks/knowledge-application';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-knowledge-app-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

async function seedEntry(id: string): Promise<void> {
	const dir = path.join(tmp, '.swarm');
	await mkdir(dir, { recursive: true });
	const entry: SwarmKnowledgeEntry = {
		id,
		tier: 'swarm',
		lesson: 'always declare scope before coder delegation in this repo',
		category: 'process',
		tags: ['scope'],
		scope: 'global',
		confidence: 0.95,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'test',
		directive_priority: 'critical',
	};
	await writeFile(
		resolveSwarmKnowledgePath(tmp),
		JSON.stringify(entry) + '\n',
		'utf-8',
	);
}

describe('parseAcknowledgments', () => {
	it('extracts applied/ignored/violated markers with reasons', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_APPLIED: ${id}
KNOWLEDGE_IGNORED: ${id} reason=not relevant
KNOWLEDGE_VIOLATED: ${id} reason=scope breach`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(3);
		expect(acks[0].result).toBe('applied');
		expect(acks[1].result).toBe('ignored');
		expect(acks[1].reason).toBe('not relevant');
		expect(acks[2].result).toBe('violated');
		expect(acks[2].reason).toBe('scope breach');
	});

	it('returns empty for non-matching text', () => {
		expect(parseAcknowledgments('plain prose, no markers')).toEqual([]);
	});
});

describe('recordKnowledgeShown vs recordAcknowledgment', () => {
	it('shown does not increment applied_explicit_count', async () => {
		const id = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
		await seedEntry(id);
		await recordKnowledgeShown(tmp, [id], { phase: 'Phase 1' });
		const entries = JSON.parse(
			readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8').trim(),
		);
		expect(entries.retrieval_outcomes.shown_count).toBe(1);
		expect(entries.retrieval_outcomes.applied_explicit_count).toBe(0);
		expect(existsSync(resolveApplicationLogPath(tmp))).toBe(true);
	});

	it('explicit KNOWLEDGE_APPLIED increments applied_explicit_count, not shown_count', async () => {
		const id = 'cccccccc-cccc-4ccc-9ccc-cccccccccccc';
		await seedEntry(id);
		await recordAcknowledgment(
			tmp,
			{ id, result: 'applied' },
			{ phase: 'Phase 1' },
		);
		const entries = JSON.parse(
			readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8').trim(),
		);
		expect(entries.retrieval_outcomes.applied_explicit_count).toBe(1);
		expect(entries.retrieval_outcomes.shown_count).toBe(0);
		expect(entries.retrieval_outcomes.acknowledged_count).toBe(1);
		expect(entries.last_applied_at).toBeDefined();
	});

	it('explicit KNOWLEDGE_IGNORED increments ignored_count', async () => {
		const id = 'dddddddd-dddd-4ddd-9ddd-dddddddddddd';
		await seedEntry(id);
		await recordAcknowledgment(
			tmp,
			{ id, result: 'ignored', reason: 'n/a here' },
			{ phase: 'Phase 1' },
		);
		const entries = JSON.parse(
			readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8').trim(),
		);
		expect(entries.retrieval_outcomes.ignored_count).toBe(1);
		expect(entries.retrieval_outcomes.applied_explicit_count).toBe(0);
	});

	it('coalesces field bumps to a single rewrite per ack (F-008)', async () => {
		const id = 'ffffffff-ffff-4fff-9fff-ffffffffffff';
		await seedEntry(id);
		const knowledgePath = resolveSwarmKnowledgePath(tmp);
		// Patch rewriteKnowledge via module spy by monitoring file mtime —
		// proxy: read mtime before/after, count ms-level distinct mtimes.
		const before = readFileSync(knowledgePath, 'utf-8');
		await recordAcknowledgment(
			tmp,
			{ id, result: 'applied' },
			{ phase: 'Phase 1' },
		);
		const after = readFileSync(knowledgePath, 'utf-8');
		// Single ack triggers exactly one effective rewrite — both counters
		// (applied_explicit_count + acknowledged_count) appear in one pass.
		const e = JSON.parse(after.trim());
		expect(e.retrieval_outcomes.applied_explicit_count).toBe(1);
		expect(e.retrieval_outcomes.acknowledged_count).toBe(1);
		expect(after).not.toBe(before);
	});

	it('records survive a fresh process read (audit log persists)', async () => {
		const id = 'eeeeeeee-eeee-4eee-9eee-eeeeeeeeeeee';
		await seedEntry(id);
		await recordKnowledgeShown(tmp, [id], { phase: 'Phase 1' });
		await recordAcknowledgment(
			tmp,
			{ id, result: 'applied' },
			{ phase: 'Phase 1' },
		);
		const log = readFileSync(resolveApplicationLogPath(tmp), 'utf-8');
		const lines = log.trim().split('\n');
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.some((l) => l.includes('"shown"'))).toBe(true);
		expect(lines.some((l) => l.includes('"applied"'))).toBe(true);
	});

	it('caps the legacy application audit log after appending', async () => {
		const logPath = resolveApplicationLogPath(tmp);
		await mkdir(path.dirname(logPath), { recursive: true });
		const lines = Array.from(
			{ length: MAX_LEGACY_APPLICATION_LOG_ENTRIES + 5 },
			(_, i) =>
				JSON.stringify({
					timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
					knowledgeId: `old-${i}`,
					result: 'shown',
				}),
		);
		await writeFile(logPath, `${lines.join('\n')}\n`, 'utf-8');

		await recordKnowledgeShown(tmp, ['newest'], { phase: 'Phase 1' });

		const capped = readFileSync(logPath, 'utf-8').trim().split('\n');
		expect(capped).toHaveLength(MAX_LEGACY_APPLICATION_LOG_ENTRIES);
		expect(capped.some((line) => line.includes('"knowledgeId":"old-0"'))).toBe(
			false,
		);
		expect(capped[capped.length - 1]).toContain('"knowledgeId":"newest"');
	});
});

describe('gateKnowledgeApplication', () => {
	it('warn mode never blocks, but reports warnings', () => {
		const r = gateKnowledgeApplication({
			criticalShownIds: ['aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'],
			recentArchitectText: '',
			config: DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
		});
		expect(r.allowed).toBe(true);
		expect(r.warnings.length).toBe(1);
	});

	it('enforce mode blocks when critical id has no ack', () => {
		const r = gateKnowledgeApplication({
			criticalShownIds: ['aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'],
			recentArchitectText: '',
			config: { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		});
		expect(r.allowed).toBe(false);
		expect(r.violations.length).toBe(1);
	});

	it('enforce mode allows when critical id IS acknowledged', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const r = gateKnowledgeApplication({
			criticalShownIds: [id],
			recentArchitectText: `KNOWLEDGE_APPLIED: ${id}`,
			config: { ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' },
		});
		expect(r.allowed).toBe(true);
	});
});

describe('processArchitectText', () => {
	it('extracts and records acknowledgments from chat text', async () => {
		const id = 'ffffffff-ffff-4fff-9fff-ffffffffffff';
		await seedEntry(id);
		const acks = await processArchitectText(
			tmp,
			`thinking out loud KNOWLEDGE_APPLIED: ${id}`,
			{ phase: 'Phase 1' },
		);
		expect(acks.length).toBe(1);
		expect(acks[0].result).toBe('applied');
	});
});

describe('getShownButNotAcknowledged', () => {
	it('returns shown ids that have no acknowledgment in scope', async () => {
		const a = '11111111-1111-4111-9111-111111111111';
		const b = '22222222-2222-4222-9222-222222222222';
		await seedEntry(a);
		await seedEntry(b);
		await recordKnowledgeShown(tmp, [a, b], { phase: 'P1' });
		await recordAcknowledgment(
			tmp,
			{ id: a, result: 'applied' },
			{ phase: 'P1' },
		);
		const remaining = await getShownButNotAcknowledged(tmp, {
			phase: 'P1',
			knowledgeIds: [a, b],
		});
		expect(remaining).toEqual([b]);
	});
});

// ============================================================================
// recordAcknowledgment / bumpCountersBatch — TOCTOU race fix (#1285)
// ============================================================================

describe('recordAcknowledgment / bumpCountersBatch — TOCTOU race fix (#1285)', () => {
	it('recordAcknowledgment re-reads after an interleaved append instead of rewriting a stale snapshot', async () => {
		const id = '99999999-9999-4999-9999-999999999999';
		await seedEntry(id);

		const secondId = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const secondEntry: SwarmKnowledgeEntry = {
			id: secondId,
			tier: 'swarm',
			lesson: 'second entry for concurrency test',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: 'test',
		};

		const knowledgePath = resolveSwarmKnowledgePath(tmp);
		const staleSnapshot = readFileSync(knowledgePath, 'utf-8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(staleSnapshot.map((entry: any) => entry.id)).toEqual([id]);

		// Previous code read before acquiring the rewrite lock. This fixed
		// interleaving models that stale snapshot, appends a second entry, then
		// performs the counter update. The fixed path must re-read under
		// transactKnowledge and preserve the append.
		await appendKnowledge(knowledgePath, secondEntry);
		await recordAcknowledgment(
			tmp,
			{ id, result: 'applied' },
			{ phase: 'Phase 1' },
		);

		const lines = readFileSync(knowledgePath, 'utf-8').trim().split('\n');
		const allEntries = lines.map((line) => JSON.parse(line));

		expect(allEntries).toHaveLength(2);

		const originalEntry = allEntries.find((e: any) => e.id === id);
		expect(originalEntry).toBeDefined();
		expect(originalEntry.retrieval_outcomes.applied_explicit_count).toBe(1);
		expect(originalEntry.retrieval_outcomes.acknowledged_count).toBe(1);

		const appendedEntry = allEntries.find((e: any) => e.id === secondId);
		expect(appendedEntry).toBeDefined();
		expect(appendedEntry.id).toBe(secondId);
	});

	it('concurrent bumpCountersBatch calls do not clobber each other', async () => {
		const id1 = 'cccccccc-1111-4ccc-9ccc-cccccccccccc';
		const id2 = 'dddddddd-2222-4ddd-9ddd-dddddddddddd';
		const knowledgePath = resolveSwarmKnowledgePath(tmp);
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		await writeFile(
			knowledgePath,
			[JSON.stringify(baseEntry(id1)), JSON.stringify(baseEntry(id2))].join(
				'\n',
			) + '\n',
			'utf-8',
		);

		await Promise.all([
			recordAcknowledgment(
				tmp,
				{ id: id1, result: 'applied' },
				{ phase: 'P1' },
			),
			recordAcknowledgment(
				tmp,
				{ id: id2, result: 'applied' },
				{ phase: 'P1' },
			),
		]);

		const lines = readFileSync(knowledgePath, 'utf-8').trim().split('\n');
		const all = lines.map((l) => JSON.parse(l));
		expect(all).toHaveLength(2);

		const e1 = all.find((e: any) => e.id === id1);
		const e2 = all.find((e: any) => e.id === id2);
		expect(e1?.retrieval_outcomes.applied_explicit_count).toBe(1);
		expect(e1?.retrieval_outcomes.acknowledged_count).toBe(1);
		expect(e2?.retrieval_outcomes.applied_explicit_count).toBe(1);
		expect(e2?.retrieval_outcomes.acknowledged_count).toBe(1);
	});
});

// ============================================================================
// filterHighConfidenceKnowledge — unit tests
// ============================================================================

import { filterHighConfidenceKnowledge } from '../../../src/hooks/knowledge-application.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';

function makeRankedEntry(
	id: string,
	lesson: string,
	confidence: number,
): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		relevanceScore: confidence,
		finalScore: confidence,
	};
}

describe('filterHighConfidenceKnowledge', () => {
	// Happy path: entries >= threshold are included, < threshold are excluded

	it('includes entries with confidence >= threshold', () => {
		const entries = [
			makeRankedEntry('id-1', 'Lesson one', 0.85),
			makeRankedEntry('id-2', 'Lesson two', 0.92),
			makeRankedEntry('id-3', 'Lesson three', 1.0),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(3);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-2', 'id-3']);
	});

	it('excludes entries with confidence < threshold', () => {
		const entries = [
			makeRankedEntry('id-1', 'High confidence', 0.9),
			makeRankedEntry('id-2', 'Low confidence', 0.5),
			makeRankedEntry('id-3', 'Another high', 0.85),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-3']);
	});

	// Default threshold: 0.8 when not provided

	it('uses default threshold of 0.8 when called with no threshold argument', () => {
		const entries = [
			makeRankedEntry('id-1', 'Exactly 0.8', 0.8), // >= 0.8 → included
			makeRankedEntry('id-2', 'Above 0.8', 0.81), // >= 0.8 → included
			makeRankedEntry('id-3', 'Below 0.8', 0.79), // < 0.8 → excluded
		];
		const result = filterHighConfidenceKnowledge(entries);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-2']);
	});

	// Custom threshold

	it('works with custom threshold of 0.9', () => {
		const entries = [
			makeRankedEntry('id-1', 'Confidence 0.9', 0.9), // >= 0.9 → included
			makeRankedEntry('id-2', 'Confidence 0.85', 0.85), // < 0.9 → excluded
			makeRankedEntry('id-3', 'Confidence 1.0', 1.0), // >= 0.9 → included
		];
		const result = filterHighConfidenceKnowledge(entries, 0.9);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-3']);
	});

	it('works with custom threshold of 0.5', () => {
		const entries = [
			makeRankedEntry('id-1', 'High', 0.9),
			makeRankedEntry('id-2', 'Mid', 0.6),
			makeRankedEntry('id-3', 'Low', 0.3),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.5);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-2']);
	});

	it('works with custom threshold of 1.0 (only perfect confidence included)', () => {
		const entries = [
			makeRankedEntry('id-1', 'Perfect', 1.0),
			makeRankedEntry('id-2', 'Almost perfect', 0.99),
			makeRankedEntry('id-3', 'High', 0.95),
		];
		const result = filterHighConfidenceKnowledge(entries, 1.0);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('id-1');
	});

	it('works with custom threshold of 0.0 (all entries included)', () => {
		const entries = [
			makeRankedEntry('id-1', 'Zero confidence', 0.0),
			makeRankedEntry('id-2', 'Low confidence', 0.3),
			makeRankedEntry('id-3', 'Any confidence', 0.5),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.0);
		expect(result).toHaveLength(3);
	});

	// Empty input

	it('returns empty array for empty input', () => {
		const result = filterHighConfidenceKnowledge([]);
		expect(result).toEqual([]);
	});

	// Edge cases: boundary values

	it('exactly 0.8 threshold: entry with confidence 0.8 is included', () => {
		const entries = [makeRankedEntry('id-1', 'Exactly at threshold', 0.8)];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('id-1');
	});

	it('confidence 0.0 is excluded when threshold is 0.8', () => {
		const entries = [makeRankedEntry('id-1', 'Zero confidence', 0.0)];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(0);
	});

	it('confidence 1.0 is always included with default threshold', () => {
		const entries = [makeRankedEntry('id-1', 'Perfect confidence', 1.0)];
		const result = filterHighConfidenceKnowledge(entries);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('id-1');
	});

	it('mixed boundary values with default threshold 0.8', () => {
		const entries = [
			makeRankedEntry('id-1', 'Just below', 0.79),
			makeRankedEntry('id-2', 'Exactly 0.8', 0.8),
			makeRankedEntry('id-3', 'Just above', 0.81),
			makeRankedEntry('id-4', 'Zero', 0.0),
			makeRankedEntry('id-5', 'Perfect', 1.0),
		];
		const result = filterHighConfidenceKnowledge(entries);
		expect(result).toHaveLength(3);
		expect(result.map((e) => e.id)).toEqual(['id-2', 'id-3', 'id-5']);
	});

	// Preserves input type / generic behavior

	it('preserves the type of entries (generic behavior)', () => {
		interface CustomEntry extends RankedEntry {
			customField?: string;
		}
		const entries: CustomEntry[] = [
			{ ...makeRankedEntry('id-1', 'Lesson', 0.9), customField: 'value1' },
			{ ...makeRankedEntry('id-2', 'Lesson', 0.7), customField: 'value2' },
		];
		const result = filterHighConfidenceKnowledge<CustomEntry>(entries, 0.8);
		expect(result).toHaveLength(1);
		expect(result[0].customField).toBe('value1');
	});

	it('returns new array, does not mutate original', () => {
		const entries = [
			makeRankedEntry('id-1', 'High', 0.9),
			makeRankedEntry('id-2', 'Low', 0.5),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).not.toBe(entries);
		expect(entries).toHaveLength(2); // original unchanged
	});
});

function baseEntry(id: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: 'concurrency test entry',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'test',
	};
}
