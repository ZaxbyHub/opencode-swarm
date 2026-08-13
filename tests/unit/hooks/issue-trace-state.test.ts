/**
 * Tests for src/hooks/issue-trace-state.ts
 *
 * Uses _internals DI seam (AGENTS.md invariant 7) to override filesystem
 * calls without mock.module leakage. All _internals are overridden per-test
 * and restored in afterEach.
 *
 * Issue #2131 finding 2: covers the typed `status` model (with legacy
 * `completed` backward-compat), authoritative `planExists`/readPlanPhaseStatus
 * (2.3), and the reproduction/publication receipt readers (2.6/2.4).
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	loadPlanFromLedger,
	planExists,
	publicationReceiptExists,
	readIssueReference,
	readPlanPhaseStatus,
	readSpecIssueNumber,
	readTraceState,
	reproductionReceiptExists,
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
const realReproductionReceiptExists = _internals.reproductionReceiptExists;
const realPublicationReceiptExists = _internals.publicationReceiptExists;

const DEFAULT_STATE = {
	issueNumber: 0,
	lastTransition: null,
	status: 'in_progress',
};

afterEach(() => {
	_internals.readFileSync = realReadFileSync;
	_internals.writeFileSync = realWriteFileSync;
	_internals.existsSync = realExistsSync;
	_internals.renameSync = realRenameSync;
	_internals.mkdirSync = realMkdirSync;
	_internals.unlinkSync = realUnlinkSync;
	_internals.loadPlanFromLedger = realLoadPlanFromLedger;
	_internals.reproductionReceiptExists = realReproductionReceiptExists;
	_internals.publicationReceiptExists = realPublicationReceiptExists;
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
		expect(readIssueReference(dir)).toEqual(ref);
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
});

// ---------------------------------------------------------------------------
// readTraceState (status model + legacy completed backward-compat)
// ---------------------------------------------------------------------------

describe('readTraceState', () => {
	const dir = '/project';

	test('returns parsed state when file is present and valid (status shape)', () => {
		const state = {
			issueNumber: 42,
			lastTransition: 'PLAN_TO_EXECUTE',
			status: 'in_progress',
		};
		_internals.readFileSync = mock(() => JSON.stringify(state));
		expect(readTraceState(dir)).toEqual(state);
	});

	test('legacy completed:false → status:in_progress (backward-compat)', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				issueNumber: 42,
				lastTransition: null,
				completed: false,
			}),
		);
		expect(readTraceState(dir)).toEqual({
			issueNumber: 42,
			lastTransition: null,
			status: 'in_progress',
		});
	});

	test('legacy completed:true → status:publication_handoff (NOT resolved)', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				issueNumber: 42,
				lastTransition: 'EXECUTE_TO_COMMIT',
				completed: true,
			}),
		);
		expect(readTraceState(dir)).toEqual({
			issueNumber: 42,
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
	});

	test('returns default state when file is absent', () => {
		_internals.readFileSync = mock(() => {
			throw Object.assign(new Error('not found'), { code: 'ENOENT' });
		});
		expect(readTraceState(dir)).toEqual(DEFAULT_STATE);
	});

	test('returns default state when file contains malformed JSON', () => {
		_internals.readFileSync = mock(() => '{broken');
		expect(readTraceState(dir)).toEqual(DEFAULT_STATE);
	});

	test('returns default state when parsed JSON has wrong issueNumber type', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				issueNumber: 'not-a-number',
				lastTransition: null,
				status: 'in_progress',
			}),
		);
		expect(readTraceState(dir)).toEqual(DEFAULT_STATE);
	});

	test('returns default state when parsed JSON is empty object', () => {
		_internals.readFileSync = mock(() => '{}');
		expect(readTraceState(dir)).toEqual(DEFAULT_STATE);
	});

	test('an invalid status enum value falls back to in_progress', () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({
				issueNumber: 42,
				lastTransition: null,
				status: 'bogus',
			}),
		);
		expect(readTraceState(dir)).toEqual({
			issueNumber: 42,
			lastTransition: null,
			status: 'in_progress',
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
		_internals.mkdirSync = mock((p: string) => mkdirCalls.push(p));
		_internals.writeFileSync = mock((p: string, data: string) =>
			writeCalls.push({ path: p, data }),
		);
		_internals.renameSync = mock((from: string, to: string) =>
			renameCalls.push({ from, to }),
		);

		const state = {
			issueNumber: 42,
			lastTransition: null,
			status: 'in_progress' as const,
		};
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
		_internals.unlinkSync = mock((p: string) => unlinkCalls.push(p));

		expect(() =>
			writeTraceState(dir, {
				issueNumber: 1,
				lastTransition: null,
				status: 'in_progress',
			}),
		).toThrow('rename failed');
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
		_internals.unlinkSync = mock((p: string) => unlinkCalls.push(p));

		writeTraceState(dir, {
			issueNumber: 1,
			lastTransition: null,
			status: 'in_progress',
		});
		expect(renameCallCount).toBe(1);
		expect(unlinkCalls.length).toBe(0);
	});

	test('ignores cleanup failures on unlink after rename error', () => {
		_internals.mkdirSync = mock(() => {});
		_internals.writeFileSync = mock(() => {});
		_internals.renameSync = mock(() => {
			throw new Error('rename failed');
		});
		_internals.unlinkSync = mock(() => {
			throw new Error('unlink also failed');
		});
		expect(() =>
			writeTraceState(dir, {
				issueNumber: 1,
				lastTransition: null,
				status: 'in_progress',
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

	test('bounds extraction to section before next heading', () => {
		const spec =
			'## Source Issue\n- Number: 100\n\n## Other Section\n- Number: 999';
		_internals.readFileSync = mock(() => spec);
		expect(readSpecIssueNumber(dir)).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// readPlanPhaseStatus (authoritative — returns planExists + allComplete)
// ---------------------------------------------------------------------------

describe('readPlanPhaseStatus', () => {
	test('returns planExists false + allComplete false when plan is null', async () => {
		_internals.loadPlanFromLedger = mock(async () => null);
		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: false, allComplete: false });
	});

	test('returns planExists false when plan has empty phases array', async () => {
		_internals.loadPlanFromLedger = mock(async () => ({ phases: [] }) as Plan);
		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: false, allComplete: false });
	});

	test('returns planExists true + allComplete true when all phases complete', async () => {
		_internals.loadPlanFromLedger = mock(
			async () =>
				({
					phases: [{ status: 'complete' }, { status: 'completed' }],
				}) as Plan,
		);
		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: true, allComplete: true });
	});

	test('returns allComplete false when some phases are incomplete', async () => {
		_internals.loadPlanFromLedger = mock(
			async () =>
				({
					phases: [{ status: 'complete' }, { status: 'in_progress' }],
				}) as Plan,
		);
		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: true, allComplete: false });
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
// planExists (authoritative — ledger-aware, async)
// ---------------------------------------------------------------------------

describe('planExists', () => {
	test('returns true when an authoritative plan with phases loads', async () => {
		_internals.loadPlanFromLedger = mock(
			async () => ({ phases: [{ status: 'complete' }] }) as Plan,
		);
		expect(await planExists('/project')).toBe(true);
	});

	test('returns false when the authoritative plan is null', async () => {
		_internals.loadPlanFromLedger = mock(async () => null);
		expect(await planExists('/project')).toBe(false);
	});

	test('returns false when the plan has no phases', async () => {
		_internals.loadPlanFromLedger = mock(async () => ({ phases: [] }) as Plan);
		expect(await planExists('/project')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// reproduction / publication receipt readers (issue #2131 2.6 / 2.4)
// ---------------------------------------------------------------------------

describe('reproductionReceiptExists', () => {
	test('true when receipt performed and issueNumber matches', async () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({ performed: true, issueNumber: 42 }),
		);
		expect(await reproductionReceiptExists('/project', 42)).toBe(true);
	});

	test('false when receipt issueNumber differs', async () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({ performed: true, issueNumber: 999 }),
		);
		expect(await reproductionReceiptExists('/project', 42)).toBe(false);
	});

	test('false when performed is not true', async () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({ performed: false, issueNumber: 42 }),
		);
		expect(await reproductionReceiptExists('/project', 42)).toBe(false);
	});

	test('false when file is absent', async () => {
		_internals.readFileSync = mock(() => {
			throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
		});
		expect(await reproductionReceiptExists('/project', 42)).toBe(false);
	});
});

describe('publicationReceiptExists', () => {
	test('true when published is true and issueNumber matches', async () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({ published: true, issueNumber: 42, prNumber: 7 }),
		);
		expect(await publicationReceiptExists('/project', 42)).toBe(true);
	});

	test('false when issueNumber differs (issue-bound)', async () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({ published: true, issueNumber: 999, prNumber: 7 }),
		);
		expect(await publicationReceiptExists('/project', 42)).toBe(false);
	});

	test('false when published is not true', async () => {
		_internals.readFileSync = mock(() =>
			JSON.stringify({ published: false, issueNumber: 42 }),
		);
		expect(await publicationReceiptExists('/project', 42)).toBe(false);
	});

	test('false when file is absent', async () => {
		_internals.readFileSync = mock(() => {
			throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
		});
		expect(await publicationReceiptExists('/project', 42)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// specExists
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

// ---------------------------------------------------------------------------
// _internals failure injection
// ---------------------------------------------------------------------------

describe('_internals failure injection', () => {
	test('readTraceState returns default when readFileSync throws arbitrary error', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('disk error');
		});
		expect(readTraceState('/project')).toEqual(DEFAULT_STATE);
	});

	test('readSpecIssueNumber returns null when readFileSync throws', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('io error');
		});
		expect(readSpecIssueNumber('/project')).toBeNull();
	});
});
