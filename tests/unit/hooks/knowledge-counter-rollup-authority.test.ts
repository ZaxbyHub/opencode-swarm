import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendKnowledgeEventsBatch,
	readAuthoritativeKnowledgeCounterRollups,
} from '../../../src/hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'knowledge-rollup-authority-'));
	writeFileSync(join(directory, '.git'), 'gitdir: fixture');
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('authoritative knowledge counter rollups', () => {
	test('diagnostic FIFO churn cannot alter ranking or curation counters', async () => {
		const displayed = await commitDisplayedMembership(directory, {
			trace_id: '00000000-0000-4000-8000-000000000001',
			session_id: 'session-1',
			phase: 'implementation',
			agent: 'architect',
			entries: [{ entry_id: 'entry-1', critical: true }],
		});
		expect(displayed.ok).toBe(true);
		const terminal = await validateAndCommitTerminalBatch(directory, {
			trace_id: '00000000-0000-4000-8000-000000000001',
			session_id: 'session-1',
			items: [{ entry_id: 'entry-1', outcome: 'applied' }],
		});
		expect(terminal.ok && terminal.rejected.length === 0).toBe(true);

		await appendKnowledgeEventsBatch(
			directory,
			Array.from({ length: 5_101 }, (_, index) => ({
				type: 'injection_skip' as const,
				event_id: `diagnostic-${index}`,
				timestamp: new Date(1_700_000_000_000 + index).toISOString(),
				reason: 'test_churn',
			})),
		);

		const rollup = (
			await readAuthoritativeKnowledgeCounterRollups(directory)
		).get('entry-1');
		expect(rollup).toMatchObject({
			shown_count: 1,
			applied_explicit_count: 1,
			ignored_count: 0,
			violated_count: 0,
		});
	});
});
