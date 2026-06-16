/**
 * Unit tests for the repeat-mistake escalator (Change 3 / Task 3.2).
 *
 * Two violations within 30 days promote a directive to critical/enforce with one
 * escalation_history record and an `escalation` event. The escalator is
 * idempotent: a third violation does not add a second escalation record or event.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { maybeEscalateOnViolation } from '../../../src/hooks/knowledge-escalator.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T00:00:00.000Z');

function entryLine(id: string, priority: string): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson: `lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.7,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'test',
		directive_priority: priority,
	});
}

function violatedLine(id: string, ms: number): string {
	return JSON.stringify({
		type: 'violated',
		event_id: `v-${id}-${ms}`,
		trace_id: 't',
		knowledge_id: id,
		timestamp: new Date(ms).toISOString(),
		session_id: 's',
		agent: 'coder',
	});
}

describe('maybeEscalateOnViolation', () => {
	let dir: string;
	let swarmDir: string;

	function writeEvents(lines: string[]): void {
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${lines.join('\n')}\n`,
		);
	}

	function appendEvent(line: string): void {
		fs.appendFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${line}\n`,
		);
	}

	function readEntry(id: string): Record<string, unknown> | undefined {
		const content = fs.readFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			'utf-8',
		);
		for (const line of content.split('\n')) {
			if (!line.trim()) continue;
			const e = JSON.parse(line);
			if (e.id === id) return e;
		}
		return undefined;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalator-'));
		swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			entryLine('c1', 'medium'),
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('does not escalate on a single violation', async () => {
		writeEvents([violatedLine('c1', NOW.getTime())]);
		const r = await maybeEscalateOnViolation(dir, 'c1', NOW);
		expect(r.escalated).toBe(false);
		expect(r.violationsInWindow).toBe(1);
		expect(readEntry('c1')?.directive_priority).toBe('medium');
	});

	it('escalates to critical/enforce on the second violation within 30 days', async () => {
		writeEvents([
			violatedLine('c1', NOW.getTime() - 5 * DAY),
			violatedLine('c1', NOW.getTime()),
		]);
		const r = await maybeEscalateOnViolation(dir, 'c1', NOW);
		expect(r.escalated).toBe(true);
		expect(r.from).toBe('medium');
		expect(r.to).toBe('critical');

		const entry = readEntry('c1');
		expect(entry?.directive_priority).toBe('critical');
		expect(entry?.enforcement_mode).toBe('enforce');
		const history = entry?.escalation_history as unknown[];
		expect(history).toHaveLength(1);
		expect((history[0] as { reason: string }).reason).toBe('repeat_violation');

		// An escalation event was emitted.
		const events = await readKnowledgeEvents(dir);
		const esc = events.filter((e) => e.type === 'escalation') as Array<{
			entry_id: string;
			to: string;
		}>;
		expect(esc).toHaveLength(1);
		expect(esc[0].entry_id).toBe('c1');
		expect(esc[0].to).toBe('critical');
	});

	it('does NOT escalate violations outside the 30-day window', async () => {
		writeEvents([
			violatedLine('c1', NOW.getTime() - 40 * DAY),
			violatedLine('c1', NOW.getTime() - 35 * DAY),
		]);
		const r = await maybeEscalateOnViolation(dir, 'c1', NOW);
		expect(r.escalated).toBe(false);
		expect(r.violationsInWindow).toBe(0);
	});

	it('is idempotent: a third violation does not re-escalate', async () => {
		// First, escalate with two violations.
		writeEvents([
			violatedLine('c1', NOW.getTime() - 5 * DAY),
			violatedLine('c1', NOW.getTime()),
		]);
		await maybeEscalateOnViolation(dir, 'c1', NOW);

		// A third violation 10 days later — APPEND so the first escalation event
		// (already in the log) is preserved.
		const later = new Date(NOW.getTime() + 10 * DAY);
		appendEvent(violatedLine('c1', later.getTime()));
		const r2 = await maybeEscalateOnViolation(dir, 'c1', later);
		expect(r2.escalated).toBe(false);
		expect(r2.alreadyEscalated).toBe(true);

		// Still exactly one escalation_history record.
		const history = readEntry('c1')?.escalation_history as unknown[];
		expect(history).toHaveLength(1);

		// Still exactly one escalation event.
		const events = await readKnowledgeEvents(dir);
		expect(events.filter((e) => e.type === 'escalation')).toHaveLength(1);
	});

	it('is race-safe: concurrent escalations apply exactly once (regression: Phase 3 review F2)', async () => {
		writeEvents([
			violatedLine('c1', NOW.getTime() - 5 * DAY),
			violatedLine('c1', NOW.getTime()),
		]);
		// Fire two escalation attempts concurrently for the same entry. The atomic
		// transactKnowledge read-modify-write must serialize them so only the first
		// applies; the second sees critical/enforce and no-ops.
		const [a, b] = await Promise.all([
			maybeEscalateOnViolation(dir, 'c1', NOW),
			maybeEscalateOnViolation(dir, 'c1', NOW),
		]);
		const escalatedCount = [a, b].filter((r) => r.escalated).length;
		expect(escalatedCount).toBe(1);

		// Exactly one escalation_history record persisted (no double-write clobber).
		const history = readEntry('c1')?.escalation_history as unknown[];
		expect(history).toHaveLength(1);
	});
});
