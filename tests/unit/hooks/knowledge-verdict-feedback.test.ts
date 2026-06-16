/**
 * Unit tests for applyKnowledgeVerdictFeedback (knowledge-events.ts).
 *
 * Verifies that receipt events (applied/violated/ignored) are aggregated
 * per knowledge entry and translated into bounded confidence deltas via
 * bumpKnowledgeConfidenceBatch.
 *
 * Covers: WP6-B (issue #1234).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyKnowledgeVerdictFeedback } from '../../../src/hooks/knowledge-events.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'verdict-feedback-test-'));
}

/** Resolve the knowledge-events JSONL path for a project directory. */
function eventsPath(dir: string): string {
	return join(dir, '.swarm', 'knowledge-events.jsonl');
}

/** Ensure .swarm/ exists and return the events file path. */
function ensureSwarmDir(dir: string): string {
	const p = eventsPath(dir);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return p;
}

/** Build a single receipt event line (JSON string). */
function makeReceiptEvent(overrides: {
	type: string;
	knowledge_id: string;
	timestamp?: string;
}): string {
	return JSON.stringify({
		type: overrides.type,
		event_id: randomUUID(),
		trace_id: randomUUID(),
		knowledge_id: overrides.knowledge_id,
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		session_id: 'test-session',
		agent: 'test-agent',
	});
}

/** Write receipt events as JSONL lines to the knowledge-events file. */
function writeEvents(
	dir: string,
	events: Array<{
		type: string;
		knowledge_id: string;
		timestamp?: string;
	}>,
): void {
	const fp = ensureSwarmDir(dir);
	const content = events.map((e) => makeReceiptEvent(e)).join('\n') + '\n';
	writeFileSync(fp, content, 'utf-8');
}

/** Write knowledge entries to .swarm/knowledge.jsonl. */
function writeKnowledgeEntries(
	dir: string,
	entries: Array<{
		id: string;
		lesson: string;
		confidence: number;
		category?: string;
		status?: string;
	}>,
): void {
	const fp = resolveSwarmKnowledgePath(dir);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	const content =
		entries
			.map((e) =>
				JSON.stringify({
					id: e.id,
					lesson: e.lesson,
					category: e.category ?? 'lesson',
					status: e.status ?? 'active',
					confidence: e.confidence,
					tags: [],
					scope: 'global',
					confirmed_by: [],
					project_name: 'test',
				}),
			)
			.join('\n') + '\n';
	writeFileSync(fp, content, 'utf-8');
}

/** Read knowledge entries back and return them indexed by id. */
async function readKnowledgeById(
	dir: string,
): Promise<
	Map<string, { id: string; confidence: number; [k: string]: unknown }>
> {
	const fp = resolveSwarmKnowledgePath(dir);
	const entries = await readKnowledge<{
		id: string;
		confidence: number;
		[k: string]: unknown;
	}>(fp);
	return new Map(entries.map((e) => [e.id, e]));
}

// ============================================================================
// Tests
// ============================================================================

