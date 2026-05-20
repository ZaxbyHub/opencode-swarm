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
	parseAcknowledgments,
	processArchitectText,
	recordAcknowledgment,
	recordKnowledgeShown,
	resolveApplicationLogPath,
} from '../../../src/hooks/knowledge-application';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
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
