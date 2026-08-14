import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledge_recall } from '../../../src/tools/knowledge-recall';

describe('knowledge_recall authoritative membership ordering', () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'knowledge-recall-receipt-'));
		const swarm = join(directory, '.swarm');
		mkdirSync(swarm, { recursive: true });
		writeFileSync(
			join(swarm, 'knowledge.jsonl'),
			`${JSON.stringify({
				id: 'manual-result',
				tier: 'swarm',
				lesson: 'always validate manual retrieval results',
				category: 'process',
				tags: ['validate', 'manual', 'retrieval'],
				scope: 'global',
				confidence: 0.9,
				status: 'established',
				confirmed_by: [],
				project_name: 'test',
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			})}\n`,
		);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	test('returns no results when receipt membership cannot be persisted', async () => {
		mkdirSync(join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'));

		const raw = await knowledge_recall.execute(
			{ query: 'validate manual retrieval' },
			{ directory, sessionID: 'manual-session', agent: 'architect' },
		);
		const result = JSON.parse(raw);

		expect(result.results).toEqual([]);
		expect(result.total).toBe(0);
		expect(result.unverifiable).toBe(true);
		expect(result.code).toBe('store_unavailable');
	});
});
