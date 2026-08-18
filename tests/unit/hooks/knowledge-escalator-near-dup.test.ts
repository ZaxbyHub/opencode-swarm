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
	_internals,
	ESCALATION_THRESHOLD,
	ESCALATION_WINDOW_DAYS,
	maybeEscalateOnViolation,
} from '../../../src/hooks/knowledge-escalator.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';
import type { ReceiptMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-04-15T00:00:00.000Z');
let historicalMemberships: ReceiptMembership[] = [];

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
	if (path.basename(filePath) === 'knowledge-events.jsonl') {
		historicalMemberships = lines.map((line, index) => {
			const event = JSON.parse(line) as {
				event_id: string;
				trace_id: string;
				knowledge_id: string;
				timestamp: string;
			};
			return {
				trace_id: `${event.trace_id}-${index}`,
				entry_id: event.knowledge_id,
				session_id: 'test',
				critical: false,
				committed_at: event.timestamp,
				membership_event_id: `membership-${index}`,
				grace_days: 7,
				exposure_kind: 'legacy_unknown',
				origin: 'v2',
				terminal: {
					outcome: 'violated',
					source: 'test',
					event_id: event.event_id,
					committed_at: event.timestamp,
				},
			} satisfies ReceiptMembership;
		});
	}
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
	let hiveHome: string;
	let origHome: string | undefined;
	let origLocalAppData: string | undefined;
	let origXdgData: string | undefined;
	const originalQueryHistoricalOutcomes = _internals.queryHistoricalOutcomes;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalator-near-dup-'));
		swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		knowledgePath = path.join(swarmDir, 'knowledge.jsonl');
		eventsPath = path.join(swarmDir, 'knowledge-events.jsonl');
		// Redirect the platform hive root for the whole suite: the escalator's near-dup
		// co-counting reads the hive store on every call (fail-open on read errors).
		// Without redirection that read hits the REAL machine store — machine-dependent
		// results and, under the issue #2033 tripwire, a blocked read (#2033).
		origHome = process.env.HOME;
		origLocalAppData = process.env.LOCALAPPDATA;
		origXdgData = process.env.XDG_DATA_HOME;
		hiveHome = canonicalMkdtemp('escalator-hive-');
		process.env.HOME = hiveHome;
		process.env.LOCALAPPDATA = path.join(hiveHome, 'AppData', 'Local');
		process.env.XDG_DATA_HOME = hiveHome;
		historicalMemberships = [];
		_internals.queryHistoricalOutcomes = async () => ({
			ok: true,
			memberships: historicalMemberships,
		});
	});

	afterEach(() => {
		_internals.queryHistoricalOutcomes = originalQueryHistoricalOutcomes;
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = origLocalAppData;
		if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = origXdgData;
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(hiveHome, { recursive: true, force: true });
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

	it('conservatively keeps exact authoritative count when near-duplicate lookup is unavailable', async () => {
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
		const origLocalAppData = process.env.LOCALAPPDATA;
		const hiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-home-'));
		process.env.HOME = hiveHome;
		process.env.LOCALAPPDATA = path.join(hiveHome, 'AppData', 'Local');
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
			if (origHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = origHome;
			}
			if (origLocalAppData === undefined) {
				delete process.env.LOCALAPPDATA;
			} else {
				process.env.LOCALAPPDATA = origLocalAppData;
			}
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
