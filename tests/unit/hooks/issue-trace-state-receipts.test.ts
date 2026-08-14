/**
 * Tests for src/hooks/issue-trace-state.ts (receipt readers and plan readers).
 *
 * Split from issue-trace-state.test.ts to stay under the FR-006 line cap.
 * Covers: readSpecIssueNumber, readPlanPhaseStatus, loadPlanFromLedger,
 * planExists, reproductionReceiptExists, publicationReceiptExists, specExists,
 * and _internals failure injection (readSpecIssueNumber).
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	loadPlanFromLedger,
	planExists,
	publicationReceiptExists,
	readPlanPhaseStatus,
	readSpecIssueNumber,
	reproductionReceiptExists,
	specExists,
} from '../../../src/hooks/issue-trace-state';

// ---------------------------------------------------------------------------
// _internals snapshots (readFileSync, existsSync, loadPlanFromLedger)
// ---------------------------------------------------------------------------

const realReadFileSync = _internals.readFileSync;
const realExistsSync = _internals.existsSync;
const realLoadPlanFromLedger = _internals.loadPlanFromLedger;

afterEach(() => {
	_internals.readFileSync = realReadFileSync;
	_internals.existsSync = realExistsSync;
	_internals.loadPlanFromLedger = realLoadPlanFromLedger;
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
	test('readSpecIssueNumber returns null when readFileSync throws', () => {
		_internals.readFileSync = mock(() => {
			throw new Error('io error');
		});
		expect(readSpecIssueNumber('/project')).toBeNull();
	});
});
