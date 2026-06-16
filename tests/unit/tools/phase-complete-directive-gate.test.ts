/**
 * Unit tests for the phase-complete critical-directive gate
 * (Swarm Learning System, Change 2 / Task 2.4).
 *
 * A CRITICAL directive shown during the phase must have a terminal outcome and
 * no unremediated violation, else the phase is blocked. Architect override is
 * honored via acceptViolations. Fail-closed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluatePhaseCriticalDirectives } from '../../../src/hooks/phase-complete-directive-gate.js';

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

function retrievedLine(ids: string[], ts: string): string {
	return JSON.stringify({
		type: 'retrieved',
		event_id: `r-${ts}`,
		trace_id: 't',
		timestamp: ts,
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

function receiptLine(
	type: string,
	id: string,
	ts: string,
	reason?: string,
): string {
	return JSON.stringify({
		type,
		event_id: `e-${type}-${id}-${ts}`,
		trace_id: 't',
		knowledge_id: id,
		timestamp: ts,
		session_id: 's',
		agent: 'coder',
		...(reason ? { reason } : {}),
	});
}

describe('evaluatePhaseCriticalDirectives', () => {
	let dir: string;

	function seed(entries: string[], events: string[]): void {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			entries.join('\n'),
		);
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${events.join('\n')}\n`,
		);
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gate-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('blocks a critical with no verdict at all', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[retrievedLine(['c1'], '2026-02-01T00:00:00.000Z')],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(true);
		expect(r.unresolved).toEqual([{ id: 'c1', reason: 'no_verdict' }]);
	});

	it('passes a critical that was applied/verified', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
				receiptLine('applied', 'c1', '2026-02-01T00:01:00.000Z'),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(false);
	});

	it('blocks a critical with an unremediated violation', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
				receiptLine('violated', 'c1', '2026-02-01T00:02:00.000Z', 'bad'),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(true);
		expect(r.unresolved[0]).toEqual({
			id: 'c1',
			reason: 'unremediated_violation',
		});
	});

	it('passes a violation that was remediated by a LATER applied', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
				receiptLine('violated', 'c1', '2026-02-01T00:02:00.000Z', 'bad'),
				receiptLine('applied', 'c1', '2026-02-01T00:05:00.000Z'),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(false);
	});

	it('passes a critical resolved by ignored-with-reason', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
				receiptLine(
					'ignored',
					'c1',
					'2026-02-01T00:01:00.000Z',
					'not applicable',
				),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(false);
	});

	it('blocks ignored WITHOUT a reason (no real decision)', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
				receiptLine('ignored', 'c1', '2026-02-01T00:01:00.000Z'),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(true);
	});

	it('does not gate non-critical directives', async () => {
		seed(
			[entryLine('h1', 'high'), entryLine('m1', 'medium')],
			[retrievedLine(['h1', 'm1'], '2026-02-01T00:00:00.000Z')],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(false);
	});

	it('honors an architect override (acceptViolations) and reports it', async () => {
		seed(
			[entryLine('c1', 'critical')],
			[
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
				receiptLine('violated', 'c1', '2026-02-01T00:02:00.000Z', 'bad'),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
			acceptViolations: ['c1'],
		});
		expect(r.blocked).toBe(false);
		expect(r.overridden).toEqual(['c1']);
	});

	it('ignores outcomes from a different phase window', async () => {
		// Outcome BEFORE the phase's first retrieved event must not satisfy it.
		seed(
			[entryLine('c1', 'critical')],
			[
				receiptLine('applied', 'c1', '2026-01-01T00:00:00.000Z'),
				retrievedLine(['c1'], '2026-02-01T00:00:00.000Z'),
			],
		);
		const r = await evaluatePhaseCriticalDirectives({
			directory: dir,
			phaseLabel: PHASE,
		});
		expect(r.blocked).toBe(true);
		expect(r.unresolved[0].reason).toBe('no_verdict');
	});
});
