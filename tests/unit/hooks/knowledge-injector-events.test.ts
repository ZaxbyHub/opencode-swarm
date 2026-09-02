import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import { closeProjectDb } from '../../../src/db/project-db.js';
import type { KnowledgeEventInput } from '../../../src/hooks/knowledge-events';
import {
	_internals,
	createKnowledgeInjectorHook,
} from '../../../src/hooks/knowledge-injector';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader';
import { validateAndCommitTerminalBatch } from '../../../src/hooks/knowledge-receipt-ledger';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { loadPromotionEvidenceByEntry } from '../../../src/hooks/promotion-evidence-store';
import { ensureAgentSession, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const baseConfig = KnowledgeConfigSchema.parse({});
const SESSION = 'session-1';
let tempDir: string;
let originalSearch: typeof _internals.searchKnowledge;
let originalRecordEvent: typeof _internals.recordKnowledgeEvent;
let originalRecordShown: typeof _internals.recordKnowledgeShown;
// Platform-root redirection (issue #2033): tests that write `.swarm/link.json` pointers make
// link-aware event writes resolve the link dir via resolveDataDir(); without redirecting
// LOCALAPPDATA/XDG_DATA_HOME/HOME on Windows those writes landed in the REAL
// `.../opencode-swarm/Data/links/linked-worktree/` store (proven 2026-08-15).
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;

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
	tempDir = canonicalMkdtemp('swarm-kinj-');
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	prevXdg = process.env.XDG_DATA_HOME;
	prevHome = process.env.HOME;
	prevLocalAppData = process.env.LOCALAPPDATA;
	process.env.XDG_DATA_HOME = tempDir;
	process.env.HOME = tempDir;
	process.env.LOCALAPPDATA = tempDir;
	swarmState.currentCriticalShownIds.clear();
	swarmState.activeAgent.delete(SESSION);
	originalSearch = _internals.searchKnowledge;
	originalRecordEvent = _internals.recordKnowledgeEvent;
	originalRecordShown = _internals.recordKnowledgeShown;
});

afterEach(() => {
	_internals.searchKnowledge = originalSearch;
	_internals.recordKnowledgeEvent = originalRecordEvent;
	_internals.recordKnowledgeShown = originalRecordShown;
	if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevXdg;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = prevLocalAppData;
	swarmState.currentCriticalShownIds.clear();
	swarmState.activeAgent.delete(SESSION);
	swarmState.agentSessions.delete(SESSION);
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true }); // #2480
});

describe('knowledge injector retrieved events', () => {
	function outputForUser(text: string): { messages?: MessageWithParts[] } {
		// (#1849) Drive identity via swarmState.activeAgent (the production path)
		// and stamp a consistent sessionID on every message.
		swarmState.activeAgent.set(SESSION, 'architect');
		return {
			messages: [
				{
					info: {
						role: 'system',
						agent: 'architect',
						sessionID: SESSION,
					},
					parts: [{ type: 'text', text: 'system' }],
				},
				{
					info: { role: 'user', sessionID: SESSION },
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
		swarmState.activeAgent.set(SESSION, 'architect');
		const output: { messages?: MessageWithParts[] } = {
			messages: [
				{
					info: {
						role: 'system',
						agent: 'architect',
						sessionID: SESSION,
					},
					parts: [{ type: 'text', text: 'system' }],
				},
				{
					info: { role: 'user', sessionID: SESSION },
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

	test('fails closed before displaying when authoritative membership cannot persist', async () => {
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-store-failure',
			results: [rankedEntry('must-not-display')],
		});
		mkdirSync(path.join(tempDir, '.swarm', 'knowledge-receipts-v2.jsonl'));
		const output = outputForUser('surface knowledge');

		await createKnowledgeInjectorHook(tempDir, baseConfig)({}, output);

		const text = output.messages
			?.flatMap((message) => message.parts ?? [])
			.map((part) => part.text ?? '')
			.join('\n');
		expect(text).not.toContain('must-not-display');
		expect(swarmState.currentCriticalShownIds.has(SESSION)).toBe(false);
	});

	test('does not re-expose a cached directive after its exact pair terminalizes', async () => {
		let searches = 0;
		_internals.searchKnowledge = async () => {
			searches++;
			return {
				trace_id: 'trace-cache-terminal',
				results: [rankedEntry('terminalized-entry')],
			};
		};
		const hook = createKnowledgeInjectorHook(tempDir, baseConfig);
		await hook({}, outputForUser('same request'));
		const terminal = await validateAndCommitTerminalBatch(tempDir, {
			trace_id: 'trace-cache-terminal',
			session_id: SESSION,
			items: [
				{
					entry_id: 'terminalized-entry',
					outcome: 'applied',
					source: 'test',
				},
			],
		});
		expect(terminal.ok).toBe(true);

		const repeated = outputForUser('same request');
		await hook({}, repeated);

		const repeatedText = repeated.messages
			?.flatMap((message) => message.parts ?? [])
			.map((part) => part.text ?? '')
			.join('\n');
		expect(searches).toBe(2);
		expect(repeatedText).not.toContain('terminalized-entry');
	});

	test('preserves architect display lineage through a promotion-eligible terminal (#2031)', async () => {
		// Regression finding #2031-W1. Falsification: removing either display-time
		// lineage field makes the authoritative promotion reader return no record.
		ensureAgentSession(SESSION, 'architect').cachedCohortId =
			'cohort-architect';
		writeFileSync(
			path.join(tempDir, '.swarm', 'link.json'),
			JSON.stringify({ version: 2, linkId: 'linked-worktree' }),
		);
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-architect-lineage',
			results: [rankedEntry('architect-lineage')],
		});

		await createKnowledgeInjectorHook(tempDir, baseConfig)(
			{},
			outputForUser('apply the directive'),
		);
		const terminal = await validateAndCommitTerminalBatch(tempDir, {
			trace_id: 'trace-architect-lineage',
			session_id: SESSION,
			items: [
				{
					entry_id: 'architect-lineage',
					outcome: 'applied',
					source: 'architect_marker',
				},
			],
		});
		expect(terminal.ok).toBe(true);

		const evidence = await loadPromotionEvidenceByEntry(
			tempDir,
			'cohort-architect',
		);
		expect(evidence['architect-lineage']?.[0]).toMatchObject({
			cohort_id: 'cohort-architect',
			source_link_id: 'linked-worktree',
			retrieval_trace_id: 'trace-architect-lineage',
			receipt_outcome: 'applied',
		});
	});
});
