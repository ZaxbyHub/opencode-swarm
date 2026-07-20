/**
 * Unit tests for resolveDelegatedPlanTaskId and describeCoderScopeFailure.
 *
 * Direct `_internals` testing of the pure resolver + diagnostic helper.
 * Covers issue #1914 Defect 1 (task_id collision fall-through) and Defect 2
 * (cause-specific diagnostics).
 *
 * Integration-level coverage (end-to-end via toolBefore) lives in
 * delegation-gate-scope-preflight-membership.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals as delegationGateInternals } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

const {
	resolveDelegatedPlanTaskId,
	describeCoderScopeFailure,
	resolveEvidenceTaskId,
} = delegationGateInternals;

const PLAN_TASK_IDS = new Set(['1.1', '1.2', '2.1']);

describe('resolveDelegatedPlanTaskId — issue #1914 Defect 1', () => {
	describe('explicit task_id field handling', () => {
		test('plan-task-shaped explicit task_id is honored', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ task_id: '1.1', prompt: 'TASK: 2.1 — other' },
					PLAN_TASK_IDS,
				),
			).toBe('1.1');
		});

		test('plan-task-shaped explicit taskId (camelCase) is honored', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ taskId: '2.1', prompt: 'TASK: 1.1 — other' },
					PLAN_TASK_IDS,
				),
			).toBe('2.1');
		});

		test('non-plan-shaped explicit task_id (ses_ session id) falls through to TASK: line extraction', () => {
			// The core #1914 acceptance criterion 1: a runtime-injected session id
			// must not defeat text extraction of a valid TASK: line.
			expect(
				resolveDelegatedPlanTaskId(
					{
						task_id: 'ses_abc123def456',
						prompt: 'TASK: 3.4 — implement feature\nACCEPTANCE: done',
					},
					new Set(['3.4', '3.5']),
				),
			).toBe('3.4');
		});

		test('non-plan-shaped explicit task_id without TASK: line but with id in prompt text falls through', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ task_id: 'ses_xyz', description: 'Implement 1.2 here' },
					PLAN_TASK_IDS,
				),
			).toBe('1.2');
		});

		test('non-plan-shaped explicit task_id with no resolvable text signal returns null', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ task_id: 'ses_xyz', prompt: 'Do some work' },
					PLAN_TASK_IDS,
				),
			).toBeNull();
		});

		test('arbitrary non-plan-shaped string falls through (not just ses_ prefix)', () => {
			// Guard against future runtime session-id shapes.
			expect(
				resolveDelegatedPlanTaskId(
					{ task_id: 'runtime-session-handle', prompt: 'TASK: 1.1 — x' },
					PLAN_TASK_IDS,
				),
			).toBe('1.1');
		});

		test('plan-task-shaped-but-unknown explicit task_id is returned (membership gate is downstream)', () => {
			// The resolver does NOT validate plan membership for explicit plan-task-shaped
			// values — prepareCoderScope's membership gate handles that. This preserves
			// PR #961's "explicit id takes precedence" intent for plan-task-shaped values.
			expect(
				resolveDelegatedPlanTaskId(
					{ task_id: '9.9', prompt: 'TASK: 1.1 — other' },
					PLAN_TASK_IDS,
				),
			).toBe('9.9');
		});

		test('explicit plan-task-shaped value > 20 chars falls through (length guard)', () => {
			// Edge case: the length guard treats overly-long values as non-plan-shaped.
			const longId = '1.1.1.1.1.1.1.1.1.1.1.1.1'; // >20 chars
			expect(
				resolveDelegatedPlanTaskId(
					{ task_id: longId, prompt: 'TASK: 1.1 — real' },
					PLAN_TASK_IDS,
				),
			).toBe('1.1');
		});
	});

	describe('no explicit field — text extraction', () => {
		test('unambiguous TASK: line extracts the id', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ prompt: 'TASK: 2.1 — implement feature\nACCEPTANCE: done' },
					PLAN_TASK_IDS,
				),
			).toBe('2.1');
		});

		test('ambiguous TASK: line (>=2 distinct plan ids) fails closed', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ prompt: 'TASK: port from 1.1 to 2.1' },
					PLAN_TASK_IDS,
				),
			).toBeNull();
		});

		test('single id in prompt text (no TASK: line) extracts', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ description: 'Implement 1.2 here' },
					PLAN_TASK_IDS,
				),
			).toBe('1.2');
		});

		test('multiple distinct ids in prompt text fails closed', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ description: 'Fix 1.1 and also 2.1' },
					PLAN_TASK_IDS,
				),
			).toBeNull();
		});

		test('version-like patterns are filtered out by plan membership', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ prompt: 'Upgrade from v6.33.7 to v6.34.0\nTASK: 1.1' },
					PLAN_TASK_IDS,
				),
			).toBe('1.1');
		});

		test('no signal at all returns null', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{ prompt: 'Just do some work' },
					PLAN_TASK_IDS,
				),
			).toBeNull();
		});

		test('TASK: line id wins over other ids in prompt text', () => {
			expect(
				resolveDelegatedPlanTaskId(
					{
						prompt: 'Related to 2.1.\nTASK: 1.1 — the actual task',
					},
					PLAN_TASK_IDS,
				),
			).toBe('1.1');
		});
	});
});

describe('describeCoderScopeFailure — issue #1914 Defect 2', () => {
	test('ambiguity in TASK: line lists candidates and known ids', () => {
		const msg = describeCoderScopeFailure(
			{ prompt: 'TASK: port from 1.1 to 2.1' },
			PLAN_TASK_IDS,
		);
		expect(msg).toContain('multiple candidate task ids found in TASK: line');
		expect(msg).toContain('1.1');
		expect(msg).toContain('2.1');
		expect(msg).toContain('Known plan task ids:');
	});

	test('ambiguity in prompt text (no TASK: line) lists candidates', () => {
		const msg = describeCoderScopeFailure(
			{ description: 'Fix 1.1 and also 2.1' },
			PLAN_TASK_IDS,
		);
		expect(msg).toContain('multiple candidate task ids found in prompt text');
		expect(msg).toContain('1.1');
		expect(msg).toContain('2.1');
	});

	test('no signal reports explicit-field shape, TASK: line detection, and known ids', () => {
		const msg = describeCoderScopeFailure(
			{ prompt: 'Just do some work' },
			PLAN_TASK_IDS,
		);
		expect(msg).toContain('no plan task id could be resolved');
		expect(msg).toContain('Explicit task_id field: absent');
		expect(msg).toContain('TASK: line detected: no');
		expect(msg).toContain('Known plan task ids:');
	});

	test('non-plan-shaped explicit field is reported with shape and fall-through note', () => {
		const msg = describeCoderScopeFailure(
			{ task_id: 'ses_abc123', prompt: 'Do work' },
			PLAN_TASK_IDS,
		);
		expect(msg).toContain('non-plan-shaped');
		expect(msg).toContain('falling through to text extraction');
		expect(msg).toContain('ses_abc123');
	});

	test('TASK: line detected but no plan id present reports detection status', () => {
		const msg = describeCoderScopeFailure(
			{ prompt: 'TASK: 9.9 — unknown task' },
			PLAN_TASK_IDS,
		);
		// 9.9 is not in PLAN_TASK_IDS so it's filtered out → no candidates →
		// falls to the "no signal" branch, but TASK: line detection is still yes.
		expect(msg).toContain('TASK: line detected: yes');
		expect(msg).toContain('no plan task id could be resolved');
	});

	test('long explicit-field value is truncated in the diagnostic', () => {
		const longValue = `ses_${'a'.repeat(60)}`;
		const msg = describeCoderScopeFailure(
			{ task_id: longValue, prompt: 'Do work' },
			PLAN_TASK_IDS,
		);
		// .slice(0, 40) caps the rendered value.
		expect(msg).toContain('ses_');
		// The full 60-char value should NOT appear intact.
		expect(msg).not.toContain('a'.repeat(60));
	});

	test('empty known-plan-ids set renders (none)', () => {
		const msg = describeCoderScopeFailure(
			{ prompt: 'Do work' },
			new Set<string>(),
		);
		expect(msg).toContain('Known plan task ids: (none)');
	});
});

describe('resolveEvidenceTaskId — issue #1914 plan-critic item 3 (transitive behavior change)', () => {
	let directory: string;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-evidence-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Evidence attribution',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'P1',
						status: 'in_progress',
						tasks: [
							{
								id: '2.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'T2.1',
								depends: [],
								files_touched: ['src/a.ts'],
							},
						],
					},
				],
			}),
		);
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('reviewer dispatch with ses_ task_id + TASK: 2.1 attributes evidence to 2.1 (not session fallback)', async () => {
		// Issue #1914 critic item 3: resolveEvidenceTaskId calls the shared
		// resolveDelegatedPlanTaskId, so Edit 1's fall-through changes its
		// behavior. A reviewer/test_engineer dispatch with a runtime-injected
		// ses_ task_id should now text-extract the TASK: id (correct
		// attribution) instead of returning null and dropping to the
		// session-state fallback.
		const session = ensureAgentSession('rev-session', 'reviewer', directory);
		// Set a STALE currentTaskId that the OLD behavior would have fallen
		// back to — proves the new behavior picks the TASK: id instead.
		session.currentTaskId = '9.9';

		const resolved = await resolveEvidenceTaskId(
			{
				task_id: 'ses_reviewer-session-id',
				prompt: 'TASK: 2.1 — review the implementation\nACCEPTANCE: reviewed',
			},
			session,
			directory,
		);
		expect(resolved).toBe('2.1');
	});

	test('plan-task-shaped explicit task_id still wins (regression)', async () => {
		const session = ensureAgentSession('rev-session-2', 'reviewer', directory);
		session.currentTaskId = '2.1';
		const resolved = await resolveEvidenceTaskId(
			{ task_id: '2.1', prompt: 'TASK: 9.9 — other' },
			session,
			directory,
		);
		expect(resolved).toBe('2.1');
	});
});
