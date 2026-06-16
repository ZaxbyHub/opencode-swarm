/**
 * Unit tests for near-duplicate co-escalation in the knowledge escalator
 * (WP6-A, issue #1234).
 *
 * When the exact entry alone does not reach the escalation threshold of 2
 * violations in 30 days, the escalator co-counts violations on semantically
 * near-duplicate entries (Jaccard bigram similarity >= 0.6). The near-dup
 * lookup is wrapped in try-catch (fail-open).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ESCALATION_THRESHOLD,
	ESCALATION_WINDOW_DAYS,
	maybeEscalateOnViolation,
} from '../../../src/hooks/knowledge-escalator.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-04-15T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSONL line for a knowledge entry. */
function knowledgeLine(
	id: string,
	lesson: string,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		id,
		lesson,
		category: 'process',
		status: 'established',
		confidence: 0.7,
		tags: [],
		scope: 'global',
		confirmed_by: [],
		project_name: 'test',
		directive_priority: 'medium',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		...overrides,
	});
}

/** Build a JSONL line for a violated event. */
function violatedLine(knowledgeId: string, timestampMs: number): string {
	return JSON.stringify({
		type: 'violated',
		event_id: randomUUID(),
		trace_id: randomUUID(),
		knowledge_id: knowledgeId,
		timestamp: new Date(timestampMs).toISOString(),
		session_id: randomUUID(),
		agent: 'coder',
	});
}

