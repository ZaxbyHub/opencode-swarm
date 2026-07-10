/**
 * Issue #1768 — phase re-confirmation tests for confirmEntriesPhase.
 *
 * confirmEntriesPhase is the new batched writer that appends a
 * PhaseConfirmationRecord to each entry's confirmed_by when it is surfaced
 * (retrieved) during a phase. It reuses reinforceSwarmKnowledgeEntry so
 * confidence stays consistent with confirmed_by, dedups same-phase, and caps
 * history at MAX_CONFIRMED_BY (50).
 *
 * Pattern: bun:test, real temp knowledge.jsonl files (transactKnowledge needs
 * real I/O), no mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	confirmEntriesPhase,
	MAX_CONFIRMED_BY,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-confirm-'));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeEntry(
	id: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'proj',
		auto_generated: false,
		phases_alive: 0,
		...overrides,
	};
}

function writeSwarm(entries: SwarmKnowledgeEntry[]): void {
	const fp = resolveSwarmKnowledgePath(tempDir);
	const content =
		entries.map((e) => JSON.stringify(e)).join('\n') +
		(entries.length > 0 ? '\n' : '');
	writeFileSync(fp, content);
}

function readSwarm(): SwarmKnowledgeEntry[] {
	return readFileSync(resolveSwarmKnowledgePath(tempDir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as SwarmKnowledgeEntry);
}

describe('confirmEntriesPhase (#1768)', () => {
	test('appends a PhaseConfirmationRecord and recomputes confidence consistently', async () => {
		writeSwarm([makeEntry('e-1', { confidence: 0.5, confirmed_by: [] })]);
		await confirmEntriesPhase(tempDir, ['e-1'], 2, 'proj');

		const [entry] = readSwarm();
		expect(entry.confirmed_by).toHaveLength(1);
		expect(entry.confirmed_by[0].phase_number).toBe(2);
		// computeConfidence(1 distinct phase, not auto-generated) = 0.5 + 0.1 + 0.1 = 0.7.
		// Confidence MUST be recomputed (not left frozen) — the F2 integrity invariant.
		expect(entry.confidence).toBeCloseTo(0.7, 5);
	});

	test('accumulates across distinct phases (satisfies skill-maturity distinctPhases>=2)', async () => {
		writeSwarm([makeEntry('e-1', { confidence: 0.5, confirmed_by: [] })]);
		await confirmEntriesPhase(tempDir, ['e-1'], 1, 'proj');
		await confirmEntriesPhase(tempDir, ['e-1'], 2, 'proj');

		const [entry] = readSwarm();
		const phases = entry.confirmed_by.map((r) => r.phase_number).sort();
		expect(phases).toEqual([1, 2]);
		// computeConfidence(2 distinct phases) = 0.5 + 0.2 + 0.1 = 0.8.
		expect(entry.confidence).toBeCloseTo(0.8, 5);
	});

	test('dedups same-phase confirmation (no inflation within one phase)', async () => {
		writeSwarm([makeEntry('e-1', { confidence: 0.5, confirmed_by: [] })]);
		await confirmEntriesPhase(tempDir, ['e-1'], 3, 'proj');
		const confidenceAfterFirst = readSwarm()[0].confidence;
		await confirmEntriesPhase(tempDir, ['e-1'], 3, 'proj'); // same phase again

		const [entry] = readSwarm();
		expect(entry.confirmed_by).toHaveLength(1); // still one record
		expect(entry.confirmed_by[0].phase_number).toBe(3);
		expect(entry.confidence).toBe(confidenceAfterFirst); // unchanged
	});

	test('batches multiple ids in one transaction', async () => {
		writeSwarm([
			makeEntry('e-1', { confirmed_by: [] }),
			makeEntry('e-2', { confirmed_by: [] }),
			makeEntry('e-3', { confirmed_by: [] }),
		]);
		await confirmEntriesPhase(tempDir, ['e-1', 'e-2', 'e-3'], 4, 'proj');

		const entries = readSwarm();
		for (const e of entries) {
			expect(e.confirmed_by).toHaveLength(1);
			expect(e.confirmed_by[0].phase_number).toBe(4);
		}
	});

	test('skips inactive entries (does not confirm archived/quarantined)', async () => {
		writeSwarm([
			makeEntry('active', { status: 'established', confirmed_by: [] }),
			makeEntry('archived', { status: 'archived', confirmed_by: [] }),
		]);
		await confirmEntriesPhase(tempDir, ['active', 'archived'], 1, 'proj');

		const byId = new Map(readSwarm().map((e) => [e.id, e]));
		expect(byId.get('active')!.confirmed_by).toHaveLength(1);
		expect(byId.get('archived')!.confirmed_by).toHaveLength(0); // skipped
	});

	test('evicts oldest beyond MAX_CONFIRMED_BY cap', async () => {
		// Pre-seed with MAX_CONFIRMED_BY records across many phases.
		const existing = Array.from({ length: MAX_CONFIRMED_BY }, (_, i) => ({
			phase_number: i + 1,
			confirmed_at: new Date(2026, 0, i + 1).toISOString(),
			project_name: 'proj',
		}));
		writeSwarm([
			makeEntry('e-1', {
				confirmed_by: existing,
				confidence: 1.0,
			}),
		]);
		// Add one more phase beyond the cap.
		await confirmEntriesPhase(tempDir, ['e-1'], MAX_CONFIRMED_BY + 1, 'proj');

		const [entry] = readSwarm();
		expect(entry.confirmed_by.length).toBeLessThanOrEqual(MAX_CONFIRMED_BY);
		// The newest phase (MAX_CONFIRMED_BY + 1) must be retained.
		expect(
			entry.confirmed_by.some((r) => r.phase_number === MAX_CONFIRMED_BY + 1),
		).toBe(true);
	});

	test('no-op for empty ids', async () => {
		writeSwarm([makeEntry('e-1', { confirmed_by: [] })]);
		await confirmEntriesPhase(tempDir, [], 1, 'proj');
		expect(readSwarm()[0].confirmed_by).toHaveLength(0);
	});
});
