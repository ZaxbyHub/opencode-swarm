/**
 * Integration test: reviewer verdict reconciliation → knowledge events
 * (Change 2 / Task 2.3).
 *
 * A phase with 5 directives must produce 5 receipt events with correct rollup
 * counters; an omitted CRITICAL becomes a synthetic violated/reviewer_omitted
 * event; a VIOLATED with a predicate runs the predicate and persists its result.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DirectiveToVerify } from '../../src/agents/reviewer-directive-compliance.js';
import {
	readKnowledgeEvents,
	recomputeCounters,
} from '../../src/hooks/knowledge-events.js';
import { reconcileReviewerVerdicts } from '../../src/hooks/reviewer-verdict-parser.js';

describe('reconcileReviewerVerdicts', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-rollup-'));
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		// A file containing the forbidden pattern so d2's grep predicate finds a
		// match (predicate result 'fail', corroborating the reviewer's VIOLATED).
		fs.writeFileSync(
			path.join(dir, 'src', 'legacy.ts'),
			'const x = asyncIteratorBad;\n',
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const directives: DirectiveToVerify[] = [
		{ id: 'd1', priority: 'critical' },
		{
			id: 'd2',
			priority: 'high',
			verification_predicate: 'grep:asyncIteratorBad:src/**/*.ts',
		},
		{ id: 'd3', priority: 'medium' },
		{ id: 'd4', priority: 'critical' }, // omitted in transcript
		{ id: 'd5', priority: 'low' },
	];

	it('records 5 events with correct counters, predicate result, and omitted-critical synthesis', async () => {
		const transcript = [
			'VERDICT: REJECTED',
			'DIRECTIVE_COMPLIANCE:',
			'VERIFIED:d1 evidence=src/foo.ts:10',
			'VIOLATED:d2 evidence=found forbidden pattern',
			'N/A:d3 reason=not applicable',
			'VERIFIED:d5 evidence=src/bar.ts:3',
			// d4 (critical) deliberately omitted.
		].join('\n');

		const result = await reconcileReviewerVerdicts({
			directory: dir,
			transcript,
			directivesToVerify: directives,
			sessionId: 'sess-r',
			taskId: 't-9',
			phase: 'Phase 2',
		});

		// 5 emitted events: d1 applied, d2 violated, d3 n_a, d5 applied, d4 violated(omitted).
		expect(result.emitted).toHaveLength(5);
		expect(result.omittedCriticals).toEqual(['d4']);

		const events = await readKnowledgeEvents(dir);
		const byId = new Map(
			events
				.filter((e) => 'knowledge_id' in e)
				.map((e) => {
					const r = e as {
						knowledge_id: string;
						type: string;
						source?: string;
						reason?: string;
						predicate_check?: { result: string };
					};
					return [r.knowledge_id, r];
				}),
		);

		expect(byId.get('d1')?.type).toBe('applied');
		expect(byId.get('d1')?.source).toBe('reviewer');
		expect(byId.get('d2')?.type).toBe('violated');
		expect(byId.get('d3')?.type).toBe('n_a');
		expect(byId.get('d5')?.type).toBe('applied');
		// Omitted critical → synthetic violated/reviewer_omitted.
		expect(byId.get('d4')?.type).toBe('violated');
		expect(byId.get('d4')?.reason).toBe('reviewer_omitted');

		// d2's predicate was executed (forbidden pattern present → 'fail').
		expect(byId.get('d2')?.predicate_check?.result).toBe('fail');

		// Rollup counters.
		const rollup = recomputeCounters(events);
		expect(rollup.get('d1')?.applied_explicit_count).toBe(1);
		expect(rollup.get('d5')?.applied_explicit_count).toBe(1);
		expect(rollup.get('d2')?.violated_count).toBe(1);
		expect(rollup.get('d4')?.violated_count).toBe(1);
		expect(rollup.get('d3')?.n_a_count).toBe(1);
	});

	it('drops verdicts for IDs not in the verify-set (anti-spoofing)', async () => {
		const transcript = [
			'VERIFIED:d1 evidence=ok',
			'VERIFIED:not-a-real-directive evidence=spoofed',
		].join('\n');
		const result = await reconcileReviewerVerdicts({
			directory: dir,
			transcript,
			directivesToVerify: [{ id: 'd1', priority: 'high' }],
			sessionId: 's',
		});
		expect(result.emitted.map((e) => e.id)).toEqual(['d1']);
		const events = await readKnowledgeEvents(dir);
		const ids = events
			.filter((e) => 'knowledge_id' in e)
			.map((e) => (e as { knowledge_id: string }).knowledge_id);
		expect(ids).not.toContain('not-a-real-directive');
	});

	it('is a no-op when there are no directives to verify', async () => {
		const result = await reconcileReviewerVerdicts({
			directory: dir,
			transcript: 'VERIFIED:d1 evidence=ok',
			directivesToVerify: [],
		});
		expect(result.emitted).toEqual([]);
		expect((await readKnowledgeEvents(dir)).length).toBe(0);
	});
});
