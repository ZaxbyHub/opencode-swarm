/**
 * Tests for violation-window rollups (Swarm Learning System, Change 3 / Task 3.1).
 *
 * recomputeCounters must surface the most recent violation timestamps (newest
 * first, capped), and countViolationsInWindow must count violations within a
 * day-window relative to a given "now".
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	countEntryViolationsInWindow,
	countViolationsInWindow,
	type KnowledgeEvent,
	MAX_VIOLATION_TIMESTAMPS,
	recomputeCounters,
} from '../../../src/hooks/knowledge-events.js';

const DAY = 24 * 60 * 60 * 1000;

function violatedAt(id: string, ms: number): KnowledgeEvent {
	return {
		type: 'violated',
		event_id: `v-${id}-${ms}`,
		trace_id: 't',
		knowledge_id: id,
		timestamp: new Date(ms).toISOString(),
		session_id: 's',
		agent: 'coder',
	} as KnowledgeEvent;
}

describe('violation-window rollups', () => {
	it('surfaces violation timestamps newest-first', () => {
		const base = Date.parse('2026-01-01T00:00:00.000Z');
		const events = [
			violatedAt('c1', base),
			violatedAt('c1', base + 5 * DAY),
			violatedAt('c1', base + 2 * DAY),
		];
		const rollup = recomputeCounters(events);
		const ts = rollup.get('c1')?.violation_timestamps ?? [];
		expect(ts.length).toBe(3);
		// Newest first.
		expect(ts[0]).toBe(new Date(base + 5 * DAY).toISOString());
		expect(ts[2]).toBe(new Date(base).toISOString());
		expect(rollup.get('c1')?.violated_count).toBe(3);
	});

	it('caps retained timestamps at MAX_VIOLATION_TIMESTAMPS', () => {
		const base = Date.parse('2026-01-01T00:00:00.000Z');
		const events: KnowledgeEvent[] = [];
		for (let i = 0; i < MAX_VIOLATION_TIMESTAMPS + 5; i++) {
			events.push(violatedAt('c1', base + i * DAY));
		}
		const ts = recomputeCounters(events).get('c1')?.violation_timestamps ?? [];
		expect(ts.length).toBe(MAX_VIOLATION_TIMESTAMPS);
		// The newest one is retained.
		expect(ts[0]).toBe(
			new Date(base + (MAX_VIOLATION_TIMESTAMPS + 4) * DAY).toISOString(),
		);
	});

	it('countViolationsInWindow: 3 violations within 25 days → 3', () => {
		const day0 = Date.parse('2026-01-01T00:00:00.000Z');
		const timestamps = [
			new Date(day0).toISOString(),
			new Date(day0 + 5 * DAY).toISOString(),
			new Date(day0 + 25 * DAY).toISOString(),
		];
		const now = new Date(day0 + 25 * DAY);
		expect(countViolationsInWindow(timestamps, 30, now)).toBe(3);
	});

	it('countViolationsInWindow: a 4th violation 40 days later, window 30 → 1', () => {
		const day0 = Date.parse('2026-01-01T00:00:00.000Z');
		const timestamps = [
			new Date(day0).toISOString(),
			new Date(day0 + 5 * DAY).toISOString(),
			new Date(day0 + 25 * DAY).toISOString(),
			new Date(day0 + 65 * DAY).toISOString(), // 40 days after the cluster
		];
		const now = new Date(day0 + 65 * DAY);
		// Only the day-65 violation is within the trailing 30-day window.
		expect(countViolationsInWindow(timestamps, 30, now)).toBe(1);
	});

	it('countViolationsInWindow: exactly at the window boundary is included', () => {
		const now = new Date('2026-03-01T00:00:00.000Z');
		const exactly30 = new Date(now.getTime() - 30 * DAY).toISOString();
		expect(countViolationsInWindow([exactly30], 30, now)).toBe(1);
	});

	it('countViolationsInWindow: ignores malformed timestamps', () => {
		const now = new Date('2026-03-01T00:00:00.000Z');
		expect(countViolationsInWindow(['not-a-date', ''], 30, now)).toBe(0);
	});
});

describe('countEntryViolationsInWindow — cap-independent (regression: Phase 3 review F1)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'violwin-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('counts MORE than MAX_VIOLATION_TIMESTAMPS in-window violations accurately', async () => {
		// Previously this counted from the rollup's capped (10) timestamp list and
		// would undercount. The fix counts directly from the event log.
		const base = Date.parse('2026-03-01T00:00:00.000Z');
		const total = MAX_VIOLATION_TIMESTAMPS + 5; // 15
		const lines: string[] = [];
		for (let i = 0; i < total; i++) {
			lines.push(
				JSON.stringify({
					type: 'violated',
					event_id: `v-${i}`,
					trace_id: 't',
					knowledge_id: 'c1',
					timestamp: new Date(base - i * DAY).toISOString(),
					session_id: 's',
					agent: 'coder',
				}),
			);
		}
		fs.writeFileSync(
			path.join(dir, '.swarm', 'knowledge-events.jsonl'),
			`${lines.join('\n')}\n`,
		);

		const now = new Date(base + DAY);
		const count = await countEntryViolationsInWindow(dir, 'c1', 30, now);
		// All 15 are within the trailing 30 days → accurate count, not capped at 10.
		expect(count).toBe(total);
	});
});
