/**
 * Epic v2 C4 — `resolveEpicDispatchPolicy`: wave-only coder admission and
 * the wave's parallel / isolation / slot policy, decided from the FROZEN
 * wave record. Every reject code, the allow shapes, and the Epic-off path
 * (one sentinel check, nothing else). `_internals` DI only (AGENTS.md #7).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	computeEpicWaveVerdict,
	epicWaveVerdictOptions,
	resolveEpicDispatchPolicy,
} from '../../../src/epic/gate-policy';
import type { EpicRecordV1 } from '../../../src/epic/lifecycle';
import {
	issuedWaveForTest,
	stubEpicRecord,
} from '../../helpers/epic-lifecycle';

const realInternals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, realInternals);
});

type Status = Plan['phases'][number]['tasks'][number]['status'];

function plan(statuses: Record<string, Status> = {}): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Gate Policy',
		swarm: 'gate-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: ['1.1', '1.2', '1.3'].map((id) => ({
					id,
					phase: 1,
					status: statuses[id] ?? 'pending',
					size: 'small' as const,
					description: `task ${id}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
}

const WAVE = issuedWaveForTest({
	'1.1': ['src/a.ts', 'tests/a.test.ts'],
	'1.2': ['src/b.ts'],
});

function withEpic(
	record: EpicRecordV1 | null | Error,
	branchOk = true,
	configOn = true,
): string[] {
	const calls: string[] = [];
	_internals.epicSentinelExists = () => {
		calls.push('sentinel');
		return true;
	};
	_internals.isEpicModeConfigEnabledForDirectory = () => {
		calls.push('config');
		return configOn;
	};
	_internals.getOpenEpic = ((_dir: string, p: Plan) => {
		calls.push(`epic:${p.title}`);
		if (record instanceof Error) throw record;
		return record;
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
					message: 'EPIC_BRANCH_MISMATCH: HEAD is on `main`. Remedy: checkout',
				};
	}) as never;
	return calls;
}

const openWave = (overrides: Partial<EpicRecordV1> = {}) =>
	stubEpicRecord({ waves: [WAVE], activeWaveSeq: 1, ...overrides });

describe('no open epic ⇒ null', () => {
	test('sentinel absent: one check, nothing else', () => {
		const calls = withEpic(openWave());
		_internals.epicSentinelExists = () => {
			calls.push('sentinel');
			return false;
		};
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toBeNull();
		expect(calls).toEqual(['sentinel']);
	});

	test('no open epic for this plan (orphaned / closing)', () => {
		const calls = withEpic(null);
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toBeNull();
		// The plan's identity is used — plan.json is not re-read.
		expect(calls).toEqual(['sentinel', 'config', 'epic:Gate Policy']);
	});

	test('Epic disabled by config: null BEFORE the row is read — even a corrupt row', () => {
		const calls = withEpic(
			new Error('multiple Epic lifecycle rows present'),
			true,
			false,
		);
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toBeNull();
		expect(calls).toEqual(['sentinel', 'config']);
	});
});

describe('a closing epic refuses dispatch (EPIC_CLOSING)', () => {
	/**
	 * `getOpenEpic` returns null for any row that is not `open`, so a `closing`
	 * row left by an interrupted close silently ungated dispatch for the whole
	 * window between `markEpicClosing` and `deleteEpicState` — the window in
	 * which a dispatched coder would settle with no Epic context and merge back
	 * onto the branch the close is stepping off.
	 */
	function withClosingEpic(): void {
		withEpic(null);
		_internals.inspectEpic = (() => ({
			sentinelPresent: true,
			sentinel: null,
			record: stubEpicRecord({ status: 'closing' }),
			rowKeys: ['k'],
			unreadable: null,
			orphanReason: null,
			configEnabled: true,
		})) as never;
	}

	test('a closing row is refused, not treated as "no epic"', () => {
		withClosingEpic();
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.1', []);
		expect(policy).toMatchObject({ kind: 'reject', code: 'EPIC_CLOSING' });
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('is closing');
			expect(policy.message).toContain('/swarm epic close');
		}
	});

	test('a genuinely absent epic is still null (the control)', () => {
		withEpic(null);
		_internals.inspectEpic = (() => ({
			sentinelPresent: true,
			sentinel: null,
			record: null,
			rowKeys: [],
			unreadable: null,
			orphanReason: null,
			configEnabled: true,
		})) as never;
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toBeNull();
	});

	test('an open record never reaches the closing probe', () => {
		// The allow path must be unchanged: the probe only runs when
		// `getOpenEpic` came back null.
		withEpic(openWave());
		let inspected = 0;
		_internals.inspectEpic = (() => {
			inspected += 1;
			return { record: null } as never;
		}) as never;
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toMatchObject({
			kind: 'allow',
		});
		expect(inspected).toBe(0);
	});
});

