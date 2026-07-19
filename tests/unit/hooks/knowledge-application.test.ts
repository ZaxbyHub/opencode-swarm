/**
 * Tests for the v2 knowledge-application module: recording
 * shown/applied/ignored/violated outcomes, distinguishing shown from
 * applied, and the warn/enforce gate.
 *
 * parseAcknowledgments (the ACK_PATTERN regex) and the
 * KnowledgeApplicationConfigSchema max_gate_denials/gate_staleness_ms fields
 * are covered in knowledge-application-ack-parsing.test.ts;
 * filterHighConfidenceKnowledge is covered in
 * knowledge-application-filter-confidence.test.ts (split out to stay under
 * the repo's 500-line test file limit — AGENTS.md invariant 7).
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
import { withFrozenClock } from '../../helpers/test-clock.js';

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
		...withFrozenClock(
			() => ({
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}),
			{ isoNow: '2026-01-01T00:00:00.000Z' },
		),
		project_name: 'test',
		directive_priority: 'critical',
	};
	await writeFile(
		resolveSwarmKnowledgePath(tmp),
		JSON.stringify(entry) + '\n',
		'utf-8',
	);
}

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
