/**
 * End-to-end test: repeat violations escalate through the real verdict pipeline
 * (Swarm Learning System, Change 3 / Task 3.2).
 *
 * Two reviewer VIOLATED verdicts on the same medium directive (within 30 days)
 * auto-escalate it to critical/enforce via the escalator wired into
 * reconcileReviewerVerdicts. A third violation appends a new violated event but
 * does NOT add a second escalation record/event (idempotent).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events.js';
import { reconcileReviewerVerdicts } from '../../src/hooks/reviewer-verdict-parser.js';

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

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'escalation-e2e-'));
}

describe('repeat-violation escalation (e2e)', () => {
	let dir: string;
	let swarmDir: string;

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

	async function violate(): Promise<void> {
		await reconcileReviewerVerdicts({
			directory: dir,
			transcript: 'VIOLATED:d-med evidence=reintroduced the bug',
			directivesToVerify: [{ id: 'd-med', priority: 'medium' }],
			sessionId: 's',
			phase: 'Phase 1',
		});
	}

	beforeEach(() => {
		dir = createRelativeTempDir();
		swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			entryLine('d-med', 'medium'),
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('escalates a medium directive to critical/enforce after the second violation', async () => {
		// First violation — not yet escalated.
		await violate();
		expect(readEntry('d-med')?.directive_priority).toBe('medium');

		// Second violation — crosses the threshold.
		await violate();
		const entry = readEntry('d-med');
		expect(entry?.directive_priority).toBe('critical');
		expect(entry?.enforcement_mode).toBe('enforce');
		expect(entry?.escalation_history as unknown[]).toHaveLength(1);

		const events = await readKnowledgeEvents(dir);
		expect(events.filter((e) => e.type === 'escalation')).toHaveLength(1);
		// Two violated events recorded.
		expect(
			events.filter((e) => e.type === 'violated' && 'knowledge_id' in e).length,
		).toBe(2);
	});

	it('does not re-escalate on a third violation, but records the new violation', async () => {
		await violate();
		await violate(); // escalates here
		await violate(); // third — must not re-escalate

		const entry = readEntry('d-med');
		expect(entry?.escalation_history as unknown[]).toHaveLength(1);

		const events = await readKnowledgeEvents(dir);
		expect(events.filter((e) => e.type === 'escalation')).toHaveLength(1);
		expect(
			events.filter((e) => e.type === 'violated' && 'knowledge_id' in e).length,
		).toBe(3);
	});
});
