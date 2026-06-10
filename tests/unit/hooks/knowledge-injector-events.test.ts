import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import type { KnowledgeEventInput } from '../../../src/hooks/knowledge-events';
import {
	_internals,
	createKnowledgeInjectorHook,
} from '../../../src/hooks/knowledge-injector';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';

const baseConfig = KnowledgeConfigSchema.parse({});
let tempDir: string;
let originalSearch: typeof _internals.searchKnowledge;
let originalRecordEvent: typeof _internals.recordKnowledgeEvent;
let originalRecordShown: typeof _internals.recordKnowledgeShown;

function rankedEntry(
	id: string,
	overrides: Partial<RankedEntry> = {},
): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `knowledge lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [],
		project_name: 'p',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		relevanceScore: { category: 0.5, confidence: 0.9, keywords: 0 },
		finalScore: 0.9,
		...overrides,
	} as RankedEntry;
}

beforeEach(() => {
	mkdirSync('.tmp-tests', { recursive: true });
	tempDir = mkdtempSync(path.join('.tmp-tests', 'swarm-kinj-'));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	originalSearch = _internals.searchKnowledge;
	originalRecordEvent = _internals.recordKnowledgeEvent;
	originalRecordShown = _internals.recordKnowledgeShown;
});

afterEach(() => {
	_internals.searchKnowledge = originalSearch;
	_internals.recordKnowledgeEvent = originalRecordEvent;
	_internals.recordKnowledgeShown = originalRecordShown;
	rmSync(tempDir, { recursive: true, force: true });
	rmSync('.tmp-tests', { recursive: true, force: true });
});

describe('knowledge injector retrieved events', () => {
	test('emits retrieved telemetry for the final displayed IDs (no confidence pre-filter, Task 6.1)', async () => {
		let searchParams: Record<string, unknown> | undefined;
		let emittedEvent: KnowledgeEventInput | undefined;
		let shownIds: string[] | undefined;
		_internals.searchKnowledge = async (params) => {
			searchParams = params as unknown as Record<string, unknown>;
			return {
				trace_id: 'trace-final',
				results: [
					rankedEntry('shown', {
						finalScore: 0.91,
						directive_priority: 'high',
						triggers: ['continue'],
					}),
					rankedEntry('low-confidence', {
						confidence: 0.79,
						finalScore: 0.9,
					}),
				],
			};
		};
		_internals.recordKnowledgeEvent = async (_directory, event) => {
			emittedEvent = event;
			return null;
		};
		_internals.recordKnowledgeShown = async (_directory, ids) => {
			shownIds = ids;
		};

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 1200,
		});
		const output: { messages?: MessageWithParts[] } = {
			messages: [
				{
					info: {
						role: 'system',
						agent: 'architect',
						sessionID: 'session-1',
					},
					parts: [{ type: 'text', text: 'system' }],
				},
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'please continue' }],
				},
			],
		};

		await hook({}, output);

		expect(searchParams?.emitEvent).toBe(false);
		// Task 6.1 removed the injector's >=0.8 hard confidence pre-filter: a
		// low-confidence in-scope entry now participates via the hybrid score, so it
		// is displayed AND its ID appears in the telemetry alongside the high-conf
		// one. The event still reflects exactly the FINAL displayed set.
		expect(emittedEvent).toMatchObject({
			type: 'retrieved',
			trace_id: 'trace-final',
			session_id: 'session-1',
			retrieval_mode: 'auto_injection',
			result_ids: ['shown', 'low-confidence'],
		});
		expect(shownIds).toEqual(['shown', 'low-confidence']);
		const injectedText = output.messages
			?.flatMap((m) => m.parts ?? [])
			.map((p) => p.text ?? '')
			.join('\n');
		expect(injectedText).toContain('knowledge lesson shown');
		expect(injectedText).toContain('knowledge lesson low-confidence');
	});
});
