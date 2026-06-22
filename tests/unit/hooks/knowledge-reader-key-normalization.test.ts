/**
 * Tests for the Phase N key normalization fix in src/hooks/knowledge-reader.ts
 *
 * Bug fixed: recordLessonsShown stored lessons under the verbose key
 * 'Phase 1: Setup [IN PROGRESS]' (from extractCurrentPhaseFromPlan) while
 * updateRetrievalOutcome looked up 'Phase 1'. Keys never matched → applied_count
 * was never incremented.
 *
 * Fix: normalize at write time using /^Phase\s+(\d+)/i to produce 'Phase N'.
 *
 * Covers:
 * 1. Verbose phase string → normalized to 'Phase N'
 * 2. Simple 'Phase N' string → kept as-is
 * 3. 'Phase N: Description [STATUS]' → normalized
 * 4. Non-phase strings → stored verbatim (fallback)
 * 5. updateRetrievalOutcome can find entries recorded under normalized key
 * 6. Case-insensitive match ('phase 3: something' → 'Phase 3')
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../../src/hooks/knowledge-store.js', () => {
	const readKnowledge = vi.fn(async () => []);
	return {
		jaccardBigram: vi.fn((a: Set<string>, b: Set<string>) => {
			if (a.size === 0 && b.size === 0) return 1.0;
			const intersection = new Set(Array.from(a).filter((x) => b.has(x)));
			const union = new Set([...Array.from(a), ...Array.from(b)]);
			return intersection.size / union.size;
		}),
		normalize: vi.fn((text: string) =>
			text
				.toLowerCase()
				.replace(/[^\w\s]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim(),
		),
		readKnowledge,
		readRetractionRecords: vi.fn(async () => []),
		rewriteKnowledge: vi.fn(async () => {}),
		transactFile: vi.fn(async () => true),
		transactKnowledge: vi.fn(
			async <T>(filePath: string, mutate: (entries: T[]) => T[] | null) => {
				// Apply mutation to entries read via readKnowledge mock
				const entries = await readKnowledge(filePath);
				const result = mutate(entries as T[]);
				return result !== null;
			},
		),
		resolveSwarmKnowledgePath: vi.fn(() => '/mock/.swarm/knowledge.jsonl'),
		resolveHiveKnowledgePath: vi.fn(() => '/mock/hive/shared-learnings.jsonl'),
		wordBigrams: vi.fn((text: string) => {
			const words = text
				.toLowerCase()
				.replace(/[^\w\s]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.split(' ')
				.filter(Boolean);
			const bigrams = new Set<string>();
			for (let i = 0; i < words.length - 1; i++) {
				bigrams.add(`${words[i]} ${words[i + 1]}`);
			}
			return bigrams;
		}),
		enforceKnowledgeCap: async () => {},
		sweepAgedEntries: async () => {},
		sweepStaleTodos: async () => {},
		bumpKnowledgeConfidenceBatch: async () => {},
	};
});

import { updateRetrievalOutcome } from '../../../src/hooks/knowledge-reader.js';

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string;
let shownFile: string;

beforeEach(() => {
	tmpDir = path.join(
		os.tmpdir(),
		`key-norm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	shownFile = path.join(tmpDir, '.swarm', '.knowledge-shown.json');
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// Helper to write a .knowledge-shown.json with a given key mapping
function writeShownFile(data: Record<string, string[]>) {
	fs.writeFileSync(shownFile, JSON.stringify(data), 'utf-8');
}

function readShownFile(): Record<string, string[]> {
	if (!fs.existsSync(shownFile)) return {};
	return JSON.parse(fs.readFileSync(shownFile, 'utf-8'));
}

// Read the 'outcome' events updateRetrievalOutcome appended to the real temp
// .swarm event log (issue #1477: outcome attribution is event-sourced).
interface OutcomeEventLine {
	type: string;
	knowledge_id?: string;
	outcome?: string;
	phase?: string;
	evidence_summary?: string;
}
function readOutcomeEvents(): OutcomeEventLine[] {
	const eventsFile = path.join(tmpDir, '.swarm', 'knowledge-events.jsonl');
	if (!fs.existsSync(eventsFile)) return [];
	return fs
		.readFileSync(eventsFile, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as OutcomeEventLine)
		.filter((e) => e.type === 'outcome');
}

// ============================================================================
// Tests for updateRetrievalOutcome with canonical Phase N keys
// ============================================================================

describe('updateRetrievalOutcome — Phase N key lookup', () => {
	it('finds ids stored under canonical "Phase N" key and emits an outcome event', async () => {
		// Simulate what the fixed recordLessonsShown writes: canonical 'Phase 1'
		const lessonId = 'lesson-abc-123';
		writeShownFile({ 'Phase 1': [lessonId] });

		await updateRetrievalOutcome(tmpDir, 'Phase 1', true);

		// Issue #1477: attribution is now an immutable 'outcome' event keyed by
		// knowledge_id, not an in-place entry mutation.
		const events = readOutcomeEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'outcome',
			knowledge_id: lessonId,
			outcome: 'success',
			phase: 'Phase 1',
		});
	});

	it('emits a success outcome event with non-empty evidence when the phase succeeded', async () => {
		const id = 'lesson-xyz';
		writeShownFile({ 'Phase 2': [id] });

		await updateRetrievalOutcome(tmpDir, 'Phase 2', true);

		const events = readOutcomeEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'outcome',
			knowledge_id: id,
			outcome: 'success',
		});
		expect(typeof events[0].evidence_summary).toBe('string');
		expect((events[0].evidence_summary ?? '').length).toBeGreaterThan(0);
	});

	it('emits a failure outcome event when the phase failed', async () => {
		const id = 'lesson-fail';
		writeShownFile({ 'Phase 3': [id] });

		await updateRetrievalOutcome(tmpDir, 'Phase 3', false);

		const events = readOutcomeEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'outcome',
			knowledge_id: id,
			outcome: 'failure',
			phase: 'Phase 3',
		});
	});

	it('emits one event per shown id for the phase', async () => {
		writeShownFile({ 'Phase 4': ['a', 'b', 'c'] });

		await updateRetrievalOutcome(tmpDir, 'Phase 4', true);

		const ids = readOutcomeEvents()
			.map((e) => e.knowledge_id)
			.sort();
		expect(ids).toEqual(['a', 'b', 'c']);
	});

	it('does nothing when no lessons were shown for the given phase', async () => {
		writeShownFile({ 'Phase 1': ['some-other-id'] });

		await updateRetrievalOutcome(tmpDir, 'Phase 2', true);

		// No ids shown for Phase 2 → no outcome event emitted.
		expect(readOutcomeEvents()).toHaveLength(0);
	});

	it('does nothing when .knowledge-shown.json does not exist', async () => {
		// No file written
		await updateRetrievalOutcome(tmpDir, 'Phase 1', true);

		expect(readOutcomeEvents()).toHaveLength(0);
	});
});

// ============================================================================
// Direct test of canonical key normalization logic
// ============================================================================

describe('Canonical Phase N key format expectations', () => {
	// These tests verify the normalization regex behavior directly, as it is
	// the core fix for the key mismatch bug.

	const normalizePhaseKey = (phase: string): string => {
		const match = /^Phase\s+(\d+)/i.exec(phase);
		return match ? `Phase ${match[1]}` : phase;
	};

	it('verbose "Phase 1: Setup [IN PROGRESS]" → "Phase 1"', () => {
		expect(normalizePhaseKey('Phase 1: Setup [IN PROGRESS]')).toBe('Phase 1');
	});

	it('plain "Phase 1" → "Phase 1" (no-op)', () => {
		expect(normalizePhaseKey('Phase 1')).toBe('Phase 1');
	});

	it('"Phase 3: Implementation" → "Phase 3"', () => {
		expect(normalizePhaseKey('Phase 3: Implementation')).toBe('Phase 3');
	});

	it('"phase 2: something" (lowercase) → "Phase 2" (case-insensitive match)', () => {
		expect(normalizePhaseKey('phase 2: something')).toBe('Phase 2');
	});

	it('"Phase 10: Long running phase" → "Phase 10" (multi-digit)', () => {
		expect(normalizePhaseKey('Phase 10: Long running phase')).toBe('Phase 10');
	});

	it('"Deployment" (non-phase string) → "Deployment" (verbatim fallback)', () => {
		expect(normalizePhaseKey('Deployment')).toBe('Deployment');
	});

	it('"Phase 0" → "Phase 0"', () => {
		expect(normalizePhaseKey('Phase 0')).toBe('Phase 0');
	});
});
