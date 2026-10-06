/**
 * Epic v2 C3 — `src/epic/task-landing.ts`: the landing seam's Epic
 * side. No open epic costs exactly one sentinel check (nothing else is
 * read); a task of the open git epic lands as a commit with the Epic task
 * message (only on the epic branch); non-git
 * epics, tasks outside the plan and unreadable state fall back to the
 * caller's own behaviour. `_internals` DI only (AGENTS.md #7).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { EpicRecordV1 } from '../../../src/epic/lifecycle';
import {
	_internals,
	epicCommitLandingFor,
	epicIsolationDegradedMessage,
	resolveEpicTaskContext,
} from '../../../src/epic/task-landing';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';

const realInternals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, realInternals);
});

const TASK = {
	id: '1.1',
	phase: 1,
	description: 'build the thing',
	files: ['src/a.ts'],
};

function withEpic(
	record: EpicRecordV1 | null,
	branchOk = true,
	staged = '',
): string[] {
	const calls: string[] = [];
	_internals.gitExecOnce = ((args: string[]) => {
		calls.push(`git ${args.join(' ')}`);
		return staged;
	}) as never;
	_internals.epicSentinelExists = () => {
		calls.push('sentinel');
		return true;
	};
	_internals.getOpenEpic = (() => {
		calls.push('epic');
		return record;
	}) as never;
	_internals.readPlanTaskRef = ((_dir: string, id: string) => {
		calls.push('plan');
		return id === TASK.id ? TASK : null;
	}) as never;
	_internals.checkEpicBranch = (() => {
		calls.push('branch');
		return branchOk
			? { ok: true }
			: {
					ok: false,
					code: 'EPIC_BRANCH_MISMATCH',
					expected: 'swarm/epic/k',
					actual: 'main',
					message: 'EPIC_BRANCH_MISMATCH: off branch',
				};
	}) as never;
	return calls;
}

describe('no open epic', () => {
	test('one sentinel check and nothing else', () => {
		const calls = withEpic(stubEpicRecord());
		_internals.epicSentinelExists = () => {
			calls.push('sentinel');
			return false;
		};
		expect(resolveEpicTaskContext('/p', '1.1')).toBeNull();
		expect(epicCommitLandingFor('/p', '1.1')).toBeUndefined();
		expect(calls).toEqual(['sentinel', 'sentinel']);
	});
});

describe('open git epic', () => {
	test('landing: committed, with the Epic task message and plan trailer', () => {
		withEpic(stubEpicRecord({ planKey: 'feedfacecafebeef' }));
		expect(epicCommitLandingFor('/p', '1.1')).toEqual({
			commitLanding: true,
			landingCommitMessage:
				'swarm(task 1.1): build the thing\n\nSwarm-Plan: feedfacecafebeef',
		});
	});

	test('staged entries in the primary index ⇒ the landing is refused EPIC_LANDING_INDEX_DIRTY', () => {
		const calls = withEpic(stubEpicRecord(), true, 'other.txt\0README.md\0');
		const refusal = epicCommitLandingFor('/p', '1.1');
		expect(refusal).toMatchObject({
			refused: true,
			stage: 'epic-landing-index',
		});
		if (refusal && 'refused' in refusal) {
			expect(refusal.message).toStartWith('EPIC_LANDING_INDEX_DIRTY');
			expect(refusal.message).toContain(
				'git restore --staged -- other.txt README.md',
			);
		}
		// One single-attempt read of the index.
		expect(calls.filter((c) => c.startsWith('git '))).toEqual([
			'git diff --cached --name-only -z',
		]);
		// An unreadable index fails closed too.
		_internals.gitExecOnce = (() => {
			throw new Error('index.lock');
		}) as never;
		expect(epicCommitLandingFor('/p', '1.1')).toMatchObject({
			refused: true,
		});
	});

	test('landing off the epic branch, or for a task outside the plan ⇒ the default', () => {
		withEpic(stubEpicRecord(), false);
		expect(epicCommitLandingFor('/p', '1.1')).toBeUndefined();
		withEpic(stubEpicRecord());
		expect(epicCommitLandingFor('/p', '9.9')).toBeUndefined();
		expect(epicCommitLandingFor('/p', undefined)).toBeUndefined();
		expect(epicCommitLandingFor('/p', '  ')).toBeUndefined();
	});
});

describe('non-git, orphaned or unreadable epics fall back', () => {
	test('non-git epic: no committed landing (main-tree serial)', () => {
		const nonGit = stubEpicRecord({
			config: {
				commitPolicy: 'current-branch',
				isolation: 'main-tree-nogit',
				maxParallel: 1,
			},
			git: {
				isRepo: false,
				baseCommit: null,
				originalBranch: null,
				epicBranch: null,
			},
		});
		const calls = withEpic(nonGit);
		expect(epicCommitLandingFor('/p', '1.1')).toBeUndefined();
		expect(calls).not.toContain('branch');
	});

	test('orphaned (probe null) or unreadable (probe throws) ⇒ no epic', () => {
		withEpic(null);
		expect(resolveEpicTaskContext('/p', '1.1')).toBeNull();
		withEpic(stubEpicRecord());
		_internals.getOpenEpic = (() => {
			throw new Error('multiple Epic lifecycle rows present');
		}) as never;
		expect(epicCommitLandingFor('/p', '1.1')).toBeUndefined();
	});
});

test('the refusal names the cause and both remedies', () => {
	const text = epicIsolationDegradedMessage('1.1', 'provision failed');
	expect(text).toStartWith('EPIC_ISOLATION_DEGRADED: task 1.1');
	expect(text).toContain('provision failed');
	expect(text).toContain('retry the dispatch');
	expect(text).toContain('/swarm epic close --abandon');
});