describe('applyKnowledgeVerdictFeedback', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// --------------------------------------------------------------------------
	// 1. Returns empty when no events exist
	// --------------------------------------------------------------------------
	test('returns { processed: 0, bumps: 0 } when no events file exists', async () => {
		// Empty directory — no .swarm/ at all
		const result = await applyKnowledgeVerdictFeedback(dir);

		expect(result.processed).toBe(0);
		expect(result.bumps).toBe(0);
	});

	// --------------------------------------------------------------------------
	// 2. Boosts confidence when applied > violated+ignored
	// --------------------------------------------------------------------------
	test('boosts confidence (+0.03) when applied count exceeds violated+ignored', async () => {
		const kid = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kid, lesson: 'always run tests before commit', confidence: 0.5 },
		]);

		// 3 applied, 1 violated → applied (3) > violated+ignored (1) → boost
		writeEvents(dir, [
			{ type: 'applied', knowledge_id: kid },
			{ type: 'applied', knowledge_id: kid },
			{ type: 'applied', knowledge_id: kid },
			{ type: 'violated', knowledge_id: kid },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const entries = await readKnowledgeById(dir);
		expect(entries.get(kid)!.confidence).toBeCloseTo(0.53); // 0.5 + 0.03
	});

	// --------------------------------------------------------------------------
	// 3. Decays confidence when violated+ignored >= applied
	// --------------------------------------------------------------------------
	test('decays confidence (-0.05) when violated+ignored exceeds applied', async () => {
		const kid = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kid, lesson: 'use strict mode everywhere', confidence: 0.5 },
		]);

		// 2 violated, 1 applied → violated+ignored (2) >= applied (1) → decay
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: kid },
			{ type: 'violated', knowledge_id: kid },
			{ type: 'applied', knowledge_id: kid },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const entries = await readKnowledgeById(dir);
		expect(entries.get(kid)!.confidence).toBeCloseTo(0.45); // 0.5 - 0.05
	});

	// --------------------------------------------------------------------------
	// 4. Respects sinceTimestamp filter
	// --------------------------------------------------------------------------
	test('sinceTimestamp filters out old events', async () => {
		const kid = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kid, lesson: 'handle errors gracefully', confidence: 0.5 },
		]);

		const oldTimestamp = '2025-01-01T00:00:00.000Z';
		const newTimestamp = '2026-06-01T00:00:00.000Z';
		const cutoff = '2026-01-01T00:00:00.000Z';

		// Old events: 3 violated (would cause decay if counted)
		// New events: 2 applied (should cause boost since only these are counted)
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: kid, timestamp: oldTimestamp },
			{ type: 'violated', knowledge_id: kid, timestamp: oldTimestamp },
			{ type: 'violated', knowledge_id: kid, timestamp: oldTimestamp },
			{ type: 'applied', knowledge_id: kid, timestamp: newTimestamp },
			{ type: 'applied', knowledge_id: kid, timestamp: newTimestamp },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir, {
			sinceTimestamp: cutoff,
		});

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		// Only the 2 new applied events count → applied (2) > violated+ignored (0) → boost
		const entries = await readKnowledgeById(dir);
		expect(entries.get(kid)!.confidence).toBeCloseTo(0.53); // 0.5 + 0.03
	});

	// --------------------------------------------------------------------------
	// 5. Handles multiple entries independently
	// --------------------------------------------------------------------------
	test('handles multiple knowledge entries with independent verdicts', async () => {
		const kidA = randomUUID();
		const kidB = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kidA, lesson: 'entry A - net positive', confidence: 0.5 },
			{ id: kidB, lesson: 'entry B - net negative', confidence: 0.5 },
		]);

		// Entry A: 2 applied, 0 violated → boost
		// Entry B: 1 applied, 3 ignored → decay
		writeEvents(dir, [
			{ type: 'applied', knowledge_id: kidA },
			{ type: 'applied', knowledge_id: kidA },
			{ type: 'applied', knowledge_id: kidB },
			{ type: 'ignored', knowledge_id: kidB },
			{ type: 'ignored', knowledge_id: kidB },
			{ type: 'ignored', knowledge_id: kidB },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir);

		expect(result.processed).toBe(2);
		expect(result.bumps).toBe(2);

		const entries = await readKnowledgeById(dir);
		expect(entries.get(kidA)!.confidence).toBeCloseTo(0.53); // 0.5 + 0.03 (boosted)
		expect(entries.get(kidB)!.confidence).toBeCloseTo(0.45); // 0.5 - 0.05 (decayed)
	});

	// --------------------------------------------------------------------------
	// 6. Decays on exact tie (applied === violated+ignored)
	// --------------------------------------------------------------------------
	test('decays confidence on exact tie (applied === violated+ignored)', async () => {
		const kid = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kid, lesson: 'tie case entry', confidence: 0.5 },
		]);

		// 1 applied, 1 violated → exact tie → decay
		writeEvents(dir, [
			{ type: 'applied', knowledge_id: kid },
			{ type: 'violated', knowledge_id: kid },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const entries = await readKnowledgeById(dir);
		expect(entries.get(kid)!.confidence).toBeCloseTo(0.45); // 0.5 - 0.05
	});

	// --------------------------------------------------------------------------
	// 7. sinceTimestamp boundary — event at exact cutoff is excluded
	// --------------------------------------------------------------------------
	test('excludes events with timestamp exactly equal to sinceTimestamp', async () => {
		const kid = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kid, lesson: 'boundary test entry', confidence: 0.5 },
		]);

		const cutoff = '2026-06-01T12:00:00.000Z';
		const afterCutoff = '2026-06-01T12:00:00.001Z';

		// 2 violated AT cutoff (should be excluded), 1 applied AFTER (included)
		writeEvents(dir, [
			{ type: 'violated', knowledge_id: kid, timestamp: cutoff },
			{ type: 'violated', knowledge_id: kid, timestamp: cutoff },
			{ type: 'applied', knowledge_id: kid, timestamp: afterCutoff },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir, {
			sinceTimestamp: cutoff,
		});

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		// Only the 1 applied event after cutoff counts → boost
		const entries = await readKnowledgeById(dir);
		expect(entries.get(kid)!.confidence).toBeCloseTo(0.53); // 0.5 + 0.03
	});

	// --------------------------------------------------------------------------
	// 8. Ignores non-verdict event types
	// --------------------------------------------------------------------------
	test('ignores non-verdict event types (acknowledged, n_a)', async () => {
		const kid = randomUUID();

		writeKnowledgeEntries(dir, [
			{ id: kid, lesson: 'non-verdict events only', confidence: 0.5 },
		]);

		// Only acknowledged and n_a events — neither is a verdict type
		writeEvents(dir, [
			{ type: 'acknowledged', knowledge_id: kid },
			{ type: 'acknowledged', knowledge_id: kid },
			{ type: 'n_a', knowledge_id: kid },
		]);

		const result = await applyKnowledgeVerdictFeedback(dir);

		expect(result.processed).toBe(0);
		expect(result.bumps).toBe(0);

		// Confidence should be unchanged
		const entries = await readKnowledgeById(dir);
		expect(entries.get(kid)!.confidence).toBe(0.5);
	});
});
