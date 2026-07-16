/**
 * Tests for src/hooks/issue-trace-state.ts
 *
 * Uses _internals DI seam (AGENTS.md invariant 7) to override filesystem
 * calls without mock.module leakage. All _internals are overridden per-test
 * and restored in afterEach.
 *
 * Covers:
 * - readIssueReference: present, absent, malformed
 * - readTraceState: present, absent, malformed (returns default)
 * - writeTraceState: round-trip write+read, atomic temp pattern, cleanup on failure
 * - readSpecIssueNumber: Number field, URL extraction, absent section, unparseable
 * - readPlanPhaseStatus: all complete, partial, no plan
 * - specExists / planExists: true / false
 * - _internals failure injection
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	loadPlanFromLedger,
	planExists,
	readIssueReference,
	readPlanPhaseStatus,
	readSpecIssueNumber,
	readTraceState,
	specExists,
	writeTraceState,
} from '../../../src/hooks/issue-trace-state';

// ---------------------------------------------------------------------------
// _internals snapshots
// ---------------------------------------------------------------------------

const realReadFileSync = _internals.readFileSync;
const realWriteFileSync = _internals.writeFileSync;
const realExistsSync = _internals.existsSync;
const realRenameSync = _internals.renameSync;
const realMkdirSync = _internals.mkdirSync;
const realUnlinkSync = _internals.unlinkSync;
const realLoadPlanFromLedger = _internals.loadPlanFromLedger;

afterEach(() => {
	_internals.readFileSync = realReadFileSync;
	_internals.writeFileSync = realWriteFileSync;
	_internals.existsSync = realExistsSync;
	_internals.renameSync = realRenameSync;
	_internals.mkdirSync = realMkdirSync;
	_internals.unlinkSync = realUnlinkSync;
	_internals.loadPlanFromLedger = realLoadPlanFromLedger;
});

// ---------------------------------------------------------------------------
// readIssueReference
// ---------------------------------------------------------------------------

describe('readIssueReference', () => {
	const dir = '/project';

	test('returns parsed object when file is present and valid', () => {
		const ref = {
			url: 'https://github.com/owner/repo/issues/42',
			owner: 'owner',
			repo: 'repo',
			number: 42,
			timestamp: '2026-01-01T00:00:00Z',
			flags: { trace: true },
		};
		_internals.readFileSync = mock(() => JSON.stringify(ref));

		const result = readIssueReference(dir);
		expect(result).toEqual(ref);
		expect(result?.number).toBe(42);
	});

	test('returns null when file is absent (throws ENOENT)', () => {
		_internals.readFileSync = mock(() => {
			throw Object.assign(new Error('not found'), { code: 'ENOENT' });
		});

		expect(readIssueReference(dir)).toBeNull();
	});

	test('returns null when file contains malformed JSON', () => {
		_internals.readFileSync = mock(() => 'not-json{{{');

		expect(readIssueReference(dir)).toBeNull();
	});

	test('returns null when parsed JSON is empty object (shape validation)', () => {
		_internals.readFileSync = mock(() => '{}');

		expect(readIssueReference(dir)).toBeNull();
	});

	test('returns null when parsed JSON has flags:null (shape validation)', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				url: 'https://github.com/o/r/issues/1',
				owner: 'o',
				repo: 'r',
				number: 1,
				timestamp: '2026-01-01T00:00:00Z',
				flags: null,
			}),
		);

		expect(readIssueReference(dir)).toBeNull();
	});

	test('returns parsed object when all required fields are valid strings/numbers/objects', () => {
		const ref = {
			url: 'https://github.com/owner/repo/issues/42',
			owner: 'owner',
			repo: 'repo',
			number: 42,
			timestamp: '2026-01-01T00:00:00Z',
			flags: { trace: true },
		};
		_internals.readFileSync = mock(() => JSON.stringify(ref));

		const result = readIssueReference(dir);
		expect(result).toEqual(ref);
	});

	test('returns null when url is not a github.com HTTPS URL', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				url: 'file:///etc/passwd',
				owner: 'owner',
				repo: 'repo',
				number: 42,
				timestamp: '2026-01-01T00:00:00Z',
				flags: { trace: true },
			}),
		);

		expect(readIssueReference(dir)).toBeNull();
	});

	test('returns null when url uses http (not https)', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				url: 'http://github.com/owner/repo/issues/42',
				owner: 'owner',
				repo: 'repo',
				number: 42,
				timestamp: '2026-01-01T00:00:00Z',
				flags: { trace: true },
			}),
		);

		expect(readIssueReference(dir)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// readTraceState
// ---------------------------------------------------------------------------

describe('readTraceState', () => {
	const dir = '/project';

	test('returns parsed state when file is present and valid', () => {
		const state = {
			issueNumber: 42,
			lastTransition: 'PLAN_TO_EXECUTE',
			completed: false,
		};
		_internals.readFileSync = mock(() => JSON.stringify(state));

		expect(readTraceState(dir)).toEqual(state);
	});

	test('returns default state when file is absent', () => {
		_internals.readFileSync = mock(() => {
			throw Object.assign(new Error('not found'), { code: 'ENOENT' });
		});

		const result = readTraceState(dir);
		expect(result).toEqual({
			issueNumber: 0,
			lastTransition: null,
			completed: false,
		});
	});

	test('returns default state when file contains malformed JSON', () => {
		_internals.readFileSync = mock(() => '{broken');

		const result = readTraceState(dir);
		expect(result).toEqual({
			issueNumber: 0,
			lastTransition: null,
			completed: false,
		});
	});

	test('returns default state when parsed JSON has wrong issueNumber type (shape validation)', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				issueNumber: 'not-a-number',
				lastTransition: null,
				completed: false,
			}),
		);

		const result = readTraceState(dir);
		expect(result).toEqual({
			issueNumber: 0,
			lastTransition: null,
			completed: false,
		});
	});

	test('returns default state when parsed JSON is empty object (shape validation)', () => {
		_internals.readFileSync = mock(() => '{}');

		const result = readTraceState(dir);
		expect(result).toEqual({
			issueNumber: 0,
			lastTransition: null,
			completed: false,
		});
	});
});

// ---------------------------------------------------------------------------
// writeTraceState
// ---------------------------------------------------------------------------

describe('writeTraceState', () => {
	const dir = '/project';
	const swarmDir = join(dir, '.swarm');
	const targetPath = join(swarmDir, 'issue-trace-state.json');

	test('writes JSON to temp file then renames atomically', () => {
		const mkdirCalls: string[] = [];
		const writeCalls: Array<{ path: string; data: string }> = [];
		const renameCalls: Array<{ from: string; to: string }> = [];

		_internals.mkdirSync = mock((p: string) => {
			mkdirCalls.push(p);
		});
		_internals.writeFileSync = mock((p: string, data: string) => {
			writeCalls.push({ path: p, data });
		});
		_internals.renameSync = mock((from: string, to: string) => {
			renameCalls.push({ from, to });
		});

		const state = { issueNumber: 42, lastTransition: null, completed: false };
		writeTraceState(dir, state);

		expect(mkdirCalls).toEqual([swarmDir]);
		expect(writeCalls.length).toBe(1);
		expect(writeCalls[0].path).toContain('issue-trace-state.tmp.');
		expect(JSON.parse(writeCalls[0].data)).toEqual(state);
		expect(renameCalls).toEqual([{ from: writeCalls[0].path, to: targetPath }]);
	});

	test('cleans up temp file on rename failure after unlink+retry, then re-throws', () => {
		const unlinkCalls: string[] = [];
		_internals.mkdirSync = mock(() => {});
		_internals.writeFileSync = mock(() => {});
		let renameCallCount = 0;
		_internals.renameSync = mock(() => {
			renameCallCount++;
			throw new Error('rename failed');
		});
		_internals.unlinkSync = mock((p: string) => {
			unlinkCalls.push(p);
		});

		expect(() =>
			writeTraceState(dir, {
				issueNumber: 1,
				lastTransition: null,
				completed: false,
			}),
		).toThrow('rename failed');

		// First rename fails → unlink target (finalPath) → second rename fails → unlink temp
		// So unlinkCalls should have finalPath then tmpPath
		expect(renameCallCount).toBe(2);
		expect(unlinkCalls.length).toBe(2);
	});

	test('succeeds on first rename without unlink', () => {
		const unlinkCalls: string[] = [];
		_internals.mkdirSync = mock(() => {});
		_internals.writeFileSync = mock(() => {});
		let renameCallCount = 0;
		_internals.renameSync = mock(() => {
			renameCallCount++;
		});
		_internals.unlinkSync = mock((p: string) => {
			unlinkCalls.push(p);
		});

		writeTraceState(dir, {
			issueNumber: 1,
			lastTransition: null,
			completed: false,
		});

		expect(renameCallCount).toBe(1);
		expect(unlinkCalls.length).toBe(0);
	});

	test('ignores cleanup failures on unlink after rename error', () => {
		_internals.mkdirSync = mock(() => {});
		_internals.writeFileSync = mock(() => {});
		let renameCallCount = 0;
		_internals.renameSync = mock(() => {
			renameCallCount++;
			throw new Error('rename failed');
		});
		_internals.unlinkSync = mock(() => {
			throw new Error('unlink also failed');
		});

		// Should throw the original rename error, not the unlink error
		expect(() =>
			writeTraceState(dir, {
				issueNumber: 1,
				lastTransition: null,
				completed: false,
			}),
		).toThrow('rename failed');
	});
});

// ---------------------------------------------------------------------------
// readSpecIssueNumber
// ---------------------------------------------------------------------------

describe('readSpecIssueNumber', () => {
	const dir = '/project';

	test('extracts issue number from "- Number: N" line', () => {
		const spec =
			'## Source Issue\n- Number: 1688\n- URL: https://github.com/org/repo/issues/1688\n\n## Background\n...';
		_internals.readFileSync = mock(() => spec);

		expect(readSpecIssueNumber(dir)).toBe(1688);
	});

	test('extracts issue number from URL when Number line absent', () => {
		const spec =
			'## Source Issue\n- URL: https://github.com/org/repo/issues/42\n\n## Background';
		_internals.readFileSync = mock(() => spec);

		expect(readSpecIssueNumber(dir)).toBe(42);
	});

	test('returns null when ## Source Issue section is absent', () => {
		_internals.readFileSync = mock(() => '# Spec\n## Background\nSome text');

		expect(readSpecIssueNumber(dir)).toBeNull();
	});

	test('returns null when section exists but no number/URL parseable', () => {
		const spec = '## Source Issue\n- Title: some issue\n\n## Background';
		_internals.readFileSync = mock(() => spec);

		expect(readSpecIssueNumber(dir)).toBeNull();
	});

	test('returns null when file is absent', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('ENOENT');
		});

		expect(readSpecIssueNumber(dir)).toBeNull();
	});

	test('bounds extraction to section before next heading', () => {
		const spec =
			'## Source Issue\n- Number: 100\n\n## Other Section\n- Number: 999';
		_internals.readFileSync = mock(() => spec);

		expect(readSpecIssueNumber(dir)).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// readPlanPhaseStatus
// ---------------------------------------------------------------------------

describe('readPlanPhaseStatus', () => {
	test('returns allComplete false when plan is null (no plan file)', async () => {
		// With no real plan.json on disk, loadPlanJsonOnly returns null
		const result = await readPlanPhaseStatus('/nonexistent');
		expect(result).toEqual({ allComplete: false });
	});

	test('returns allComplete false for nonexistent directory', async () => {
		const result = await readPlanPhaseStatus('/nonexistent-dir');
		expect(result.allComplete).toBe(false);
	});

	test('returns allComplete false when plan has empty phases array', async () => {
		_internals.loadPlanFromLedger = mock(async () => ({ phases: [] }) as Plan);

		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ allComplete: false });
	});

	test('returns allComplete true when all phases are complete', async () => {
		_internals.loadPlanFromLedger = mock(
			async () =>
				({
					phases: [{ status: 'complete' }, { status: 'completed' }],
				}) as Plan,
		);

		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ allComplete: true });
	});

	test('returns allComplete false when some phases are incomplete', async () => {
		_internals.loadPlanFromLedger = mock(
			async () =>
				({
					phases: [{ status: 'complete' }, { status: 'in_progress' }],
				}) as Plan,
		);

		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ allComplete: false });
	});
});

// ---------------------------------------------------------------------------
// loadPlanFromLedger
// ---------------------------------------------------------------------------

describe('loadPlanFromLedger', () => {
	test('returns null for nonexistent directory (plan.json absent)', async () => {
		const result = await loadPlanFromLedger('/nonexistent-dir');
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// specExists / planExists
// ---------------------------------------------------------------------------

describe('specExists', () => {
	test('returns true when spec.md exists', () => {
		_internals.existsSync = mock((p: string) => p.endsWith('spec.md'));
		expect(specExists('/project')).toBe(true);
	});

	test('returns false when spec.md does not exist', () => {
		_internals.existsSync = mock(() => false);
		expect(specExists('/project')).toBe(false);
	});
});

describe('planExists', () => {
	test('returns true when plan.json exists', () => {
		_internals.existsSync = mock((p: string) => p.endsWith('plan.json'));
		expect(planExists('/project')).toBe(true);
	});

	test('returns false when plan.json does not exist', () => {
		_internals.existsSync = mock(() => false);
		expect(planExists('/project')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// _internals failure injection
// ---------------------------------------------------------------------------

describe('_internals failure injection', () => {
	test('readIssueReference returns null when readFileSync throws arbitrary error', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('permission denied');
		});
		expect(readIssueReference('/project')).toBeNull();
	});

	test('readTraceState returns default when readFileSync throws arbitrary error', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('disk error');
		});
		const result = readTraceState('/project');
		expect(result).toEqual({
			issueNumber: 0,
			lastTransition: null,
			completed: false,
		});
	});

	test('readSpecIssueNumber returns null when readFileSync throws', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('io error');
		});
		expect(readSpecIssueNumber('/project')).toBeNull();
	});

	test('specExists propagates existsSync result correctly on error path', () => {
		_internals.existsSync = mock(() => {
			throw new Error('access denied');
		});
		// existsSync doesn't normally throw, but if it does, the error propagates
		expect(() => specExists('/project')).toThrow('access denied');
	});
});