describe('reject codes', () => {
	test('EPIC_STATE_UNREADABLE', () => {
		withEpic(new Error('multiple Epic lifecycle rows present'));
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.1', []);
		expect(policy).toMatchObject({
			kind: 'reject',
			code: 'EPIC_STATE_UNREADABLE',
		});
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('multiple Epic lifecycle rows');
			expect(policy.message).toContain('Epic Mode is enabled');
			expect(policy.message).toContain('fail closed');
			expect(policy.message).toContain('/swarm epic close --abandon');
		}
	});

	test('EPIC_BRANCH_MISMATCH (code prefix not repeated in the message)', () => {
		withEpic(openWave(), false);
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.1', []);
		expect(policy).toEqual({
			kind: 'reject',
			code: 'EPIC_BRANCH_MISMATCH',
			message: 'HEAD is on `main`. Remedy: checkout',
		});
	});

	test.each([
		['a task outside the plan', '9.9'],
		['no task id', null],
		['a blank task id', '  '],
	])('EPIC_TASK_UNKNOWN for %s', (_label, taskId) => {
		withEpic(openWave());
		const policy = resolveEpicDispatchPolicy('/p', plan(), taskId, []);
		expect(policy).toMatchObject({ kind: 'reject', code: 'EPIC_TASK_UNKNOWN' });
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('epic_next_wave');
		}
	});

	test.each([
		['no wave issued yet', { waves: [], activeWaveSeq: null }],
		[
			'the active wave is no longer issued',
			{ waves: [{ ...WAVE, status: 'closed' as const }], activeWaveSeq: 1 },
		],
		['a dangling active pointer', { waves: [WAVE], activeWaveSeq: 7 }],
	])('EPIC_NO_ACTIVE_WAVE: %s', (_label, overrides) => {
		withEpic(stubEpicRecord(overrides));
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.1', []);
		expect(policy).toMatchObject({
			kind: 'reject',
			code: 'EPIC_NO_ACTIVE_WAVE',
		});
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('call epic_next_wave');
			expect(policy.message).not.toContain('is in review');
		}
	});

	test('EPIC_NO_ACTIVE_WAVE while a phase is in review names the fix-task path', () => {
		withEpic(
			stubEpicRecord({
				waves: [{ ...WAVE, status: 'closed' as const }],
				activeWaveSeq: null,
				phases: { '1': { status: 'review', reviewRuns: 1, verdicts: [] } },
			}),
		);
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.1', []);
		expect(policy).toMatchObject({ code: 'EPIC_NO_ACTIVE_WAVE' });
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('Phase 1 is in review');
			expect(policy.message).toContain('NEW pending task of phase 1');
			expect(policy.message).toContain('save_plan');
		}
	});

	test('EPIC_TASK_NOT_IN_ACTIVE_WAVE', () => {
		withEpic(openWave());
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.3', []);
		expect(policy).toMatchObject({
			kind: 'reject',
			code: 'EPIC_TASK_NOT_IN_ACTIVE_WAVE',
		});
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('active wave 1 (tasks: 1.1, 1.2)');
		}
	});

	test('EPIC_WAVE_SCOPE_DRIFT: a live scope outside the frozen one', () => {
		withEpic(openWave());
		const policy = resolveEpicDispatchPolicy('/p', plan(), '1.2', [
			'src/b.ts',
			'src/c.ts',
		]);
		expect(policy).toMatchObject({
			kind: 'reject',
			code: 'EPIC_WAVE_SCOPE_DRIFT',
		});
		if (policy?.kind === 'reject') {
			expect(policy.message).toContain('outside: src/c.ts; frozen: src/b.ts');
			expect(policy.message).toContain('replace_existing: true');
		}
	});

	test('a subset of the frozen scope is not drift', () => {
		withEpic(openWave());
		for (const live of [[], null, ['src/a.ts'], ['tests/a.test.ts']]) {
			expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', live)?.kind).toBe(
				'allow',
			);
		}
	});

	test("containment (the write gates' predicate): a frozen directory covers files beneath it", () => {
		const dirWave = issuedWaveForTest({ '1.1': ['src'], '1.2': ['lib/b.ts'] });
		withEpic(stubEpicRecord({ waves: [dirWave], activeWaveSeq: 1 }));
		expect(
			resolveEpicDispatchPolicy('/p', plan(), '1.1', ['src/one.ts'])?.kind,
		).toBe('allow');
		expect(
			resolveEpicDispatchPolicy('/p', plan(), '1.1', ['src/deep/two.ts'])?.kind,
		).toBe('allow');
		const drift = resolveEpicDispatchPolicy('/p', plan(), '1.1', ['lib/x']);
		expect(drift).toMatchObject({ code: 'EPIC_WAVE_SCOPE_DRIFT' });
		// A sibling with the same prefix is not beneath the directory.
		expect(
			resolveEpicDispatchPolicy('/p', plan(), '1.1', ['srcx/a.ts']),
		).toMatchObject({ code: 'EPIC_WAVE_SCOPE_DRIFT' });
		if (drift?.kind === 'reject') {
			expect(drift.message).toContain('re-declare the task within the frozen');
			expect(drift.message).toContain('NEW pending task');
			expect(drift.message).toContain('/swarm epic close --abandon');
		}
	});
});

