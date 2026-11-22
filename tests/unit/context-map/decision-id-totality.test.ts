/**
 * Totality tests for allocateDecisionId over corrupt decision arrays
 * (issue #2720 review round: a loadable map can carry malformed decision
 * entries — loadContextMap validates only schema_version — and allocation
 * must skip them, not throw into updateContextMapAfterAgent's outer catch,
 * which would silently drop the whole update).
 *
 * Lives outside the frozen decision-id-allocation.test.ts checkpoint blob.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
	_internals,
	allocateDecisionId,
	updateContextMapAfterAgent,
} from '../../../src/context-map/post-agent-update';
import type { ContextMap, DecisionEntry } from '../../../src/types/context-map';

function makeDecision(id: string): DecisionEntry {
	return {
		id,
		decision: `decision ${id}`,
		rationale: `rationale ${id}`,
		timestamp: '2026-01-01T00:00:00.000Z',
		task_id: '0.0',
	};
}

function makeContextMap(decisions: DecisionEntry[]): ContextMap {
	return {
		schema_version: 1,
		generated_at: '2026-01-01T00:00:00.000Z',
		repo_fingerprint: 'test-fingerprint',
		files: {},
		task_history: {},
		decisions,
	};
}

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

describe('allocateDecisionId totality over corrupt entries', () => {
	test('a null entry is skipped, not thrown on', () => {
		expect(
			allocateDecisionId([
				null,
				makeDecision('A1'),
			] as unknown as DecisionEntry[]),
		).toBe('A2');
	});

	test('non-object entries are skipped', () => {
		expect(
			allocateDecisionId([
				42,
				'A9',
				makeDecision('A2'),
			] as unknown as DecisionEntry[]),
		).toBe('A3');
	});

	test('near-miss id shapes do not count as A-suffix ids', () => {
		// Anchored ^A\d+$ with no dot-all or multiline flags: trailing junk,
		// leading whitespace, a hyphen, and a trailing newline all miss, so a
		// map holding only such ids allocates from A1.
		expect(
			allocateDecisionId([
				makeDecision('A1x'),
				makeDecision(' A1'),
				makeDecision('A-1'),
				makeDecision('A1\n'),
			]),
		).toBe('A1');
	});
});

describe('updateContextMapAfterAgent survives corrupt decision entries', () => {
	test('a loadable map with a null decision entry still saves the update', () => {
		const corrupt = makeContextMap([
			null,
			makeDecision('A1'),
		] as unknown as DecisionEntry[]);
		const saved: ContextMap[] = [];
		_internals.loadContextMap = mock(
			() => corrupt,
		) as typeof _internals.loadContextMap;
		// r17 (P1): the update path reads through the discriminated
		// `readContextMapState` seam first — the structurally-valid map with
		// the null decision entry is `ok` (the null entry is tolerated by
		// allocation, not by the structural validator).
		_internals.readContextMapState = mock(() => ({
			kind: 'ok',
			map: corrupt,
		})) as typeof _internals.readContextMapState;
		_internals.saveContextMap = mock((map: ContextMap) => {
			saved.push(map);
		}) as typeof _internals.saveContextMap;
		_internals.existsSync = mock(() => false) as typeof _internals.existsSync;
		_internals.realpathSync = mock(
			(p: string) => p,
		) as typeof _internals.realpathSync;
		_internals.appendTaskHistory = mock(
			(map: ContextMap, summary: ContextMap['task_history'][string]) => ({
				...map,
				task_history: { ...map.task_history, [summary.task_id]: summary },
			}),
		) as typeof _internals.appendTaskHistory;
		_internals.appendDecision = mock(
			(map: ContextMap, decision: DecisionEntry) => ({
				...map,
				decisions: [...map.decisions, decision],
			}),
		) as typeof _internals.appendDecision;

		updateContextMapAfterAgent({
			task_id: '9.1',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'update on a corrupt-entry map',
			task_goal: 'verify totality',
			final_status: 'completed',
			decisions: [{ decision: 'fresh decision', rationale: 'rationale' }],
			directory: '/fake',
		});

		// The update must persist (not fall into the outer catch), with the
		// new decision allocated past the max well-formed A-suffix.
		expect(saved).toHaveLength(1);
		const ids = saved[0].decisions.map((d) => d?.id);
		// (d) => d?.id maps the null entry to undefined.
		expect(ids).toEqual([undefined, 'A1', 'A2']);
	});
});
