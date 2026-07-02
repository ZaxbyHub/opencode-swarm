import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import type { KnowledgeEventInput } from '../../../src/hooks/knowledge-events';
import {
	_internals,
	createKnowledgeInjectorHook,
} from '../../../src/hooks/knowledge-injector';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { swarmState } from '../../../src/state';

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
	swarmState.currentCriticalShownIds.clear();
	originalSearch = _internals.searchKnowledge;
	originalRecordEvent = _internals.recordKnowledgeEvent;
	originalRecordShown = _internals.recordKnowledgeShown;
});

afterEach(() => {
	_internals.searchKnowledge = originalSearch;
	_internals.recordKnowledgeEvent = originalRecordEvent;
	_internals.recordKnowledgeShown = originalRecordShown;
	swarmState.currentCriticalShownIds.clear();
	rmSync(tempDir, { recursive: true, force: true });
	rmSync('.tmp-tests', { recursive: true, force: true });
});

describe('knowledge injector retrieved events', () => {
	function outputForUser(text: string): { messages?: MessageWithParts[] } {
		return {
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
					parts: [{ type: 'text', text }],
				},
			],
		};
	}

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

	test('uses configured model limit overrides for residual headroom checks', async () => {
		let searchCalled = false;
		_internals.searchKnowledge = async () => {
			searchCalled = true;
			return {
				trace_id: 'trace-skipped',
				results: [rankedEntry('should-not-show')],
			};
		};
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};

		const hook = createKnowledgeInjectorHook(
			tempDir,
			{
				...baseConfig,
				enabled: true,
				context_budget_threshold: 300,
			},
			{ 'test-provider/tiny-model': 1000 },
		);
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
					info: {
						role: 'assistant',
						modelID: 'tiny-model',
						providerID: 'test-provider',
					},
					// The configured override is 1000 tokens, or roughly 3030 chars.
					// A 4000-char message only trips the residual-headroom guard when
					// the override is used instead of the default model limit.
					parts: [{ type: 'text', text: 'x'.repeat(4000) }],
				},
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'please continue' }],
				},
			],
		};

		await hook({}, output);

		expect(searchCalled).toBe(false);
		expect(output.messages).toHaveLength(3);
	});

	test('regression INJ-001: changed user message invalidates cached injection', async () => {
		const calls: string[] = [];
		_internals.searchKnowledge = async (params) => {
			calls.push(params.context.lastUserMessage ?? '');
			return {
				trace_id: `trace-${calls.length}`,
				results: [
					rankedEntry(`shown-${calls.length}`, {
						lesson: `lesson for ${params.context.lastUserMessage}`,
					}),
				],
			};
		};
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 1200,
		});

		const first = outputForUser('first request');
		await hook({}, first);
		const second = outputForUser('second request');
		await hook({}, second);

		expect(calls).toEqual(['first request', 'second request']);
		const injectedText = second.messages
			?.flatMap((m) => m.parts ?? [])
			.map((p) => p.text ?? '')
			.join('\n');
		expect(injectedText).toContain('lesson for second request');
		expect(injectedText).not.toContain('lesson for first request');
	});

	test('regression INJ-002: critical gate IDs come only from rendered directive records', async () => {
		let shownIds: string[] | undefined;
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-trimmed',
			results: [
				rankedEntry('crit-visible', {
					directive_priority: 'critical',
					triggers: ['save'],
					required_actions: ['ack visible'],
				}),
				rankedEntry('crit-trimmed', {
					directive_priority: 'critical',
					triggers: ['save'],
					required_actions: ['ack trimmed'],
				}),
			],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async (_directory, ids) => {
			shownIds = ids;
		};

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 500,
			max_lesson_display_chars: 40,
		});
		const output = outputForUser('please save');

		await hook({}, output);

		const injectedText = output.messages
			?.flatMap((m) => m.parts ?? [])
			.map((p) => p.text ?? '')
			.join('\n');
		expect(injectedText).toContain('- id: crit-visible');
		expect(injectedText).not.toContain('- id: crit-trimmed');
		expect(shownIds).toContain('crit-visible');
		const criticalState = swarmState.currentCriticalShownIds.get('session-1');
		expect(criticalState?.ids).toEqual(['crit-visible']);
	});

	test('regression INJ-002b: truncated lesson-block entries still count as shown', async () => {
		let shownIds: string[] | undefined;
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-truncated-lesson',
			results: [
				rankedEntry('long-lesson', {
					lesson: 'abcdefghij1234567890 extra lesson detail',
				}),
			],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async (_directory, ids) => {
			shownIds = ids;
		};

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 1200,
			max_lesson_display_chars: 10,
		});
		const output = outputForUser('surface lesson');

		await hook({}, output);

		const injectedText = output.messages
			?.flatMap((m) => m.parts ?? [])
			.map((p) => p.text ?? '')
			.join('\n');
		expect(injectedText).toContain('[S] abcdefghij');
		expect(shownIds).toEqual(['long-lesson']);
	});

	test('regression INJ-003: preamble-only injection clears stale critical gate IDs', async () => {
		swarmState.currentCriticalShownIds.set('session-1', {
			ids: ['stale-critical'],
			generatedAt: Date.now(),
		});
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-empty',
			results: [],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		writeFileSync(
			path.join(tempDir, '.swarm', 'curator-briefing.md'),
			'briefing only',
			'utf-8',
		);

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 1200,
		});

		await hook({}, outputForUser('empty retrieval'));

		expect(swarmState.currentCriticalShownIds.has('session-1')).toBe(false);
	});
});
