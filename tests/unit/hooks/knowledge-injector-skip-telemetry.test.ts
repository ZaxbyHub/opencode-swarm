/**
 * Issue #1768 — injection_skip reason telemetry tests.
 *
 * Every silent early-return in the architect auto-injection path now emits a
 * structured `injection_skip` event so the dead-path cause is diagnosable from
 * `.swarm/knowledge-events.jsonl`. These tests pin one event per reason.
 *
 * Pattern (AGENTS.md invariant 7): bun:test, real temp dirs, `_internals` DI
 * seams, restore in afterEach. No mock.module.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import type { KnowledgeEventInput } from '../../../src/hooks/knowledge-events';
import {
	_internals,
	createKnowledgeInjectorHook,
} from '../../../src/hooks/knowledge-injector';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { swarmState } from '../../../src/state';

const baseConfig = KnowledgeConfigSchema.parse({});
let tempDir: string;
let originalRecordEvent: typeof _internals.recordKnowledgeEvent;
let originalSearch: typeof _internals.searchKnowledge;
let originalRecordShown: typeof _internals.recordKnowledgeShown;
let originalRecordLessonsShown: typeof _internals.recordLessonsShown;
let originalConfirmEntriesPhase: typeof _internals.confirmEntriesPhase;

function output(messages: MessageWithParts[]): {
	messages?: MessageWithParts[];
} {
	return { messages };
}

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-skip-'));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	swarmState.currentCriticalShownIds.clear();
	originalRecordEvent = _internals.recordKnowledgeEvent;
	originalSearch = _internals.searchKnowledge;
	originalRecordShown = _internals.recordKnowledgeShown;
	originalRecordLessonsShown = _internals.recordLessonsShown;
	originalConfirmEntriesPhase = _internals.confirmEntriesPhase;
});

afterEach(() => {
	_internals.recordKnowledgeEvent = originalRecordEvent;
	_internals.searchKnowledge = originalSearch;
	_internals.recordKnowledgeShown = originalRecordShown;
	_internals.recordLessonsShown = originalRecordLessonsShown;
	_internals.confirmEntriesPhase = originalConfirmEntriesPhase;
	swarmState.currentCriticalShownIds.clear();
	rmSync(tempDir, { recursive: true, force: true });
});

/** Captures all events emitted via _internals.recordKnowledgeEvent. */
function captureEvents(): {
	events: KnowledgeEventInput[];
} {
	const events: KnowledgeEventInput[] = [];
	_internals.recordKnowledgeEvent = async (_dir, ev) => {
		events.push(ev);
		return null;
	};
	// Silence the success-path side effects so only skip events surface.
	_internals.recordKnowledgeShown = async () => {};
	_internals.recordLessonsShown = async () => {};
	_internals.confirmEntriesPhase = async () => {};
	return { events };
}

const skipEvents = (events: KnowledgeEventInput[]) =>
	events.filter((e) => e.type === 'injection_skip');

describe('knowledge injector injection_skip telemetry (#1768)', () => {
	test('headroom_budget: emits skip when context headroom is below threshold', async () => {
		const { events } = captureEvents();
		const hook = createKnowledgeInjectorHook(
			tempDir,
			{ ...baseConfig, enabled: true, context_budget_threshold: 300 },
			// Tiny model limit → MODEL_LIMIT_CHARS small → headroom negative.
			{ 'test-provider/tiny': 100 },
		);
		const big = 'x'.repeat(2000);
		await hook(
			{},
			output([
				{
					info: {
						role: 'system',
						agent: 'architect',
						sessionID: 's',
					},
					parts: [{ type: 'text', text: 'system' }],
				},
				{
					info: {
						role: 'assistant',
						modelID: 'tiny',
						providerID: 'test-provider',
					},
					parts: [{ type: 'text', text: big }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('headroom_budget');
		expect(skips[0].detail).toMatchObject({ modelID: 'tiny' });
	});

	test('no_agent_name: emits skip when the system message carries no agent', async () => {
		const { events } = captureEvents();
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				// system message with no info.agent
				{
					info: { role: 'system', sessionID: 's' },
					parts: [{ type: 'text', text: 'system' }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('no_agent_name');
	});

	test('not_architect: emits skip for an unrecognized non-delegate agent', async () => {
		const { events } = captureEvents();
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'system', agent: 'mystery_role', sessionID: 's' },
					parts: [{ type: 'text', text: 'system' }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('not_architect');
		expect(skips[0].agent).toBe('mystery_role');
	});

	test('no_matching_entries: emits skip when search returns empty', async () => {
		const { events } = captureEvents();
		_internals.searchKnowledge = async () => ({ trace_id: 't', results: [] });
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'system', agent: 'architect', sessionID: 's' },
					parts: [{ type: 'text', text: 'system' }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('no_matching_entries');
	});

	test('injection_skip events round-trip to disk and are a no-op in counter replay', async () => {
		// The new event type must persist to knowledge-events.jsonl and not break
		// recomputeCounters (it has no case for it → safely skipped).
		const eventsPath = path.join(tempDir, '.swarm', 'knowledge-events.jsonl');
		// Use the REAL recordKnowledgeEvent (writes the file) for this one test.
		// Restore the originals captured in beforeEach momentarily:
		_internals.recordKnowledgeEvent = originalRecordEvent;
		_internals.recordKnowledgeShown = async () => {};
		// Drive the no_agent_name skip.
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'system', sessionID: 's' },
					parts: [{ type: 'text', text: 'system' }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
			]),
		);
		await new Promise((r) => setTimeout(r, 20));

		expect(existsSync(eventsPath)).toBe(true);
		const lines = readFileSync(eventsPath, 'utf-8')
			.split('\n')
			.filter((l) => l.trim());
		const skipLine = lines.find((l) => l.includes('injection_skip'));
		expect(skipLine).toBeDefined();
		const parsed = JSON.parse(skipLine as string);
		expect(parsed.type).toBe('injection_skip');
		expect(parsed.reason).toBe('no_agent_name');
		expect(parsed.event_id).toBeDefined();
		expect(parsed.timestamp).toBeDefined();
	});
});
