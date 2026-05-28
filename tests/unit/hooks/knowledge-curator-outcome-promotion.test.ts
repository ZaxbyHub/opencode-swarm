/**
 * Verifies the event-sourced promotion gate in runAutoPromotion: an entry with a
 * clearly negative track record (ignored/contradicted/failed outcomes outweighing
 * applied/succeeded ones) must NOT auto-promote even when it has enough phase
 * confirmations, while entries with neutral or positive records promote as before.
 * Uses real temp dirs + the real store — no module mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import { runAutoPromotion } from '../../../src/hooks/knowledge-curator';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from '../../../src/hooks/knowledge-store';
import type {
	RetrievalOutcome,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';

let tempDir: string;
const config = KnowledgeConfigSchema.parse({});

const EMPTY_OUTCOMES: RetrievalOutcome = {
	applied_count: 0,
	succeeded_after_count: 0,
	failed_after_count: 0,
};

function entry(
	id: string,
	status: SwarmKnowledgeEntry['status'],
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.7,
		status,
		// Three distinct phases — satisfies the confirmation threshold on its own.
		confirmed_by: [
			{
				project_name: 'p',
				confirmed_at: '2024-01-01T00:00:00Z',
				phase_number: 1,
			},
			{
				project_name: 'p',
				confirmed_at: '2024-01-02T00:00:00Z',
				phase_number: 2,
			},
			{
				project_name: 'p',
				confirmed_at: '2024-01-03T00:00:00Z',
				phase_number: 3,
			},
		],
		retrieval_outcomes: EMPTY_OUTCOMES,
		schema_version: 2,
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		project_name: 'p',
		...overrides,
	};
}

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-outcome-promo-')),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function seedAndPromote(
	entries: SwarmKnowledgeEntry[],
): Promise<Map<string, SwarmKnowledgeEntry>> {
	const kp = resolveSwarmKnowledgePath(tempDir);
	await rewriteKnowledge(kp, entries);
	await runAutoPromotion(tempDir, config);
	const after = await readKnowledge<SwarmKnowledgeEntry>(kp);
	return new Map(after.map((e) => [e.id, e]));
}

describe('runAutoPromotion outcome gate', () => {
	test('blocks candidate->established promotion for a clearly negative track record', async () => {
		const result = await seedAndPromote([
			entry('bad', 'candidate', {
				retrieval_outcomes: {
					...EMPTY_OUTCOMES,
					ignored_count: 5,
					contradicted_count: 4,
					failed_after_shown_count: 3,
				},
			}),
			entry('good', 'candidate'), // neutral record, same 3 phases
		]);
		// Negative record blocks promotion despite 3 confirmed phases.
		expect(result.get('bad')?.status).toBe('candidate');
		// Neutral record promotes as before — proves the gate is outcome-specific.
		expect(result.get('good')?.status).toBe('established');
	});

	test('blocks established->promoted promotion for a clearly negative track record', async () => {
		const result = await seedAndPromote([
			entry('bad', 'established', {
				retrieval_outcomes: {
					...EMPTY_OUTCOMES,
					ignored_count: 6,
					contradicted_count: 4,
				},
			}),
		]);
		expect(result.get('bad')?.status).toBe('established');
	});

	test('a positive track record does not block promotion', async () => {
		const result = await seedAndPromote([
			entry('proven', 'candidate', {
				retrieval_outcomes: {
					...EMPTY_OUTCOMES,
					applied_explicit_count: 8,
					succeeded_after_shown_count: 6,
				},
			}),
		]);
		expect(result.get('proven')?.status).toBe('established');
	});

	test('a single isolated negative outcome does not block a well-confirmed entry', async () => {
		// Laplace smoothing keeps a lone negative above the block threshold.
		const result = await seedAndPromote([
			entry('one-off', 'candidate', {
				retrieval_outcomes: { ...EMPTY_OUTCOMES, contradicted_count: 1 },
			}),
		]);
		expect(result.get('one-off')?.status).toBe('established');
	});
});