describe('allow', () => {
	test('two unresolved disjoint wave tasks ⇒ parallel, isolated, maxParallel slots', () => {
		withEpic(openWave());
		expect(
			resolveEpicDispatchPolicy('/p', plan(), '1.1', ['src/a.ts']),
		).toEqual({
			kind: 'allow',
			parallel: true,
			isolate: true,
			maxConcurrent: 4,
		});
	});

	test('a single-task wave is serial (still isolated)', () => {
		const solo = issuedWaveForTest({ '1.1': ['src/a.ts'] });
		withEpic(stubEpicRecord({ waves: [solo], activeWaveSeq: 1 }));
		expect(
			resolveEpicDispatchPolicy('/p', plan(), '1.1', ['src/a.ts']),
		).toEqual({
			kind: 'allow',
			parallel: false,
			isolate: true,
			maxConcurrent: 4,
		});
	});

	test('the last unresolved task of a wave is serial', () => {
		withEpic(openWave());
		expect(
			resolveEpicDispatchPolicy('/p', plan({ '1.2': 'completed' }), '1.1', []),
		).toMatchObject({ kind: 'allow', parallel: false, isolate: true });
		expect(
			resolveEpicDispatchPolicy('/p', plan({ '1.2': 'closed' }), '1.1', []),
		).toMatchObject({ parallel: false });
		// Re-dispatching a resolved task never makes the wave parallel.
		expect(
			resolveEpicDispatchPolicy('/p', plan({ '1.1': 'completed' }), '1.1', []),
		).toMatchObject({ parallel: false });
	});

	test('frozen overlapping scopes or frozen co-change pairs ⇒ serial', () => {
		const overlap = issuedWaveForTest({
			'1.1': ['src/shared.ts'],
			'1.2': ['src/shared.ts'],
		});
		withEpic(stubEpicRecord({ waves: [overlap], activeWaveSeq: 1 }));
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toMatchObject({
			parallel: false,
		});
		const coupled = {
			...WAVE,
			cochange: {
				pairs: [
					{ fileA: 'src/a.ts', fileB: 'src/b.ts', npmi: 0.9, coChangeCount: 5 },
				],
				threshold: { npmi: 0.5, minCoChanges: 2 },
			},
		};
		withEpic(stubEpicRecord({ waves: [coupled], activeWaveSeq: 1 }));
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toMatchObject({
			parallel: false,
		});
	});

	test('a throwing verdict fails safe to serial', () => {
		withEpic(openWave());
		_internals.computeParallelVerdict = (() => {
			throw new RangeError('too many');
		}) as never;
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toMatchObject({
			kind: 'allow',
			parallel: false,
			isolate: true,
		});
	});

	test('non-git epic: main tree, serial, one slot (M-i)', () => {
		const calls = withEpic(
			openWave({
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
			}),
		);
		let verdicts = 0;
		_internals.computeParallelVerdict = (() => {
			verdicts += 1;
			throw new Error('not expected');
		}) as never;
		expect(resolveEpicDispatchPolicy('/p', plan(), '1.1', [])).toEqual({
			kind: 'allow',
			parallel: false,
			isolate: false,
			maxConcurrent: 1,
		});
		expect(verdicts).toBe(0);
		expect(calls).toContain('branch');
	});
});

describe('the wave verdict', () => {
	test('is computeParallelVerdict over the frozen scopes (+ frozen pairs)', () => {
		const coupled = {
			files: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
			cochange: {
				pairs: [
					{ fileA: 'src/a.ts', fileB: 'src/b.ts', npmi: 0.9, coChangeCount: 5 },
				],
				threshold: { npmi: 0.5, minCoChanges: 2 },
			},
		};
		const options = epicWaveVerdictOptions(plan(), coupled);
		expect(options).toMatchObject({
			scopes: coupled.files,
			useCochange: true,
			cochangeThreshold: coupled.cochange.threshold,
			cochangePairs: [
				{ fileA: 'src/a.ts', fileB: 'src/b.ts', npmi: 0.9, coChangeCount: 5 },
			],
		});
		expect(
			computeEpicWaveVerdict('/nonexistent', plan(), coupled, ['1.1', '1.2'])
				.verdict,
		).toBe('conflicts_present');
		expect(
			epicWaveVerdictOptions(plan(), { files: coupled.files, cochange: null }),
		).toEqual({ plan: plan(), scopes: coupled.files, useCochange: false });
	});
});
