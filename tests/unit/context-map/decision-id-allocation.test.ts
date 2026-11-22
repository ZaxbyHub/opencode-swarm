/**
 * Tests for durable decision-ID allocation in src/context-map/post-agent-update.ts
 * (issue #2720).
 *
 * Decision IDs (`A<n>`) must be derived from the decisions already present in
 * the context map being updated — max numeric suffix + 1, BigInt-exact — so a
 * restarted process continues after the persisted IDs instead of restarting at
 * `A1` and duplicating identity in `.swarm/context-map.json`.
 *
 * Uses the `_internals` DI seam pattern (no `mock.module`), per repo convention.
 * The last describe block exercises the REAL persistence round-trip on disk.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	allocateDecisionId,
	updateContextMapAfterAgent,
} from '../../../src/context-map/post-agent-update';
import type { ContextMap, DecisionEntry } from '../../../src/types/context-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Wire the DI seam for one updateContextMapAfterAgent integration call. */
function wireInternals(initial: ContextMap): ContextMap[] {
	const saved: ContextMap[] = [];
	_internals.loadContextMap = mock(
		() => initial,
	) as typeof _internals.loadContextMap;
	// r17 (P1): the update path reads through the discriminated
	// `readContextMapState` seam first — wire it coherently with the mocked
	// loadContextMap so the seeded map is actually observed as `ok`.
	_internals.readContextMapState = mock(() => ({
		kind: 'ok',
		map: initial,
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
	return saved;
}

function recordDecision(taskId: string, directory: string): ContextMap {
	return updateContextMapAfterAgent({
		task_id: taskId,
		agent_role: 'coder',
		files_touched: [],
		implementation_summary: `write ${taskId}`,
		task_goal: 'verify durable decision ids',
		final_status: 'completed',
		decisions: [
			{ decision: `decision ${taskId}`, rationale: `rationale ${taskId}` },
		],
		directory,
	});
}

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

// ---------------------------------------------------------------------------
// allocateDecisionId — pure derivation from the decisions array
// ---------------------------------------------------------------------------

describe('allocateDecisionId', () => {
	test('empty decisions allocate A1', () => {
		expect(allocateDecisionId([])).toBe('A1');
	});

	test('continues after a contiguous A1..A3 prefix with A4', () => {
		expect(
			allocateDecisionId([
				makeDecision('A1'),
				makeDecision('A2'),
				makeDecision('A3'),
			]),
		).toBe('A4');
	});

	test('continues from the max suffix in a non-contiguous set', () => {
		expect(allocateDecisionId([makeDecision('A1'), makeDecision('A5')])).toBe(
			'A6',
		);
	});

	test('ignores non-matching foreign ids (D-prefix, bare A, lowercase)', () => {
		expect(allocateDecisionId([makeDecision('D1'), makeDecision('D2')])).toBe(
			'A1',
		);
		expect(allocateDecisionId([makeDecision('A')])).toBe('A1');
		expect(allocateDecisionId([makeDecision('a3')])).toBe('A1');
	});

	test('ignores foreign ids while still honoring A-prefix ids in the same set', () => {
		expect(
			allocateDecisionId([
				makeDecision('A2'),
				makeDecision('D9'),
				makeDecision('A10'),
			]),
		).toBe('A11');
	});

	test('normalizes leading-zero legacy ids numerically', () => {
		// A007 parses as 7, so the next allocation is A8, not A008/A1.
		expect(allocateDecisionId([makeDecision('A007')])).toBe('A8');
	});

	test('numeric suffixes beyond 2^53 stay exact (BigInt, not float)', () => {
		// 2^53 + 1 is the first integer Number cannot represent exactly.
		const beyond = 'A9007199254740993';
		expect(allocateDecisionId([makeDecision(beyond)])).toBe(
			'A9007199254740994',
		);
	});

	test('tolerates a non-string id entry without throwing', () => {
		const corrupt = { id: 42 } as unknown as DecisionEntry;
		expect(allocateDecisionId([corrupt, makeDecision('A1')])).toBe('A2');
	});

	test('a map already containing duplicate ids allocates past the max suffix', () => {
		// Legacy corruption (duplicate A2 from the pre-fix era) is not healed,
		// but allocation must not add a NEW duplicate.
		expect(
			allocateDecisionId([
				makeDecision('A1'),
				makeDecision('A2'),
				makeDecision('A2'),
				makeDecision('A3'),
			]),
		).toBe('A4');
	});
});

// ---------------------------------------------------------------------------
// updateContextMapAfterAgent — durable ids through the public write path
// ---------------------------------------------------------------------------

describe('updateContextMapAfterAgent durable decision ids', () => {
	test('appends A4 when the loaded map already contains A1..A3', () => {
		const saved = wireInternals(
			makeContextMap([
				makeDecision('A1'),
				makeDecision('A2'),
				makeDecision('A3'),
			]),
		);

		updateContextMapAfterAgent({
			task_id: '1.1',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'recorded after restart',
			task_goal: 'verify durable ids',
			final_status: 'completed',
			decisions: [{ decision: 'fresh decision', rationale: 'fresh rationale' }],
			directory: '/fake',
		});

		expect(saved).toHaveLength(1);
		const ids = saved[0].decisions.map((d) => d.id);
		expect(ids).toEqual(['A1', 'A2', 'A3', 'A4']);
	});

	test('allocates distinct sequential ids for multiple decisions in one call', () => {
		const saved = wireInternals(
			makeContextMap([
				makeDecision('A1'),
				makeDecision('A2'),
				makeDecision('A3'),
			]),
		);

		updateContextMapAfterAgent({
			task_id: '1.2',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'two decisions in one call',
			task_goal: 'verify in-call sequencing',
			final_status: 'completed',
			decisions: [
				{ decision: 'first decision', rationale: 'first rationale' },
				{ decision: 'second decision', rationale: 'second rationale' },
			],
			directory: '/fake',
		});

		const ids = saved[0].decisions.map((d) => d.id);
		expect(ids).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
	});

	test('a map with no decisions still starts at A1 (legacy-compatible)', () => {
		const saved = wireInternals(makeContextMap([]));

		updateContextMapAfterAgent({
			task_id: '1.3',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'first decision ever',
			task_goal: 'verify fresh-map allocation',
			final_status: 'completed',
			decisions: [{ decision: 'first decision', rationale: 'first rationale' }],
			directory: '/fake',
		});

		expect(saved[0].decisions.map((d) => d.id)).toEqual(['A1']);
	});

	test('a saved-then-reloaded map continues the sequence (simulated restart)', () => {
		// First "process": record into a map that already holds A1..A3.
		const saved1 = wireInternals(
			makeContextMap([
				makeDecision('A1'),
				makeDecision('A2'),
				makeDecision('A3'),
			]),
		);
		updateContextMapAfterAgent({
			task_id: '2.1',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'pre-restart write',
			task_goal: 'verify restart durability',
			final_status: 'completed',
			decisions: [{ decision: 'pre-restart decision', rationale: 'rationale' }],
			directory: '/fake',
		});
		const persisted = saved1[0];

		// Simulated restart: the next process loads exactly what was persisted.
		const saved2 = wireInternals(persisted);
		updateContextMapAfterAgent({
			task_id: '2.2',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'post-restart write',
			task_goal: 'verify restart durability',
			final_status: 'completed',
			decisions: [
				{ decision: 'post-restart decision', rationale: 'rationale' },
			],
			directory: '/fake',
		});

		const ids = saved2[0].decisions.map((d) => d.id);
		expect(ids).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

// ---------------------------------------------------------------------------
// Real persistence round-trip — the disk-witnessed property CI can enforce
// ---------------------------------------------------------------------------

describe('decision id durability on real disk (issue #2720)', () => {
	test('two sequential calls against a persisted map yield no duplicate ids on disk', () => {
		const dir = canonicalMkdtemp('ctxmap-2720-rt-');
		try {
			// Seed exactly what a previous process persisted.
			const seed = makeContextMap([
				makeDecision('A1'),
				makeDecision('A2'),
				makeDecision('A3'),
			]);
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm', 'context-map.json'),
				JSON.stringify(seed, null, 2),
				'utf-8',
			);

			// Two calls stand in for two processes; the persisted file is the witness.
			recordDecision('3.1', dir);
			recordDecision('3.2', dir);

			const mapPath = path.join(dir, '.swarm', 'context-map.json');
			const persisted = JSON.parse(
				fs.readFileSync(mapPath, 'utf-8'),
			) as ContextMap;
			const ids = persisted.decisions.map((d) => d.id);
			expect(ids).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
			expect(new Set(ids).size).toBe(ids.length);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
