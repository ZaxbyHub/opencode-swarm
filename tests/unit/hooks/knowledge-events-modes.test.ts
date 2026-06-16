/**
 * Tests that the `delegate_inject` retrieval mode (Change 1 / Task 1.2) is a
 * first-class RetrievalEventMode: it round-trips through the append/read event
 * log and its result_ids feed the deterministic counter rollup exactly like the
 * other retrieval modes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendKnowledgeEvent,
	type RetrievalEventMode,
	readKnowledgeEvents,
	recomputeCounters,
} from '../../../src/hooks/knowledge-events.js';

describe('delegate_inject retrieval mode', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ke-modes-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('is accepted by the type system as a RetrievalEventMode', () => {
		const modes: RetrievalEventMode[] = [
			'manual',
			'auto_injection',
			'coder_context',
			'review_context',
			'curator',
			'delegate_inject',
		];
		expect(modes).toContain('delegate_inject');
	});

	it('round-trips a delegate_inject retrieved event through the log', async () => {
		await appendKnowledgeEvent(tempDir, {
			type: 'retrieved',
			trace_id: 'trace-1',
			session_id: 'sess-1',
			agent: 'coder',
			query: 'implement the feature',
			retrieval_mode: 'delegate_inject',
			result_ids: ['k-1', 'k-2'],
			ranks: { 'k-1': 1, 'k-2': 2 },
			scores: { 'k-1': 0.9, 'k-2': 0.8 },
		});

		const events = await readKnowledgeEvents(tempDir);
		expect(events.length).toBe(1);
		const ev = events[0];
		if (ev.type !== 'retrieved') throw new Error('expected retrieved');
		expect(ev.retrieval_mode).toBe('delegate_inject');
		expect(ev.agent).toBe('coder');
		expect(ev.result_ids).toEqual(['k-1', 'k-2']);
	});

	it('counts delegate_inject result_ids in the shown_count rollup', async () => {
		await appendKnowledgeEvent(tempDir, {
			type: 'retrieved',
			trace_id: 'trace-2',
			session_id: 'sess-2',
			agent: 'reviewer',
			query: 'review',
			retrieval_mode: 'delegate_inject',
			result_ids: ['k-9'],
			ranks: { 'k-9': 1 },
			scores: { 'k-9': 0.7 },
		});

		const events = await readKnowledgeEvents(tempDir);
		const rollup = recomputeCounters(events);
		expect(rollup.get('k-9')?.shown_count).toBe(1);
	});
});
