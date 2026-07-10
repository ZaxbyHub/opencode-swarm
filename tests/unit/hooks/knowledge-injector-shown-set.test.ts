/**
 * Issue #1768 — shown-set integrity tests.
 *
 * Pins the contract that the architect auto-injection path records the FINAL
 * rendered set (≤ max_inject_count) under the canonical `Phase N` key — NOT the
 * widened pre-rerank pool (~20 ids) that the old readMergedKnowledge side effect
 * recorded. Also pins the union-merge semantics so concurrent architect +
 * delegate writes within a phase do not clobber each other.
 *
 * Pattern (AGENTS.md invariant 7): bun:test, real temp dirs via os.tmpdir +
 * path.join, `_internals` DI seams (no mock.module leakage), restore in
 * afterEach. Follows knowledge-injector-events.test.ts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
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
let originalRecordLessonsShown: typeof _internals.recordLessonsShown;
let originalConfirmEntriesPhase: typeof _internals.confirmEntriesPhase;

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
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-shown-'));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	swarmState.currentCriticalShownIds.clear();
	originalSearch = _internals.searchKnowledge;
	originalRecordEvent = _internals.recordKnowledgeEvent;
	originalRecordShown = _internals.recordKnowledgeShown;
	originalRecordLessonsShown = _internals.recordLessonsShown;
	originalConfirmEntriesPhase = _internals.confirmEntriesPhase;
});

afterEach(() => {
	_internals.searchKnowledge = originalSearch;
	_internals.recordKnowledgeEvent = originalRecordEvent;
	_internals.recordKnowledgeShown = originalRecordShown;
	_internals.recordLessonsShown = originalRecordLessonsShown;
	_internals.confirmEntriesPhase = originalConfirmEntriesPhase;
	swarmState.currentCriticalShownIds.clear();
	rmSync(tempDir, { recursive: true, force: true });
});

function architectOutput(userText = 'please continue'): {
	messages?: MessageWithParts[];
} {
	return {
		messages: [
			{
				info: { role: 'system', agent: 'architect', sessionID: 's-1' },
				parts: [{ type: 'text', text: 'system' }],
			},
			{
				info: { role: 'user' },
				parts: [{ type: 'text', text: userText }],
			},
		],
	};
}

const shownFile = (dir: string) =>
	path.join(dir, '.swarm', '.knowledge-shown.json');

describe('knowledge injector shown-set integrity (#1768)', () => {
	test('records exactly the FINAL rendered set under canonical Phase N', async () => {
		// The injector renders what searchKnowledge returns (searchKnowledge is
		// responsible for narrowing to max_inject_count via MMR). The injector
		// must record EXACTLY those rendered ids under "Phase N" — this is the
		// set updateRetrievalOutcome will later attribute the phase outcome to.
		// (The widened-pool pollution itself is pinned in knowledge-reader.test.ts
		// Test 9b: readMergedKnowledge no longer writes the shown file at all.)
		const rendered = [
			rankedEntry('r-1', { finalScore: 0.9 }),
			rankedEntry('r-2', { finalScore: 0.8 }),
		];
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-1',
			results: rendered,
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		_internals.confirmEntriesPhase = async () => {};

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 4000, // generous so nothing is budget-trimmed
		});
		await hook({}, architectOutput());

		// Drain fire-and-forget recordLessonsShown.
		await new Promise((r) => setTimeout(r, 10));

		const data = JSON.parse(
			readFileSync(shownFile(tempDir), 'utf-8'),
		) as Record<string, string[]>;
		expect(data['Phase 1']).toBeDefined();
		// Exactly the rendered ids — no more, no less.
		expect(data['Phase 1'].sort()).toEqual(['r-1', 'r-2']);
	});

	test('union-merges Phase N so concurrent architect+delegate writes do not clobber', async () => {
		// Pre-seed the shown file with a delegate-style write for Phase 1.
		writeFileSync(
			shownFile(tempDir),
			JSON.stringify({ 'Phase 1': ['del-A', 'del-B'] }),
		);

		// Architect injection adds its own ids.
		_internals.searchKnowledge = async () => ({
			trace_id: 'trace-2',
			results: [rankedEntry('arch-1'), rankedEntry('arch-2')],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		_internals.confirmEntriesPhase = async () => {};

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 4000,
		});
		await hook({}, architectOutput());
		await new Promise((r) => setTimeout(r, 10));

		const data = JSON.parse(
			readFileSync(shownFile(tempDir), 'utf-8'),
		) as Record<string, string[]>;
		// UNION, not overwrite: the delegate ids survive alongside the architect ids.
		expect(data['Phase 1']).toEqual(
			expect.arrayContaining(['del-A', 'del-B', 'arch-1', 'arch-2']),
		);
		expect(data['Phase 1'].length).toBe(4);
	});

	test('does not call recordLessonsShown when no entries are rendered', async () => {
		_internals.searchKnowledge = async () => ({ trace_id: 't', results: [] });
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		const lessonsSpy = mock(async () => {});
		_internals.recordLessonsShown = lessonsSpy;

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
		});
		await hook({}, architectOutput());
		await new Promise((r) => setTimeout(r, 10));

		expect(lessonsSpy).not.toHaveBeenCalled();
	});

	test('architect path calls confirmEntriesPhase with the rendered ids + phase number', async () => {
		// Coverage gap from the implementation review: pin that the ARCHITECT path
		// (not just the delegate path) resolves and passes the correct integer
		// phaseNumber. With no plan file, current_phase defaults to 1.
		const confirmSpy = mock(async () => {});
		_internals.searchKnowledge = async () => ({
			trace_id: 't',
			results: [rankedEntry('a-1'), rankedEntry('a-2')],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		_internals.recordLessonsShown = async () => {};
		_internals.confirmEntriesPhase = confirmSpy;

		const hook = createKnowledgeInjectorHook(tempDir, {
			...baseConfig,
			enabled: true,
			inject_char_budget: 4000,
		});
		await hook({}, architectOutput());
		await new Promise((r) => setTimeout(r, 10));

		expect(confirmSpy).toHaveBeenCalledTimes(1);
		const args = confirmSpy.mock.calls[0];
		expect(args[0]).toBe(tempDir); // directory
		expect(args[1]).toEqual(['a-1', 'a-2']); // rendered ids
		expect(args[2]).toBe(1); // phaseNumber: default current_phase (no plan) = 1
		expect(typeof args[3]).toBe('string'); // projectName
	});
});
