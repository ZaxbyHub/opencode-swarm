/**
 * Smoke tests for post-agent-update wiring (Task 4.2)
 *
 * Verifies that `updateContextMapAfterAgent` is callable with the exact
 * parameter shape that src/index.ts wiring passes at hook-time:
 *   - files_touched: []          (empty — wiring passes no files)
 *   - final_status: 'completed'  (wiring always passes 'completed')
 *   - implementation_summary: truncated to 500 chars
 *   - task_goal: ''              (wiring passes empty string)
 *   - directory: ctx.directory   (injected by createSwarmTool)
 *
 * The wiring is deeply embedded in src/index.ts's tool.execute.after hook
 * and requires the full plugin context, so these are smoke-level integration
 * tests that exercise the _internals DI seam with the wiring's param shape.
 *
 * Full coverage of updateContextMapAfterAgent logic is in
 * tests/unit/context-map/post-agent-update.test.ts.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
	_internals,
	type PostAgentUpdateParams,
	updateContextMapAfterAgent,
} from '../../../src/context-map/post-agent-update';
import type { ContextMap } from '../../../src/types/context-map';

// ---------------------------------------------------------------------------
// Snapshot of original _internals for restoration
// ---------------------------------------------------------------------------

const originalInternals = { ..._internals };

// ---------------------------------------------------------------------------
// Mock helpers — mirror the pattern from post-agent-update.test.ts
// ---------------------------------------------------------------------------

function setLoadContextMap(
	fn: (directory: string) => ContextMap | null,
): ReturnType<typeof mock> {
	const mockFn = mock(fn);
	_internals.loadContextMap = mockFn as typeof _internals.loadContextMap;
	return mockFn;
}

function setSaveContextMap(): {
	mockFn: ReturnType<typeof mock>;
	calls: unknown[][];
} {
	const calls: unknown[][] = [];
	const mockFn = mock((map: ContextMap, dir: string) => {
		calls.push([map, dir]);
	});
	_internals.saveContextMap = mockFn as typeof _internals.saveContextMap;
	return { mockFn, calls };
}

function setExistsSync(predicate: (p: string) => boolean): void {
	_internals.existsSync = mock(predicate) as typeof _internals.existsSync;
}

function setRealpathSync(predicate: (p: string) => string): void {
	_internals.realpathSync = mock(predicate) as typeof _internals.realpathSync;
}

function setExtractFileSummary(fn: typeof _internals.extractFileSummary): void {
	_internals.extractFileSummary = fn;
}

function setAppendTaskHistory(
	fn: (map: ContextMap, summary: { task_id: string }) => ContextMap,
): void {
	_internals.appendTaskHistory = fn as typeof _internals.appendTaskHistory;
}

function setAppendDecision(
	fn: (map: ContextMap, decision: unknown) => ContextMap,
): void {
	_internals.appendDecision = fn as typeof _internals.appendDecision;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

// ---------------------------------------------------------------------------
// Wiring param shape — smoke tests
// ---------------------------------------------------------------------------

describe('post-agent-update wiring smoke tests (Task 4.2)', () => {
	/**
	 * The wiring in src/index.ts calls updateContextMapAfterAgent with:
	 *   files_touched: []
	 *   final_status: 'completed'
	 *   implementation_summary: agentOutput.slice(0, 500)  (truncated)
	 *   task_goal: ''
	 *   directory: ctx.directory
	 *
	 * This test verifies the function is callable with that exact shape
	 * and returns a valid ContextMap without throwing.
	 */
	test('updateContextMapAfterAgent accepts wiring param shape and returns ContextMap', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'x',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map) => ({ ...map, decisions: [] }));

		// Exact params the wiring passes (src/index.ts ~line 1736)
		const wiringParams: PostAgentUpdateParams = {
			task_id: '4.2',
			agent_role: 'coder',
			files_touched: [], // wiring passes empty array
			implementation_summary: 'x'.repeat(500), // wired to agentOutput.slice(0, 500)
			task_goal: '', // wiring passes empty string
			final_status: 'completed', // wiring always passes 'completed'
			directory: '/fake',
		};

		// Should not throw
		const result = updateContextMapAfterAgent(wiringParams);

		// Must return a valid ContextMap
		expect(result).toBeDefined();
		expect(result.schema_version).toBe(1);
		expect(typeof result.generated_at).toBe('string');
		expect(result.task_history).toBeDefined();
		expect(Array.isArray(result.decisions)).toBe(true);

		// Task history entry must be created
		expect(result.task_history['4.2']).toBeDefined();
		expect(result.task_history['4.2'].task_id).toBe('4.2');

		// saveContextMap must have been called (map persisted)
		expect(saveFn).toHaveBeenCalled();
		const [savedMap, savedDir] = saveFn.mock.calls[0] as [ContextMap, string];
		expect(savedMap.schema_version).toBe(1);
		expect(savedDir).toBe('/fake');
	});

	/**
	 * Verify the wiring's 'unknown' fallback for agent_role is accepted.
	 * The wiring uses: swarmState.activeAgent.get(input.sessionID) ?? 'unknown'
	 */
	test('accepts agent_role "unknown" (wiring fallback)', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'x',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map) => ({ ...map, decisions: [] }));

		const result = updateContextMapAfterAgent({
			task_id: '4.2-unknown-role',
			agent_role: 'unknown',
			files_touched: [],
			implementation_summary: 'Test with unknown role',
			task_goal: '',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(result.task_history['4.2-unknown-role']).toBeDefined();
		expect(saveFn).toHaveBeenCalled();
	});

	/**
	 * Verify empty files_touched (wiring always passes []) is handled correctly.
	 * With empty files_touched, no file entries are updated — only task_history
	 * is appended. This is intentional: wiring doesn't have file-change data.
	 */
	test('handles empty files_touched (wiring always passes [])', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'x',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map) => ({ ...map, decisions: [] }));

		const result = updateContextMapAfterAgent({
			task_id: '4.2-empty-files',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'No files touched',
			task_goal: '',
			final_status: 'completed',
			directory: '/fake',
		});

		// Task is recorded
		expect(result.task_history['4.2-empty-files']).toBeDefined();
		// No files in the map (empty files_touched means nothing to refresh)
		expect(Object.keys(result.files)).toHaveLength(0);
		// But save was called (state was written)
		expect(saveFn).toHaveBeenCalled();
	});

	/**
	 * Verify implementation_summary truncation at 500 chars works.
	 * The wiring passes: agentOutput.slice(0, 500)
	 */
	test('accepts 500-char truncated implementation_summary', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'x',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map) => ({ ...map, decisions: [] }));

		const longSummary = 'A'.repeat(500);
		expect(longSummary.length).toBe(500);

		const result = updateContextMapAfterAgent({
			task_id: '4.2-truncated',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: longSummary,
			task_goal: '',
			final_status: 'completed',
			directory: '/fake',
		});

		// Truncated summary must be stored as-is (no further truncation)
		expect(result.task_history['4.2-truncated'].implementation_summary).toBe(
			longSummary,
		);
		expect(saveFn).toHaveBeenCalled();
	});

	/**
	 * Verify empty task_goal (wiring passes '') is accepted.
	 * The task_goal field is optional in PostAgentUpdateParams but the
	 * wiring explicitly passes an empty string.
	 */
	test('accepts empty task_goal (wiring passes "")', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'x',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map) => ({ ...map, decisions: [] }));

		const result = updateContextMapAfterAgent({
			task_id: '4.2-empty-goal',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'Did stuff',
			task_goal: '',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(result.task_history['4.2-empty-goal'].goal).toBe('');
		expect(saveFn).toHaveBeenCalled();
	});

	/**
	 * Integration-style: verify the wiring scenario end-to-end with all
	 * params at their wiring values simultaneously.
	 */
	test('full wiring scenario — all params at wiring values', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'x',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map) => ({ ...map, decisions: [] }));

		// Simulate what src/index.ts wiring passes:
		// - task_id from swarmState.agentSessions.get(sessionID)?.currentTaskId
		// - agent_role from swarmState.activeAgent.get(sessionID) ?? 'unknown'
		// - files_touched: [] (wiring has no file-change data)
		// - implementation_summary: agentOutput.slice(0, 500)
		// - task_goal: '' (wiring has no goal)
		// - final_status: 'completed' (wiring always passes 'completed')
		// - directory: ctx.directory (injected by createSwarmTool)
		const agentOutput =
			'This is a simulated long agent output that gets truncated to 500 characters by the wiring in src/index.ts using agentOutput.slice(0, 500). '.repeat(
				20,
			);
		const truncatedSummary = agentOutput.slice(0, 500);

		const result = updateContextMapAfterAgent({
			task_id: '4.2-full-wiring',
			agent_role: 'unknown',
			files_touched: [],
			implementation_summary: truncatedSummary,
			task_goal: '',
			final_status: 'completed',
			directory: '/fake',
		});

		// Verify task history entry
		const entry = result.task_history['4.2-full-wiring'];
		expect(entry).toBeDefined();
		expect(entry.task_id).toBe('4.2-full-wiring');
		expect(entry.goal).toBe('');
		expect(entry.implementation_summary).toBe(truncatedSummary);
		expect(entry.implementation_summary.length).toBe(500);
		expect(entry.final_status).toBe('approved'); // 'completed' maps to 'approved'
		expect(entry.files_touched).toEqual([]);

		// Verify context map structure
		expect(result.schema_version).toBe(1);
		expect(typeof result.generated_at).toBe('string');
		expect(result.repo_fingerprint).toBeDefined();
		expect(Object.keys(result.files)).toHaveLength(0); // no files touched
		expect(Array.isArray(result.decisions)).toBe(true);

		// Verify persistence was called
		expect(saveFn).toHaveBeenCalledTimes(1);
		const [savedMap] = saveFn.mock.calls[0] as [ContextMap, string];
		expect(savedMap.task_history['4.2-full-wiring']).toBeDefined();
	});
});