/** Write multiple JSONL lines to a file. */
function writeJsonl(filePath: string, lines: string[]): void {
	fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

// Lesson text constants. The near-duplicate pair has Jaccard bigram >= 0.6;
// the dissimilar lesson has 0.0 similarity to either.
// Verified: "Always run tests before committing code" vs
//           "Always run tests before committing changes" = 0.667
const LESSON_A = 'Always run tests before committing code';
const LESSON_B_NEAR_DUP = 'Always run tests before committing changes';
const LESSON_C_DIFFERENT = 'Use snake_case for all database column names';

describe('maybeEscalateOnViolation — near-duplicate co-escalation', () => {
	let dir: string;
	let swarmDir: string;
	let knowledgePath: string;
	let eventsPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalator-near-dup-'));
		swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
		eventsPath = path.join(swarmDir, 'knowledge-events.jsonl');
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('does not escalate when only the exact entry has 1 violation (no near-duplicates)', async () => {
		const idA = randomUUID();
		writeJsonl(knowledgePath, [knowledgeLine(idA, LESSON_A)]);
		writeJsonl(eventsPath, [violatedLine(idA, NOW.getTime() - 3 * DAY)]);

		const result = await maybeEscalateOnViolation(dir, idA, NOW);

		expect(result.escalated).toBe(false);
		expect(result.violationsInWindow).toBe(1);
	});

	it('escalates when the exact entry alone reaches the threshold (near-dup path not needed)', async () => {
		const idA = randomUUID();
		writeJsonl(knowledgePath, [knowledgeLine(idA, LESSON_A)]);
		writeJsonl(eventsPath, [
			violatedLine(idA, NOW.getTime() - 10 * DAY),
			violatedLine(idA, NOW.getTime() - 1 * DAY),
		]);

		const result = await maybeEscalateOnViolation(dir, idA, NOW);

		expect(result.escalated).toBe(true);
		expect(result.from).toBe('medium');
		expect(result.to).toBe('critical');
		expect(result.violationsInWindow).toBeGreaterThanOrEqual(
			ESCALATION_THRESHOLD,
		);

		// Verify the entry was updated on disk.
		const content = fs.readFileSync(knowledgePath, 'utf-8');
		const entry = content
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l))
			.find((e: { id: string }) => e.id === idA);
		expect(entry.directive_priority).toBe('critical');
		expect(entry.enforcement_mode).toBe('enforce');

		// An escalation event was emitted.
		const events = await readKnowledgeEvents(dir);
		const escalations = events.filter((e) => e.type === 'escalation');
		expect(escalations.length).toBe(1);
	});

	it('co-counts near-duplicate violations to reach escalation threshold', async () => {
		const idA = randomUUID();
		const idB = randomUUID();

		// Two entries with near-duplicate lessons (Jaccard >= 0.6).
		writeJsonl(knowledgePath, [
			knowledgeLine(idA, LESSON_A),
			knowledgeLine(idB, LESSON_B_NEAR_DUP),
		]);

		// Each entry has 1 violation — alone not enough, but combined = 2.
		writeJsonl(eventsPath, [
			violatedLine(idA, NOW.getTime() - 5 * DAY),
			violatedLine(idB, NOW.getTime() - 2 * DAY),
		]);

		const result = await maybeEscalateOnViolation(dir, idA, NOW);

		expect(result.escalated).toBe(true);
		expect(result.from).toBe('medium');
		expect(result.to).toBe('critical');
		expect(result.violationsInWindow).toBeGreaterThanOrEqual(
			ESCALATION_THRESHOLD,
		);

		// Verify on-disk escalation for entry A (the target).
		const content = fs.readFileSync(knowledgePath, 'utf-8');
		const entryA = content
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l))
			.find((e: { id: string }) => e.id === idA);
		expect(entryA.directive_priority).toBe('critical');
		expect(entryA.enforcement_mode).toBe('enforce');
		expect(entryA.escalation_history).toHaveLength(1);
		expect(entryA.escalation_history[0].reason).toBe('repeat_violation');

		// Entry B is NOT escalated (only the target entry is promoted).
		const entryB = content
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l))
			.find((e: { id: string }) => e.id === idB);
		expect(entryB.directive_priority).toBe('medium');
	});

	it('does NOT co-count entries below the similarity threshold', async () => {
		const idA = randomUUID();
		const idC = randomUUID();

		// Entry A and entry C have completely different lessons (similarity = 0.0).
		writeJsonl(knowledgePath, [
			knowledgeLine(idA, LESSON_A),
			knowledgeLine(idC, LESSON_C_DIFFERENT),
		]);

		// Each has 1 violation — but they are not similar, so no co-counting.
		writeJsonl(eventsPath, [
			violatedLine(idA, NOW.getTime() - 5 * DAY),
			violatedLine(idC, NOW.getTime() - 2 * DAY),
		]);

		const result = await maybeEscalateOnViolation(dir, idA, NOW);

		expect(result.escalated).toBe(false);
		expect(result.violationsInWindow).toBe(1);

		// Entry A remains at medium priority.
		const content = fs.readFileSync(knowledgePath, 'utf-8');
		const entryA = content
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l))
			.find((e: { id: string }) => e.id === idA);
		expect(entryA.directive_priority).toBe('medium');
	});

	it('fail-open: falls back to exact-count when knowledge store is missing', async () => {
		const idA = randomUUID();

		// Write events but do NOT create knowledge.jsonl — the near-dup
		// lookup should fail silently and fall back to exact-only counting.
		writeJsonl(eventsPath, [violatedLine(idA, NOW.getTime() - 3 * DAY)]);

		// No knowledge.jsonl exists — readKnowledge returns [].
		// The target entry will not be found, so near-dup loop is skipped.
		const result = await maybeEscalateOnViolation(dir, idA, NOW);

		// Only 1 exact violation, threshold not met, no crash.
		expect(result.escalated).toBe(false);
		expect(result.violationsInWindow).toBe(1);
	});

	it('co-counts near-duplicate violations from the hive knowledge store', async () => {
		const idA = randomUUID();
		const idHive = randomUUID();

		// Entry A is in the swarm store with 1 violation.
		writeJsonl(knowledgePath, [knowledgeLine(idA, LESSON_A)]);

		// Near-duplicate entry lives only in the hive store.
		const origHome = process.env.HOME;
		const hiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-home-'));
		process.env.HOME = hiveHome;
		try {
			const { resolveHiveKnowledgePath } = await import(
				'../../../src/hooks/knowledge-store.js'
			);
			const hivePath = resolveHiveKnowledgePath();
			fs.mkdirSync(path.dirname(hivePath), { recursive: true });
			writeJsonl(hivePath, [knowledgeLine(idHive, LESSON_B_NEAR_DUP)]);

			// Each entry has 1 violation — combined = 2 via near-dup co-counting.
			writeJsonl(eventsPath, [
				violatedLine(idA, NOW.getTime() - 5 * DAY),
				violatedLine(idHive, NOW.getTime() - 2 * DAY),
			]);

			const result = await maybeEscalateOnViolation(dir, idA, NOW);

			expect(result.escalated).toBe(true);
			expect(result.from).toBe('medium');
			expect(result.to).toBe('critical');
		} finally {
			process.env.HOME = origHome;
			fs.rmSync(hiveHome, { recursive: true, force: true });
		}
	});

	it('does not co-count near-duplicate violations outside the window', async () => {
		const idA = randomUUID();
		const idB = randomUUID();

		writeJsonl(knowledgePath, [
			knowledgeLine(idA, LESSON_A),
			knowledgeLine(idB, LESSON_B_NEAR_DUP),
		]);

		// Entry A has 1 violation within the window.
		// Entry B's violation is outside the 30-day window — should not count.
		writeJsonl(eventsPath, [
			violatedLine(idA, NOW.getTime() - 5 * DAY),
			violatedLine(idB, NOW.getTime() - (ESCALATION_WINDOW_DAYS + 5) * DAY),
		]);

		const result = await maybeEscalateOnViolation(dir, idA, NOW);

		expect(result.escalated).toBe(false);
		expect(result.violationsInWindow).toBe(1);
	});
});
