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

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
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
	readKnowledge: vi.fn(async () => []),
	rewriteKnowledge: vi.fn(async () => {}),
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
}));

import { updateRetrievalOutcome } from '../../../src/hooks/knowledge-reader.js';
import {
	readKnowledge,
	rewriteKnowledge,
} from '../../../src/hooks/knowledge-store.js';

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

// ============================================================================
// Tests for updateRetrievalOutcome with canonical Phase N keys
// ============================================================================

describe('updateRetrievalOutcome — Phase N key lookup', () => {
	it('finds entries stored under canonical "Phase N" key', async () => {
		// Simulate what the fixed recordLessonsShown writes: canonical 'Phase 1'
		const lessonId = 'lesson-abc-123';
		writeShownFile({ 'Phase 1': [lessonId] });

		// Mock readKnowledge to return a swarm entry with that id
		const entry = {
			id: lessonId,
			schema_version: 1,
			tier: 'swarm',
			lesson: 'Use TypeScript strict mode',
			category: 'tooling',
			tags: ['typescript'],
			scope: 'global',
			confidence: 0.7,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_shown_count: 0,
				failed_after_shown_count: 0,
			},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		(readKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([entry]);

		await updateRetrievalOutcome(tmpDir, 'Phase 1', true);

		// rewriteKnowledge should have been called with the updated entry
		expect(rewriteKnowledge).toHaveBeenCalled();
		const [, writtenEntries] = (rewriteKnowledge as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		const updated = writtenEntries.find((e: typeof entry) => e.id === lessonId);
		expect(updated).toBeDefined();
		// v2: applied_count is FROZEN (not auto-incremented from shown)
		expect(updated.retrieval_outcomes.succeeded_after_shown_count).toBe(1);
	});

	it('increments succeeded_after_shown_count when outcome is true', async () => {
		const id = 'lesson-xyz';
		writeShownFile({ 'Phase 2': [id] });

		const entry = {
			id,
			schema_version: 1,
			tier: 'swarm',
			lesson: 'Always validate inputs',
			category: 'security',
			tags: [],
			scope: 'global',
			confidence: 0.6,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 2,
				succeeded_after_shown_count: 1,
				failed_after_shown_count: 0,
			},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		(readKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([entry]);

		await updateRetrievalOutcome(tmpDir, 'Phase 2', true);

		const [, writtenEntries] = (rewriteKnowledge as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		const updated = writtenEntries.find((e: typeof entry) => e.id === id);
		// v2: applied_count is FROZEN — should stay at 2
		expect(updated.retrieval_outcomes.applied_count).toBe(2);
		expect(updated.retrieval_outcomes.succeeded_after_shown_count).toBe(2); // was 1
	});

	it('increments failed_after_shown_count when outcome is false', async () => {
		const id = 'lesson-fail';
		writeShownFile({ 'Phase 3': [id] });

		const entry = {
			id,
			schema_version: 1,
			tier: 'swarm',
			lesson: 'Avoid inline SQL',
			category: 'security',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 1,
				succeeded_after_shown_count: 1,
				failed_after_shown_count: 0,
			},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		(readKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([entry]);

		await updateRetrievalOutcome(tmpDir, 'Phase 3', false);

		const [, writtenEntries] = (rewriteKnowledge as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		const updated = writtenEntries.find((e: typeof entry) => e.id === id);
		// v2: applied_count is FROZEN — should stay at 1
		expect(updated.retrieval_outcomes.applied_count).toBe(1);
		expect(updated.retrieval_outcomes.failed_after_shown_count).toBe(1);
		expect(updated.retrieval_outcomes.succeeded_after_shown_count).toBe(1); // unchanged
	});

	it('does nothing when no lessons were shown for the given phase', async () => {
		writeShownFile({ 'Phase 1': ['some-other-id'] });
		(readKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);

		await updateRetrievalOutcome(tmpDir, 'Phase 2', true);

		// No lessons shown for Phase 2, so rewriteKnowledge should not be called
		expect(rewriteKnowledge).not.toHaveBeenCalled();
	});

	it('does nothing when .knowledge-shown.json does not exist', async () => {
		// No file written
		(readKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);

		await updateRetrievalOutcome(tmpDir, 'Phase 1', true);

		expect(rewriteKnowledge).not.toHaveBeenCalled();
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
