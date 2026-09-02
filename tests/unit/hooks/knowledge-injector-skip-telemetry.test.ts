/**
 * Issue #1768 / #1849 — injection_skip reason telemetry tests.
 *
 * Every silent early-return in the architect auto-injection path emits a
 * structured `injection_skip` event so the dead-path cause is diagnosable from
 * `.swarm/knowledge-events.jsonl`. These tests pin one event per reason.
 *
 * (#1849) Identity is no longer recovered from a `role:'system'` message (the
 * SDK Message union has no system variant). It comes from
 * `swarmState.activeAgent` (primary, set by chat.message) with the last user
 * message's `info.agent` as a first-turn fallback. Fixtures set
 * `swarmState.activeAgent` instead of a system message.
 *
 * Pattern (AGENTS.md invariant 7): bun:test, real temp dirs, `_internals` DI
 * seams, restore in afterEach. No mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import { closeProjectDb } from '../../../src/db/project-db.js';
import type { KnowledgeEventInput } from '../../../src/hooks/knowledge-events';
import {
	_internals,
	createKnowledgeInjectorHook,
} from '../../../src/hooks/knowledge-injector';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { setLiveContextWindow, swarmState } from '../../../src/state';
import { installKnowledgeReceiptAuthorityStub } from '../../helpers/knowledge-receipt-authority.js';
import { waitFor } from '../../helpers/wait-for';

const baseConfig = KnowledgeConfigSchema.parse({});
let tempDir: string;
let originalRecordEvent: typeof _internals.recordKnowledgeEvent;
let originalSearch: typeof _internals.searchKnowledge;
let originalRecordShown: typeof _internals.recordKnowledgeShown;
let originalRecordLessonsShown: typeof _internals.recordLessonsShown;
let originalConfirmEntriesPhase: typeof _internals.confirmEntriesPhase;
let restoreReceiptAuthority = () => {};
const SESSION = 's';

function output(messages: MessageWithParts[]): {
	messages?: MessageWithParts[];
} {
	return { messages };
}

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-skip-'));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	swarmState.currentCriticalShownIds.clear();
	swarmState.activeAgent.delete(SESSION);
	swarmState.liveContextWindows.delete(SESSION);
	originalRecordEvent = _internals.recordKnowledgeEvent;
	originalSearch = _internals.searchKnowledge;
	originalRecordShown = _internals.recordKnowledgeShown;
	originalRecordLessonsShown = _internals.recordLessonsShown;
	originalConfirmEntriesPhase = _internals.confirmEntriesPhase;
	restoreReceiptAuthority = installKnowledgeReceiptAuthorityStub(_internals);
});

afterEach(() => {
	restoreReceiptAuthority();
	_internals.recordKnowledgeEvent = originalRecordEvent;
	_internals.searchKnowledge = originalSearch;
	_internals.recordKnowledgeShown = originalRecordShown;
	_internals.recordLessonsShown = originalRecordLessonsShown;
	_internals.confirmEntriesPhase = originalConfirmEntriesPhase;
	swarmState.currentCriticalShownIds.clear();
	swarmState.activeAgent.delete(SESSION);
	swarmState.liveContextWindows.delete(SESSION);
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true }); // #2480
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

describe('knowledge injector injection_skip telemetry (#1768/#1849)', () => {
	test('headroom_budget: emits skip when context headroom is below threshold', async () => {
		const { events } = captureEvents();
		swarmState.activeAgent.set(SESSION, 'architect');
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
						role: 'assistant',
						modelID: 'tiny',
						providerID: 'test-provider',
						sessionID: SESSION,
					},
					parts: [{ type: 'text', text: big }],
				},
				{
					info: { role: 'user', agent: 'architect', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('headroom_budget');
		expect(skips[0].detail).toMatchObject({ modelID: 'tiny' });
		// Headroom-attribution fix: identity is now resolved BEFORE the headroom
		// gate, so a recoverable session must carry agent/session_id on the event
		// instead of firing anonymously (2,063 anonymous events in production —
		// see knowledge-injector.ts headroom gate comment).
		expect(skips[0].agent).toBe('architect');
		expect(skips[0].session_id).toBe(SESSION);
	});

	test('headroom_budget: first-turn handoff uses the incoming live model identity', async () => {
		const { events } = captureEvents();
		swarmState.activeAgent.set(SESSION, 'architect');
		setLiveContextWindow(SESSION, 1_000_000, {
			modelID: 'incoming-million',
			providerID: 'test-provider',
		});
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			context_budget_threshold: 300,
		});
		await hook(
			{},
			output([
				{
					info: {
						role: 'assistant',
						modelID: 'claude-sonnet-4-5',
						providerID: 'anthropic',
						sessionID: SESSION,
					},
					parts: [{ type: 'text', text: 'x'.repeat(700_000) }],
				},
				{
					info: { role: 'user', agent: 'architect', sessionID: SESSION },
					parts: [{ type: 'text', text: 'continue' }],
				},
			]),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));

		// The outgoing assistant's 200k static limit would make headroom negative.
		// The incoming 1M live window leaves ample room, so this gate must not fire.
		expect(
			skipEvents(events).some((event) => event.reason === 'headroom_budget'),
		).toBe(false);
	});

	test('headroom_budget: still emits (fields absent, no regression) when identity is unrecoverable', async () => {
		const { events } = captureEvents();
		// Deliberately do NOT set swarmState.activeAgent and provide no user
		// message carrying info.agent — identity cannot be resolved.
		const hook = createKnowledgeInjectorHook(
			tempDir,
			{ ...baseConfig, enabled: true, context_budget_threshold: 300 },
			{ 'test-provider/tiny': 100 },
		);
		const big = 'x'.repeat(2000);
		await hook(
			{},
			output([
				{
					info: {
						role: 'assistant',
						modelID: 'tiny',
						providerID: 'test-provider',
						sessionID: SESSION,
					},
					parts: [{ type: 'text', text: big }],
				},
				{
					info: { role: 'user', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('headroom_budget');
		expect(skips[0].agent).toBeUndefined();
		// sessionID IS recoverable here (every message carries info.sessionID
		// regardless of agent identity), so only `agent` is expected absent.
		expect(skips[0].session_id).toBe(SESSION);
	});

	test('no_agent_name: emits skip when no activeAgent AND no user message carries agent', async () => {
		const { events } = captureEvents();
		// Deliberately do NOT set swarmState.activeAgent and provide a user
		// message with no info.agent. The adapter cannot resolve identity.
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'user', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('no_agent_name');
	});

	test('not_architect: emits skip for an unrecognized non-delegate agent', async () => {
		const { events } = captureEvents();
		swarmState.activeAgent.set(SESSION, 'mystery_role');
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'user', agent: 'mystery_role', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
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
		swarmState.activeAgent.set(SESSION, 'architect');
		_internals.searchKnowledge = async () => ({ trace_id: 't', results: [] });
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'user', agent: 'architect', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('no_matching_entries');
	});

	test('(#1849) empty retrieval also emits a no_relevant terminal (every retrieval accounted for)', async () => {
		const { events } = captureEvents();
		swarmState.activeAgent.set(SESSION, 'architect');
		_internals.searchKnowledge = async () => ({ trace_id: 't', results: [] });
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'user', agent: 'architect', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
			]),
		);
		await new Promise((r) => setTimeout(r, 5));

		// Empty architect retrieval now files a retrieved(empty) + no_relevant.
		const retrieved = events.filter((e) => e.type === 'retrieved');
		expect(retrieved).toHaveLength(1);
		expect(retrieved[0].result_ids).toEqual([]);
		const noRelevant = events.filter((e) => e.type === 'no_relevant');
		expect(noRelevant).toHaveLength(1);
		expect(noRelevant[0].trace_id).toBe('t');
	});

	test('injection_skip events round-trip to disk and are a no-op in counter replay', async () => {
		// The skip event must persist to knowledge-events.jsonl and not break
		// recomputeCounters (it has no case for it → safely skipped).
		const eventsPath = path.join(tempDir, '.swarm', 'knowledge-events.jsonl');
		// Use the REAL recordKnowledgeEvent (writes the file) for this one test.
		_internals.recordKnowledgeEvent = originalRecordEvent;
		_internals.recordKnowledgeShown = async () => {};
		// Drive the no_agent_name skip (no activeAgent, no user-message agent).
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook(
			{},
			output([
				{
					info: { role: 'user', sessionID: SESSION },
					parts: [{ type: 'text', text: 'go' }],
				},
			]),
		);
		// The record is fire-and-forget: poll for the flush instead of a
		// fixed sleep (a 20ms sleep raced the write and failed attempt-1 on
		// cold windows-latest runners — issue #2477 flake family).
		await waitFor(
			() => existsSync(eventsPath) && statSync(eventsPath).size > 0,
			2000,
			'injection_skip event to flush to disk',
		);

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

describe('knowledge injector no_messages skip (#2044 item 4)', () => {
	test('an empty message surface emits a skip with an explicit missing reason', async () => {
		const { events } = captureEvents();
		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook({}, output([]));
		await new Promise((r) => setTimeout(r, 5));

		const skips = skipEvents(events);
		expect(skips.length).toBe(1);
		expect(skips[0].reason).toBe('no_messages');
		expect(skips[0].detail).toMatchObject({
			context: { missing: ['messages'] },
		});
	});
});
