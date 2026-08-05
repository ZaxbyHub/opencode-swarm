/**
 * The phase-complete critical-directive gate must never be unblocked by an
 * `unacknowledged` event.
 *
 * `unacknowledged` records that a shown directive reached the end of a delegate
 * Task with no ack marker and no receipt. The collector only ever emits it for
 * NON-critical directives, so today it cannot reach a critical id — this file
 * pins the gate STRUCTURALLY anyway, so that if the emission scope ever widens,
 * "the delegate said nothing" can never be mistaken for a terminal verdict and
 * silently let a phase complete over an unresolved critical.
 *
 * Real filesystem, no mocks: the gate is a pure function of the on-disk
 * knowledge store + event log, and this file must not inherit the sibling
 * gate suite's `mock.module` isolation tier.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events.js';
import { evaluatePhaseCriticalDirectives } from '../../../src/hooks/phase-complete-directive-gate.js';

const PHASE = 'phase-1';
const CRITICAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcdg-unack-'));
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'knowledge.jsonl'),
		`${JSON.stringify({
			id: CRITICAL_ID,
			tier: 'swarm',
			lesson: 'a critical directive',
			category: 'lesson',
			status: 'established',
			directive_priority: 'critical',
			confidence: 0.9,
			tags: [],
			scope: 'global',
			confirmed_by: [],
			project_name: 'test',
		})}\n`,
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function seedRetrieved(): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: 'retrieved',
		trace_id: 'trace-pcdg',
		session_id: 'sess-pcdg',
		agent: 'coder',
		phase: PHASE,
		query: 'work',
		retrieval_mode: 'delegate_inject',
		result_ids: [CRITICAL_ID],
		ranks: { [CRITICAL_ID]: 1 },
		scores: { [CRITICAL_ID]: 1 },
	});
}

async function seedUnacknowledged(): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: 'unacknowledged',
		trace_id: 'trace-pcdg',
		knowledge_id: CRITICAL_ID,
		session_id: 'sess-pcdg',
		agent: 'coder',
		source: 'delegate',
		reason: 'no_ack_marker',
	});
}

test('control: an applied terminal DOES unblock the gate for the same fixture', async () => {
	// Proves the fixture is capable of reaching `blocked: false`, so the
	// still-blocked assertions below cannot pass vacuously.
	await seedRetrieved();
	await appendKnowledgeEvent(dir, {
		type: 'applied',
		trace_id: 'trace-pcdg',
		knowledge_id: CRITICAL_ID,
		session_id: 'sess-pcdg',
		agent: 'coder',
	});

	const result = await evaluatePhaseCriticalDirectives({
		directory: dir,
		phaseLabel: PHASE,
	});

	expect(result.failedClosed).toBe(false);
	expect(result.blocked).toBe(false);
	expect(result.unresolved).toEqual([]);
});

test('an unacknowledged event alone does not satisfy the terminal requirement', async () => {
	await seedRetrieved();
	await seedUnacknowledged();

	const result = await evaluatePhaseCriticalDirectives({
		directory: dir,
		phaseLabel: PHASE,
	});

	expect(result.failedClosed).toBe(false);
	expect(result.blocked).toBe(true);
	expect(result.unresolved).toEqual([
		{ id: CRITICAL_ID, reason: 'no_verdict' },
	]);
});

test('a later unacknowledged event does not remediate an earlier violation', async () => {
	await seedRetrieved();
	await appendKnowledgeEvent(dir, {
		type: 'violated',
		trace_id: 'trace-pcdg',
		knowledge_id: CRITICAL_ID,
		session_id: 'sess-pcdg',
		agent: 'coder',
		reason: 'unacknowledged',
	});
	await seedUnacknowledged();

	const result = await evaluatePhaseCriticalDirectives({
		directory: dir,
		phaseLabel: PHASE,
	});

	expect(result.blocked).toBe(true);
	expect(result.unresolved).toEqual([
		{ id: CRITICAL_ID, reason: 'unremediated_violation' },
	]);
});

test('an unacknowledged event carrying a reason is not treated like ignored/n_a+reason', async () => {
	// `ignored`/`n_a` resolve a critical when they carry a non-empty reason. The
	// unacknowledged event also carries a reason ('no_ack_marker') — it must not
	// slip through that branch on the strength of the field alone.
	await seedRetrieved();
	await seedUnacknowledged();

	const result = await evaluatePhaseCriticalDirectives({
		directory: dir,
		phaseLabel: PHASE,
	});

	expect(result.blocked).toBe(true);
	expect(result.unresolved[0]?.reason).toBe('no_verdict');
});
