import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTaskToolId } from '../../../src/hooks/normalize-tool-name';
import { scanSourceText } from '../../helpers/task-tool-id-scanner';

/**
 * Issue #2529 review follow-up (PRR-006): every delegation-gate task-path
 * guard was converted to the shared `isTaskToolId` boundary, which accepts the
 * host's lowercase `task` id AND the legacy `Task` spelling while rejecting
 * dot-bearing filesystem tool ids. These fixtures pin the boundary matrix the
 * gate now relies on and ratchet the gate's own source: reverting any of the
 * six converted guards drops the isTaskToolId count, and reintroducing a
 * normalizer-derived task comparison trips the #2529 provenance scan.
 *
 * (The old 104-fixture `tool: 'Task'` suite keeps covering the legacy
 * spelling; these fixtures cover the spellings it never exercised.)
 */

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const GATE_SOURCE_PATH = path.join(
	REPO_ROOT,
	'src',
	'hooks',
	'delegation-gate.ts',
);

describe('delegation gate host task tool id (issue #2529)', () => {
	test('the boundary accepts the host id, legacy spelling, and namespace prefixes', () => {
		expect(isTaskToolId('task')).toBe(true); // pinned host id (v1.18.3)
		expect(isTaskToolId('Task')).toBe(true); // legacy plugin-side spelling
		expect(isTaskToolId('TASK')).toBe(true); // case-insensitive compat
		expect(isTaskToolId('opencode:task')).toBe(true); // namespaced host id
		expect(isTaskToolId('mega:Task')).toBe(true);
		expect(isTaskToolId('tool.execute.Task')).toBe(true); // SDK hook namespace
		expect(isTaskToolId('tool.execute.TASK')).toBe(true);
	});

	test('the boundary rejects dot-bearing custom tool ids and malformed spellings', () => {
		// normalizeToolName('notes.task') truncates to 'task' — the exact
		// false-positive class the boundary exists to prevent.
		expect(isTaskToolId('notes.task')).toBe(false);
		expect(isTaskToolId('my.tool.task')).toBe(false);
		expect(isTaskToolId('task.')).toBe(false);
		expect(isTaskToolId(':task')).toBe(false);
		expect(isTaskToolId('task:')).toBe(false);
		expect(isTaskToolId(' task')).toBe(false);
		expect(isTaskToolId('task ')).toBe(false);
		expect(isTaskToolId('')).toBe(false);
		expect(isTaskToolId(undefined)).toBe(false);
		expect(isTaskToolId('subtask')).toBe(false);
	});

	test('gate source routes every task-path guard through the boundary', () => {
		const source = fs.readFileSync(GATE_SOURCE_PATH, 'utf8');
		const violations = scanSourceText('src/hooks/delegation-gate.ts', source);
		expect(violations.map((v) => `${v.kind}:${v.line}: ${v.source}`)).toEqual(
			[],
		);
		// Exactly five guards call the boundary directly (toolBefore
		// coder-scope prep, toolAfter background-noop, critic preflight,
		// post-preflight early-out, the isTaskTool projection); the
		// completion-revoke block reuses that projected boolean.
		const boundaryUses = source.match(/\bisTaskToolId\(/g)?.length ?? 0;
		expect(boundaryUses).toBe(5);
	});
});
