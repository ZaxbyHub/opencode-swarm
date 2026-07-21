/**
 * Issue #1768 — delegate injection outcome-attribution tests.
 *
 * The delegate path (injectForDelegate) previously recorded only a `retrieved`
 * event under the raw task title, so updateRetrievalOutcome (which only looks up
 * canonical `Phase N` keys) never attributed outcomes to delegate-shown
 * knowledge. Now, when a canonical `phase` label is passed, the delegate path
 * records under `Phase N` (union-merged), bumps shown_count, and confirms the
 * phase — eliminating orphaned task-title keys.
 *
 * Pattern: bun:test, real temp dirs, `_internals` DI seams, restore in afterEach.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import {
	_internals,
	injectForDelegate,
} from '../../../src/hooks/knowledge-injector';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types';

const baseConfig = KnowledgeConfigSchema.parse({});
let tempDir: string;
let originalSearch: typeof _internals.searchKnowledge;
let originalRecordEvent: typeof _internals.recordKnowledgeEvent;
let originalRecordShown: typeof _internals.recordKnowledgeShown;
let originalRecordLessonsShown: typeof _internals.recordLessonsShown;
let originalConfirmEntriesPhase: typeof _internals.confirmEntriesPhase;

function entry(id: string): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `delegate lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
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
		relevanceScore: { category: 0.5, confidence: 0.8, keywords: 0 },
		finalScore: 0.8,
		// Make it pass the delegate scope filter (applies_to_tools).
		applies_to_tools: ['edit'],
	} as RankedEntry;
}

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-delegate-'));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
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
	rmSync(tempDir, { recursive: true, force: true });
});

const shownFile = (dir: string) =>
	path.join(dir, '.swarm', '.knowledge-shown.json');

function captureShownWrite(): () => Promise<void> {
	const pendingWrites: Promise<void>[] = [];
	_internals.recordLessonsShown = (...args) => {
		const pending = originalRecordLessonsShown(...args);
		pendingWrites.push(pending);
		return pending;
	};
	return async () => {
		await Promise.all(pendingWrites);
		expect(pendingWrites).toHaveLength(1);
	};
}

describe('delegate injection outcome attribution (#1768)', () => {
	test('records under canonical Phase N (not the task title) when phase is passed', async () => {
		// Use REAL recordLessonsShown so we can inspect the shown file, but
		// stub recordKnowledgeEvent (which loadPlan-less injectForDelegate still
		// calls for the retrieved event) and confirmEntriesPhase.
		_internals.searchKnowledge = async () => ({
			trace_id: 't',
			results: [entry('del-1'), entry('del-2')],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		_internals.confirmEntriesPhase = async () => {};
		const waitForShownWrite = captureShownWrite();

		const result = await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			taskTitle: 'refactor the parser',
			sessionId: 's-1',
			phase: 'Phase 3',
			config: baseConfig as KnowledgeConfig,
		});
		await waitForShownWrite();

		expect(result.entries.map((e) => e.id).sort()).toEqual(['del-1', 'del-2']);
		// The shown file must use the canonical "Phase 3" key — NOT the task title.
		const data = JSON.parse(
			readFileSync(shownFile(tempDir), 'utf-8'),
		) as Record<string, string[]>;
		expect(data['Phase 3']).toBeDefined();
		expect(data['Phase 3'].sort()).toEqual(['del-1', 'del-2']);
		expect(data['refactor the parser']).toBeUndefined();
	});

	test('does NOT record when no phase is passed (no orphaned keys)', async () => {
		const lessonsSpy = mock(async () => {});
		_internals.recordLessonsShown = lessonsSpy;
		_internals.searchKnowledge = async () => ({
			trace_id: 't',
			results: [entry('del-1')],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		_internals.confirmEntriesPhase = async () => {};

		await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			taskTitle: 'some task',
			sessionId: 's',
			// no phase
			config: baseConfig as KnowledgeConfig,
		});

		expect(lessonsSpy).not.toHaveBeenCalled();
	});

	test('calls confirmEntriesPhase with the resolved phase number', async () => {
		const confirmSpy = mock(async () => {});
		_internals.confirmEntriesPhase = confirmSpy;
		_internals.searchKnowledge = async () => ({
			trace_id: 't',
			results: [entry('del-1'), entry('del-2')],
		});
		_internals.recordKnowledgeEvent = async () => null;
		_internals.recordKnowledgeShown = async () => {};
		_internals.recordLessonsShown = async () => {};

		await injectForDelegate({
			directory: tempDir,
			agent: 'coder', // coder's default tools include 'edit' → entries survive scope
			taskTitle: 'review the PR',
			sessionId: 's',
			phase: 'Phase 5',
			config: baseConfig as KnowledgeConfig,
		});

		expect(confirmSpy).toHaveBeenCalledTimes(1);
		const args = confirmSpy.mock.calls[0];
		expect(args[0]).toBe(tempDir); // directory
		expect(args[1]).toEqual(['del-1', 'del-2']); // ids
		expect(args[2]).toBe(5); // phaseNumber resolved from "Phase 5"
	});
});
