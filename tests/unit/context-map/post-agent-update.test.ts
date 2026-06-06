/**
 * Tests for src/context-map/post-agent-update.ts
 *
 * Uses _internals DI seam pattern to mock filesystem operations.
 * All tests use bun:test native APIs (no vitest compat layer).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	extractEvidenceFindings,
	type PostAgentUpdateParams,
	updateContextMapAfterAgent,
} from '../../../src/context-map/post-agent-update';
import type {
	ContextMap,
	DecisionEntry,
	FileContextEntry,
	TaskContextSummary,
} from '../../../src/types/context-map';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-agent-update-test-'));
	return fs.realpathSync(dir);
}

function makeContextMap(
	files: Record<string, FileContextEntry> = {},
): ContextMap {
	return {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		repo_fingerprint: 'test-fingerprint',
		files,
		task_history: {},
		decisions: [],
	};
}

// ---------------------------------------------------------------------------
// Snapshot of original _internals for restoration
// ---------------------------------------------------------------------------

const originalInternals = { ..._internals };

// ---------------------------------------------------------------------------
// Mock assignment helpers — assign mock implementations to _internals
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

function setExistsSync(
	predicate: (p: string) => boolean,
): ReturnType<typeof mock> {
	const mockFn = mock(predicate);
	_internals.existsSync = mockFn as typeof _internals.existsSync;
	return mockFn;
}

function setReaddirSync(fn: (p: string) => string[]): void {
	_internals.readdirSync = fn as typeof _internals.readdirSync;
}

function setRealpathSync(
	predicate: (p: string) => string,
): ReturnType<typeof mock> {
	const mockFn = mock(predicate);
	_internals.realpathSync = mockFn as typeof _internals.realpathSync;
	return mockFn;
}

function setReadFileSync(
	predicate: (p: string) => string | null,
): ReturnType<typeof mock> {
	const mockFn = mock(predicate);
	_internals.readFileSync = mockFn as typeof _internals.readFileSync;
	return mockFn;
}

function setExtractFileSummary(fn: typeof _internals.extractFileSummary): void {
	_internals.extractFileSummary = fn;
}

function setAppendTaskHistory(
	fn: (map: ContextMap, summary: TaskContextSummary) => ContextMap,
): void {
	_internals.appendTaskHistory = fn as typeof _internals.appendTaskHistory;
}

function setAppendDecision(
	fn: (map: ContextMap, decision: DecisionEntry) => ContextMap,
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
// _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals DI seam', () => {
	test('all expected functions are present', () => {
		expect(typeof _internals.loadContextMap).toBe('function');
		expect(typeof _internals.saveContextMap).toBe('function');
		expect(typeof _internals.createEmptyContextMap).toBe('function');
		expect(typeof _internals.extractFileSummary).toBe('function');
		expect(typeof _internals.existsSync).toBe('function');
		expect(typeof _internals.readFileSync).toBe('function');
		expect(typeof _internals.readdirSync).toBe('function');
		expect(typeof _internals.realpathSync).toBe('function');
		expect(typeof _internals.appendTaskHistory).toBe('function');
		expect(typeof _internals.appendDecision).toBe('function');
	});

	test('override verification works', () => {
		const original = _internals.existsSync;
		const mockFn = mock(() => false);
		_internals.existsSync = mockFn as typeof _internals.existsSync;
		expect(_internals.existsSync('/fake')).toBe(false);
		expect(mockFn).toHaveBeenCalledWith('/fake');
		_internals.existsSync = original;
	});
});

// ---------------------------------------------------------------------------
// PostAgentUpdateParams interface
// ---------------------------------------------------------------------------

describe('PostAgentUpdateParams interface', () => {
	test('accepts valid params object', () => {
		const params: PostAgentUpdateParams = {
			task_id: '1.1',
			agent_role: 'coder',
			files_touched: ['src/foo.ts'],
			implementation_summary: 'Added feature X',
			task_goal: 'Implement feature X',
			final_status: 'completed',
			directory: '/fake',
		};
		expect(params.task_id).toBe('1.1');
	});
});

// ---------------------------------------------------------------------------
// deriveFinalStatus (indirect via updateContextMapAfterAgent)
// ---------------------------------------------------------------------------

describe('deriveFinalStatus via updateContextMapAfterAgent', () => {
	test('maps completed without rejections to approved', () => {
		setLoadContextMap(() => null);
		setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'a',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '1.1',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'did stuff',
			task_goal: 'goal',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(result.task_history['1.1'].final_status).toBe('approved');
	});

	test('maps failed to rejected', () => {
		setLoadContextMap(() => null);
		setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'a',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '1.2',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'did stuff',
			task_goal: 'goal',
			final_status: 'failed',
			directory: '/fake',
		});

		expect(result.task_history['1.2'].final_status).toBe('rejected');
	});

	test('maps blocked to blocked', () => {
		setLoadContextMap(() => null);
		setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'a',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '1.3',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'did stuff',
			task_goal: 'goal',
			final_status: 'blocked',
			directory: '/fake',
		});

		expect(result.task_history['1.3'].final_status).toBe('blocked');
	});

	test('maps cancelled to rejected', () => {
		setLoadContextMap(() => null);
		setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'a',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '1.4',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'did stuff',
			task_goal: 'goal',
			final_status: 'cancelled',
			directory: '/fake',
		});

		expect(result.task_history['1.4'].final_status).toBe('rejected');
	});

	test('rejection_reasons override final_status to rejected', () => {
		setLoadContextMap(() => null);
		setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'a',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '1.5',
			agent_role: 'reviewer',
			files_touched: [],
			implementation_summary: 'did stuff',
			task_goal: 'goal',
			final_status: 'completed',
			rejection_reasons: ['Code style violation'],
			directory: '/fake',
		});

		expect(result.task_history['1.5'].final_status).toBe('rejected');
	});
});

// ---------------------------------------------------------------------------
// updateContextMapAfterAgent
// ---------------------------------------------------------------------------

describe('updateContextMapAfterAgent', () => {
	test('creates empty map when no existing map', () => {
		setLoadContextMap(() => null);
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => false);
		setRealpathSync((p) => p);
		setExtractFileSummary(() => ({
			path: 'a',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.1',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'Initial implementation',
			task_goal: 'Build it',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(saveFn).toHaveBeenCalled();
		const [savedMap] = saveFn.mock.calls[0] as [ContextMap, string];
		expect(savedMap.schema_version).toBe(1);
		expect(savedMap.task_history['2.1']).toBeDefined();
	});

	test('updates file summaries for touched files', () => {
		setLoadContextMap(() => makeContextMap());
		const { mockFn: saveFn } = setSaveContextMap();
		setExistsSync(() => true);
		setRealpathSync((p) => p);
		setExtractFileSummary((rel, _content, _abs, existing) => ({
			path: rel,
			content_hash: 'newhash',
			mtime_ms: 999,
			purpose: 'updated purpose',
			summary: 'updated summary',
			...(existing && {
				invariants: existing.invariants,
				risks: existing.risks,
				tests: existing.tests,
			}),
		}));
		setReadFileSync(() => 'file content');
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.2',
			agent_role: 'coder',
			files_touched: ['src/foo.ts'],
			implementation_summary: 'Updated foo',
			task_goal: 'Update foo',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(result.files['src/foo.ts']).toBeDefined();
		expect(result.files['src/foo.ts']?.content_hash).toBe('newhash');
	});

	test('preserves accumulated data when merging', () => {
		const existingEntry: FileContextEntry = {
			path: 'src/preserved.ts',
			content_hash: 'oldhash',
			mtime_ms: 100,
			purpose: 'original purpose',
			summary: 'original summary',
			invariants: ['Must be called first'],
			risks: ['High cyclomatic complexity'],
			tests: ['tests/preserved.test.ts'],
			last_seen_task_ids: ['1.1'],
		};
		setLoadContextMap(() =>
			makeContextMap({ 'src/preserved.ts': existingEntry }),
		);
		setSaveContextMap();
		setExistsSync(() => true);
		setRealpathSync((p) => p);
		setExtractFileSummary((rel, _content, _abs, existing) => {
			// Verify accumulated fields are passed through
			expect(existing?.invariants).toEqual(['Must be called first']);
			expect(existing?.risks).toEqual(['High cyclomatic complexity']);
			expect(existing?.tests).toEqual(['tests/preserved.test.ts']);
			return {
				path: rel,
				content_hash: 'newhash',
				mtime_ms: 200,
				purpose: 'new purpose',
				summary: 'new summary',
				invariants: existing?.invariants,
				risks: existing?.risks,
				tests: existing?.tests,
			};
		});
		setReadFileSync(() => 'new content');
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.3',
			agent_role: 'coder',
			files_touched: ['src/preserved.ts'],
			implementation_summary: 'Touched preserved',
			task_goal: 'Touch it',
			final_status: 'completed',
			directory: '/fake',
		});

		// Accumulated fields must be preserved
		expect(result.files['src/preserved.ts']?.invariants).toEqual([
			'Must be called first',
		]);
		expect(result.files['src/preserved.ts']?.risks).toEqual([
			'High cyclomatic complexity',
		]);
		expect(result.files['src/preserved.ts']?.tests).toEqual([
			'tests/preserved.test.ts',
		]);
	});

	test('appends TaskContextSummary with correct fields', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.4',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'Implemented feature Y',
			task_goal: 'Build feature Y',
			final_status: 'completed',
			directory: '/fake',
		});

		const summary = result.task_history['2.4'];
		expect(summary.task_id).toBe('2.4');
		expect(summary.goal).toBe('Build feature Y');
		expect(summary.implementation_summary).toBe('Implemented feature Y');
		expect(summary.final_status).toBe('approved');
	});

	test('appends decisions to map', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.5',
			agent_role: 'architect',
			files_touched: [],
			implementation_summary: 'Made decision',
			task_goal: 'Decide something',
			final_status: 'completed',
			decisions: [
				{
					decision: 'Use TypeScript for type safety',
					rationale: 'Better tooling support',
				},
			],
			directory: '/fake',
		});

		expect(result.decisions.length).toBe(1);
		expect(result.decisions[0].decision).toBe('Use TypeScript for type safety');
		expect(result.decisions[0].rationale).toBe('Better tooling support');
		expect(result.decisions[0].task_id).toBe('2.5');
	});

	test('returns updated ContextMap', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.6',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'stuff',
			task_goal: 'goal',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(result.schema_version).toBe(1);
		expect(result.task_history['2.6']).toBeDefined();
	});

	test('handles missing files gracefully — skips them', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.7',
			agent_role: 'coder',
			files_touched: ['nonexistent.ts'],
			implementation_summary: 'Touched nothing',
			task_goal: 'Goal',
			final_status: 'completed',
			directory: '/fake',
		});

		// Should not throw, and task should still be recorded.
		// Note: files_touched includes all paths that pass containment validation,
		// even if the file doesn't exist (existence only affects updatedFiles).
		expect(result.task_history['2.7']).toBeDefined();
		expect(result.task_history['2.7'].files_touched).toContain(
			'nonexistent.ts',
		);
		// But the file entry should not be in the files map
		expect(result.files['nonexistent.ts']).toBeUndefined();
	});

	test('skips files with path traversal (../outside)', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => true);
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.8',
			agent_role: 'coder',
			files_touched: ['../outside/file.ts'],
			implementation_summary: 'Tried to escape',
			task_goal: 'Escape',
			final_status: 'completed',
			directory: '/fake',
		});

		// Path traversal should be skipped — not in files_touched
		expect(result.task_history['2.8'].files_touched).not.toContain(
			'../outside/file.ts',
		);
	});

	test('skips files with symlink escaping root', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => true);
		// realpath resolves the symlink to an outside path
		setRealpathSync((p) => {
			if (p.includes('linked')) return '/outside/linked.ts';
			return p;
		});
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.9',
			agent_role: 'coder',
			files_touched: ['src/linked.ts'],
			implementation_summary: 'Followed symlink',
			task_goal: 'Follow',
			final_status: 'completed',
			directory: '/fake',
		});

		// Symlink escape should be skipped
		expect(result.task_history['2.9'].files_touched).not.toContain(
			'src/linked.ts',
		);
	});

	test('normalizes paths to forward slashes', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => true);
		setRealpathSync((p) => p);
		setExtractFileSummary((rel) => ({
			path: rel,
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setReadFileSync(() => 'content');
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.10',
			agent_role: 'coder',
			files_touched: ['src\\utils\\helper.ts'],
			implementation_summary: 'Normalized path',
			task_goal: 'Normalize',
			final_status: 'completed',
			directory: '/fake',
		});

		// Path should be normalized to forward slashes
		expect(result.task_history['2.10'].files_touched[0]).toBe(
			'src/utils/helper.ts',
		);
	});

	test('taskSummary.files_touched only contains validated paths', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => true);
		setRealpathSync((p) => p);
		setExtractFileSummary((rel) => ({
			path: rel,
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setReadFileSync(() => 'content');
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '2.11',
			agent_role: 'coder',
			files_touched: ['valid.ts', '../invalid.ts', 'another/valid2.ts'],
			implementation_summary: 'Mixed paths',
			task_goal: 'Test',
			final_status: 'completed',
			directory: '/fake',
		});

		// Only valid paths should be in files_touched
		expect(result.task_history['2.11'].files_touched).toContain('valid.ts');
		expect(result.task_history['2.11'].files_touched).toContain(
			'another/valid2.ts',
		);
		expect(result.task_history['2.11'].files_touched).not.toContain(
			'../invalid.ts',
		);
	});

	test('never throws — returns best-effort map on error', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => {
			throw new Error('Simulated error');
		});
		setRealpathSync((p) => {
			throw new Error('Realpath error');
		});
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		// Should not throw — must return a best-effort map
		const result = updateContextMapAfterAgent({
			task_id: '2.12',
			agent_role: 'coder',
			files_touched: [],
			implementation_summary: 'Error handling',
			task_goal: 'Test error',
			final_status: 'completed',
			directory: '/fake',
		});

		expect(result).toBeDefined();
		expect(result.schema_version).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// extractEvidenceFindings
// ---------------------------------------------------------------------------

describe('extractEvidenceFindings — real filesystem', () => {
	let tempDir: string;

	afterEach(() => {
		// Restore original _internals
		Object.assign(_internals, originalInternals);
		// Clean up temp directory
		if (tempDir) {
			fs.rmSync(tempDir, { force: true, recursive: true });
		}
	});

	test('returns empty arrays when evidence directory does not exist', () => {
		tempDir = makeTempDir();
		// Don't create evidence directory — extractEvidenceFindings should return empty
		const result = extractEvidenceFindings('99.9', tempDir);
		expect(result.rejection_reasons).toEqual([]);
		expect(result.review_findings).toEqual([]);
	});

	test('extracts rejection reasons from reviewer.json', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({
				verdict: 'REJECTED',
				issues: [{ message: 'Style violation' }],
			}),
		);

		const result = extractEvidenceFindings('3.1', tempDir);

		expect(result.rejection_reasons.length).toBeGreaterThan(0);
		expect(result.rejection_reasons[0]).toContain('REJECTED');
	});

	test('extracts findings from issues array', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.2');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({
				verdict: 'APPROVED',
				issues: [
					{ message: 'First issue' },
					{ detail: 'Second issue via detail' },
					{ description: 'Third issue via description' },
				],
			}),
		);

		const result = extractEvidenceFindings('3.2', tempDir);

		expect(result.review_findings).toContain('First issue');
		expect(result.review_findings).toContain('Second issue via detail');
		expect(result.review_findings).toContain('Third issue via description');
	});

	test('handles EvidenceBundle entries[] format', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.3');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'evidence.json'),
			JSON.stringify({
				entries: [
					{
						type: 'reviewer',
						verdict: 'rejected',
						issues: [{ message: 'Bundle rejection reason' }],
					},
				],
			}),
		);

		const result = extractEvidenceFindings('3.3', tempDir);

		expect(result.rejection_reasons[0]).toContain('rejected');
		expect(result.review_findings).toContain('Bundle rejection reason');
	});

	test('handles legacy/flat format', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.4');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({
				verdict: 'concerns',
				issues: [{ message: 'Legacy concern' }],
			}),
		);

		const result = extractEvidenceFindings('3.4', tempDir);

		expect(result.rejection_reasons[0]).toContain('concerns');
		expect(result.review_findings).toContain('Legacy concern');
	});

	test('handles test_engineer.json filename', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.5');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'test_engineer.json'),
			JSON.stringify({
				verdict: 'fail',
				findings: [{ message: 'Test failed' }],
			}),
		);

		const result = extractEvidenceFindings('3.5', tempDir);

		expect(result.rejection_reasons[0]).toContain('fail');
		expect(result.review_findings).toContain('Test failed');
	});

	test('handles test-engineer.json filename', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.6');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'test-engineer.json'),
			JSON.stringify({
				verdict: 'fail',
				findings: [{ message: 'Test via kebab name' }],
			}),
		);

		const result = extractEvidenceFindings('3.6', tempDir);

		expect(result.rejection_reasons[0]).toContain('fail');
		expect(result.review_findings).toContain('Test via kebab name');
	});

	test('reads evidence.json (canonical bundle)', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.7');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'evidence.json'),
			JSON.stringify({
				entries: [
					{
						type: 'review',
						verdict: 'rejected',
						issues: [{ message: 'Evidence bundle issue' }],
					},
				],
			}),
		);

		const result = extractEvidenceFindings('3.7', tempDir);

		expect(result.rejection_reasons[0]).toContain('rejected');
		expect(result.review_findings).toContain('Evidence bundle issue');
	});

	test('extracts test failures[].message', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.8');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'test-engineer.json'),
			JSON.stringify({
				entries: [
					{
						type: 'test',
						verdict: 'fail',
						failures: [
							{ message: 'Assertion failed: expected 1 got 2' },
							{ detail: 'Null pointer on line 42' },
							'Raw string failure',
						],
					},
				],
			}),
		);

		const result = extractEvidenceFindings('3.8', tempDir);

		expect(result.review_findings).toContain(
			'Assertion failed: expected 1 got 2',
		);
		expect(result.review_findings).toContain('Null pointer on line 42');
		expect(result.review_findings).toContain('Raw string failure');
	});

	test('case-insensitive verdict comparison', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.9');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({ verdict: 'APPROVED', issues: [] }),
		);

		const result = extractEvidenceFindings('3.9', tempDir);

		// APPROVED should NOT be treated as a rejection
		expect(result.rejection_reasons).toEqual([]);
	});

	test('only treats explicit rejection verdicts as rejections', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.10');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({
				verdict: 'info',
				issues: [{ message: 'Just an info note' }],
			}),
		);

		const result = extractEvidenceFindings('3.10', tempDir);

		// 'info' is not a rejection verdict
		expect(result.rejection_reasons).toEqual([]);
		expect(result.review_findings).toContain('Just an info note');
	});

	test('neutral entries (info, note) are not treated as rejections', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.11');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'evidence.json'),
			JSON.stringify({
				entries: [
					{ type: 'info', verdict: 'pass', issues: [] },
					{ type: 'note', verdict: 'pass', issues: [] },
					{
						type: 'review',
						verdict: 'rejected',
						issues: [{ message: 'Real rejection' }],
					},
				],
			}),
		);

		const result = extractEvidenceFindings('3.11', tempDir);

		// Only the 'review' type entry with 'rejected' verdict counts
		expect(result.rejection_reasons.length).toBe(1);
		expect(result.rejection_reasons[0]).toContain('rejected');
	});

	test('reads issue.message, issue.detail, issue.description', () => {
		tempDir = makeTempDir();
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.12');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({
				issues: [
					{ message: 'Via message field' },
					{ detail: 'Via detail field' },
					{ description: 'Via description field' },
					{ message: 'Has both', detail: 'but message takes priority' },
				],
			}),
		);

		const result = extractEvidenceFindings('3.12', tempDir);

		expect(result.review_findings).toContain('Via message field');
		expect(result.review_findings).toContain('Via detail field');
		expect(result.review_findings).toContain('Via description field');
		// message takes priority
		expect(result.review_findings).toContain('Has both');
	});

	test('evidenceFindings merged with params rejection_reasons', () => {
		tempDir = makeTempDir();
		// Create evidence directory with reviewer.json
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3.13');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer.json'),
			JSON.stringify({
				verdict: 'rejected',
				issues: [{ message: 'Evidence rejection' }],
			}),
		);

		const result = updateContextMapAfterAgent({
			task_id: '3.13',
			agent_role: 'reviewer',
			files_touched: [],
			implementation_summary: 'stuff',
			task_goal: 'goal',
			final_status: 'completed',
			rejection_reasons: ['Param rejection'],
			directory: tempDir,
		});

		// Both param and evidence rejections should be present
		const findings = result.task_history['3.13'].reviewer_findings ?? [];
		const rejectionLines = findings.filter((f) => f.startsWith('[rejection]'));
		expect(rejectionLines.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

describe('Path security', () => {
	test('realpath containment verified', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => true);
		// Symlink resolves to outside root
		setRealpathSync((p) => {
			if (p.endsWith('evil.ts')) return '/outside/evil.ts';
			return p;
		});
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
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '4.1',
			agent_role: 'coder',
			files_touched: ['src/evil.ts'],
			implementation_summary: 'Escaped via symlink',
			task_goal: 'Escape',
			final_status: 'completed',
			directory: '/fake',
		});

		// Symlink escape should be blocked
		expect(result.task_history['4.1'].files_touched).not.toContain(
			'src/evil.ts',
		);
		expect(result.task_history['4.1'].files_touched).toEqual([]);
	});

	test('forward slash normalization verified', () => {
		setLoadContextMap(() => makeContextMap());
		setSaveContextMap();
		setExistsSync(() => true);
		setRealpathSync((p) => p);
		setExtractFileSummary((rel) => ({
			path: rel,
			content_hash: 'x',
			mtime_ms: 0,
			purpose: '',
			summary: '',
		}));
		setReadFileSync(() => 'content');
		setAppendTaskHistory((map, summary) => ({
			...map,
			task_history: { ...map.task_history, [summary.task_id]: summary },
		}));
		setAppendDecision((map, d) => ({
			...map,
			decisions: [...map.decisions, d],
		}));

		const result = updateContextMapAfterAgent({
			task_id: '4.2',
			agent_role: 'coder',
			files_touched: ['src\\subdir\\file.ts', 'another/file.ts'],
			implementation_summary: 'Mixed separators',
			task_goal: 'Normalize',
			final_status: 'completed',
			directory: '/fake',
		});

		const touched = result.task_history['4.2'].files_touched;
		// All paths should be forward-slash normalized
		for (const f of touched) {
			expect(f).not.toContain('\\');
		}
	});
});

// ---------------------------------------------------------------------------
// Integration test with real filesystem
// ---------------------------------------------------------------------------

describe('updateContextMapAfterAgent — real filesystem', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		Object.assign(_internals, originalInternals);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { force: true, recursive: true });
		Object.assign(_internals, originalInternals);
	});

	test('creates context map file on disk', () => {
		// Write a real file to touch
		const testFile = path.join(tempDir, 'src', 'foo.ts');
		fs.mkdirSync(path.dirname(testFile), { recursive: true });
		fs.writeFileSync(testFile, 'export function foo() {}');

		const result = updateContextMapAfterAgent({
			task_id: '5.1',
			agent_role: 'coder',
			files_touched: ['src/foo.ts'],
			implementation_summary: 'Added foo',
			task_goal: 'Add foo function',
			final_status: 'completed',
			directory: tempDir,
		});

		// Context map should be created
		expect(result.files['src/foo.ts']).toBeDefined();
		expect(result.files['src/foo.ts']?.content_hash).toMatch(/^[a-f0-9]{64}$/);

		// File should exist on disk
		const mapPath = path.join(tempDir, '.swarm', 'context-map.json');
		expect(fs.existsSync(mapPath)).toBe(true);
	});

	test('updates existing context map on disk', () => {
		// Pre-create a context map
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const existingMap = makeContextMap({
			'existing.ts': {
				path: 'existing.ts',
				content_hash: 'oldhash',
				mtime_ms: 100,
				purpose: 'old purpose',
				summary: 'old summary',
				invariants: ['Old invariant'],
				risks: ['Old risk'],
				tests: ['old.test.ts'],
			},
		});
		fs.writeFileSync(
			path.join(swarmDir, 'context-map.json'),
			JSON.stringify(existingMap),
		);

		// Write a real file
		const testFile = path.join(tempDir, 'src', 'bar.ts');
		fs.mkdirSync(path.dirname(testFile), { recursive: true });
		fs.writeFileSync(testFile, 'export const bar = 1;');

		const result = updateContextMapAfterAgent({
			task_id: '5.2',
			agent_role: 'coder',
			files_touched: ['src/bar.ts'],
			implementation_summary: 'Added bar',
			task_goal: 'Add bar',
			final_status: 'completed',
			directory: tempDir,
		});

		// Both files should be present
		expect(result.files['existing.ts']).toBeDefined();
		expect(result.files['existing.ts']?.invariants).toEqual(['Old invariant']); // preserved
		expect(result.files['src/bar.ts']).toBeDefined();

		// Disk file should reflect update
		const diskMap: ContextMap = JSON.parse(
			fs.readFileSync(path.join(swarmDir, 'context-map.json'), 'utf-8'),
		);
		expect(diskMap.files['existing.ts']?.invariants).toEqual(['Old invariant']);
	});
});
