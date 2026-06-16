/**
 * Integration test: phase_complete critical-directive gate end-to-end
 * (Swarm Learning System, Change 2 / Task 2.4).
 *
 * Drives executePhaseComplete and asserts the directive gate's three paths:
 * blocked (unresolved critical), override (architect + justification logs an
 * override event and clears the directive block), and clean (no criticals →
 * gate does not block on directive grounds).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events.js';
import { executePhaseComplete } from '../../src/tools/phase-complete.js';

const PHASE = 'Phase 2';

function entryLine(id: string, priority: string): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson: `lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.9,
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

function retrievedLine(ids: string[]): string {
	return JSON.stringify({
		type: 'retrieved',
		event_id: 'r-1',
		trace_id: 't',
		timestamp: '2026-02-01T00:00:00.000Z',
		session_id: 's',
		phase: PHASE,
		agent: 'coder',
		query: 'q',
		retrieval_mode: 'delegate_inject',
		result_ids: ids,
		ranks: {},
		scores: {},
	});
}

function violatedLine(id: string): string {
	return JSON.stringify({
		type: 'violated',
		event_id: `v-${id}`,
		trace_id: 't',
		knowledge_id: id,
		timestamp: '2026-02-01T00:02:00.000Z',
		session_id: 's',
		agent: 'coder',
		reason: 'introduced forbidden pattern',
	});
}

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'pc-e2e-'));
}

function seed(dir: string, entries: string[], events: string[]): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), entries.join('\n'));
	fs.writeFileSync(
		path.join(swarmDir, 'knowledge-events.jsonl'),
		`${events.join('\n')}\n`,
	);
}

describe('phase_complete critical-directive gate (e2e)', () => {
	let dir: string;

	beforeEach(() => {
		dir = createRelativeTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('BLOCKS the phase when a critical directive has an unremediated violation', async () => {
		seed(
			dir,
			[entryLine('c1', 'critical')],
			[retrievedLine(['c1']), violatedLine('c1')],
		);
		const out = await executePhaseComplete(
			{ phase: 2, sessionID: 'sess-e2e', callerAgent: 'architect' },
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('unresolved_critical_directives');
		expect(parsed.message).toContain('c1');
	});

	it('rejects an override without a justification', async () => {
		seed(
			dir,
			[entryLine('c1', 'critical')],
			[retrievedLine(['c1']), violatedLine('c1')],
		);
		const out = await executePhaseComplete(
			{
				phase: 2,
				sessionID: 'sess-e2e',
				callerAgent: 'architect',
				acceptViolations: ['c1'],
			},
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.reason).toBe('override_requires_justification');
	});

	it('honors an architect override (with justification): logs an override event and clears the directive block', async () => {
		seed(
			dir,
			[entryLine('c1', 'critical')],
			[retrievedLine(['c1']), violatedLine('c1')],
		);
		const out = await executePhaseComplete(
			{
				phase: 2,
				sessionID: 'sess-e2e',
				callerAgent: 'architect',
				acceptViolations: ['c1'],
				acceptViolationsJustification:
					'Accepted: tracked as follow-up issue #123',
			},
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		// The directive gate no longer blocks (it may still block downstream on
		// unrelated gates like the retro gate — but NOT for directive reasons).
		expect(parsed.reason).not.toBe('unresolved_critical_directives');

		// An override event was logged for the accepted id.
		const events = await readKnowledgeEvents(dir);
		const overrides = events.filter((e) => e.type === 'override') as Array<{
			knowledge_id: string;
			reason?: string;
		}>;
		expect(overrides.length).toBe(1);
		expect(overrides[0].knowledge_id).toBe('c1');
		expect(overrides[0].reason).toContain('issue #123');
	});

	it('does not block on directive grounds when there are no critical directives', async () => {
		seed(dir, [entryLine('h1', 'high')], [retrievedLine(['h1'])]);
		const out = await executePhaseComplete(
			{ phase: 2, sessionID: 'sess-e2e', callerAgent: 'architect' },
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.reason).not.toBe('unresolved_critical_directives');
		expect(parsed.reason).not.toBe('directive_gate_failed_closed');
	});
});
