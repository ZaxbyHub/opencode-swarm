/**
 * Advisory CI evaluation tests (issue #2497).
 *
 * Pins the honest-disposition contract: per-task required gates with
 * #2470 tri-state evidence (valid / missing / corrupt are DISTINCT), the
 * rework_required workflow guard (no vacuous pass on non-terminal states),
 * plan-critic evaluation, quality-threshold no-data semantics, and the
 * plan_missing / plan_corrupt / no_tasks exit reasons.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	evaluateAdvisoryCi,
	MAX_SHADOW_COPY_BYTES,
	TERMINAL_SUCCESS_STATES,
} from '../../../src/ci/evaluate.js';
import {
	buildSatisfiedFixture,
	makeFixtureDir,
	writeCorruptEvidenceBundle,
	writeCorruptTaskEvidence,
	writeEvidenceBundle,
	writePlan,
	writeTaskEvidence,
} from './_fixtures.js';

describe('advisory evaluation constants', () => {
	test('TERMINAL_SUCCESS_STATES pins the terminal-success workflow vocabulary', () => {
		// Mirrors WORKFLOW_STATE_RANK's top two ranks ('complete': 8,
		// 'closed': 7) in src/gate-evidence.ts; any other workflow state is
		// reported and never a vacuous pass.
		expect([...TERMINAL_SUCCESS_STATES]).toEqual(['complete', 'closed']);
	});

	test('MAX_SHADOW_COPY_BYTES bounds the DB-mediated shadow read', () => {
		expect(MAX_SHADOW_COPY_BYTES).toBe(512 * 1024 * 1024);
	});
});

describe('evaluateAdvisoryCi', () => {
	test('satisfied fixture: every gate row passes, verdict pass', async () => {
		const dir = await buildSatisfiedFixture();
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.verdict).toBe('pass');
		expect(report.exit_reason).toBe('all_gates_passed');
		expect(report.gates.length).toBeGreaterThan(0);
		for (const row of report.gates) {
			expect(row.status, `gate ${row.name} should pass`).toBe('pass');
		}
		const task = report.tasks.find((t) => t.task_id === '1.1');
		expect(task?.evidence_state).toBe('valid');
		expect(task?.missing_gates).toEqual([]);
		expect(task?.satisfied).toBe(true);
		expect(report.environment).toEqual({
			mode: 'advisory',
			tty: false,
			host: 'none',
		});
	});

	test('missing gate evidence (violation): fail row naming the missing gate, exit 1 semantics', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-violation-');
		writePlan(dir, [{ id: '1.1', status: 'in_progress' }]);
		writeTaskEvidence(dir, {
			taskId: '1.1',
			satisfied: ['reviewer'],
			workflowState: 'reviewer_run',
		});
		writeEvidenceBundle(dir, {
			taskId: '1.1',
			review: 'approved',
			tests: { passed: 10, failed: 0 },
		});
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.verdict).toBe('fail');
		expect(report.exit_reason).toBe('gate_violations');
		const row = report.gates.find((g) => g.name === 'task 1.1 gates');
		expect(row?.status).toBe('fail');
		expect(row?.detail).toContain('test_engineer');
		const task = report.tasks.find((t) => t.task_id === '1.1');
		expect(task?.missing_gates).toEqual(['test_engineer']);
		expect(task?.satisfied).toBe(false);
	});

	test('rework_required workflow state is never a vacuous pass', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-rework-');
		writePlan(dir, [{ id: '1.1', status: 'in_progress' }]);
		// All required gates satisfied BUT the workflow says re-do.
		writeTaskEvidence(dir, {
			taskId: '1.1',
			satisfied: ['reviewer', 'test_engineer'],
			workflowState: 'rework_required',
		});
		writeEvidenceBundle(dir, {
			taskId: '1.1',
			review: 'approved',
			tests: { passed: 5, failed: 0 },
		});
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		const row = report.gates.find((g) => g.name === 'task 1.1 gates');
		expect(row?.status).toBe('fail');
		expect(row?.detail).toContain('rework_required');
		const task = report.tasks.find((t) => t.task_id === '1.1');
		expect(task?.missing_gates).toEqual([]);
		expect(task?.satisfied).toBe(false);
		expect(report.verdict).toBe('fail');
	});

	test('no-data task: no_data row, not a pass', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-nodata-');
		writePlan(dir, [{ id: '2.1', status: 'pending' }]);
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.verdict).toBe('fail');
		const row = report.gates.find((g) => g.name === 'task 2.1 gates');
		expect(row?.status).toBe('no_data');
		const task = report.tasks.find((t) => t.task_id === '2.1');
		expect(task?.evidence_state).toBe('missing');
		// Required-gate vocabulary still comes from the authoritative default
		// derivation even when evidence is absent.
		expect(task?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	test('corrupt evidence: corrupt row, distinct from missing', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-corrupt-');
		writePlan(dir, [{ id: '3.1', status: 'pending' }]);
		writeCorruptTaskEvidence(dir, '3.1');
		writeCorruptEvidenceBundle(dir, '3.1');
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		const row = report.gates.find((g) => g.name === 'task 3.1 gates');
		expect(row?.status).toBe('corrupt');
		const task = report.tasks.find((t) => t.task_id === '3.1');
		expect(task?.evidence_state).toBe('corrupt');
	});

	test('bundle corrupt while task evidence valid: corrupt surfaces from the bundle side', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-bundle-corrupt-');
		writePlan(dir, [{ id: '1.1', status: 'completed' }]);
		writeTaskEvidence(dir, {
			taskId: '1.1',
			satisfied: ['reviewer', 'test_engineer'],
			workflowState: 'complete',
		});
		writeCorruptEvidenceBundle(dir, '1.1');
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		const taskRow = report.gates.find((g) => g.name === 'task 1.1 gates');
		expect(taskRow?.status).toBe('pass');
		// The evidence-corpus quality checks see no data through loadEvidence
		// (invalid_schema bundles are not 'found'), so review/test rate rows
		// must be no_data — never pass.
		const review = report.gates.find((g) => g.name === 'review_pass_rate');
		expect(review?.status).toBe('no_data');
		const test = report.gates.find((g) => g.name === 'test_pass_rate');
		expect(test?.status).toBe('no_data');
		expect(report.verdict).toBe('fail');
	});

	test('missing plan: exit_reason plan_missing with plan diagnostic', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-noplan-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.verdict).toBe('fail');
		expect(report.exit_reason).toBe('plan_missing');
		const planRow = report.gates.find((g) => g.name === 'plan');
		expect(planRow?.status).toBe('no_data');
		expect(planRow?.detail).toContain('plan');
	});

	test('corrupt plan: exit_reason plan_corrupt', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-plan-corrupt-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), '{ nope');
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.exit_reason).toBe('plan_corrupt');
		const planRow = report.gates.find((g) => g.name === 'plan');
		expect(planRow?.status).toBe('corrupt');
	});

	test('zero-task plan: exit_reason no_tasks', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-notasks-');
		writePlan(dir, []);
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.exit_reason).toBe('no_tasks');
		expect(report.verdict).toBe('fail');
		const tasksRow = report.gates.find((g) => g.name === 'plan tasks');
		expect(tasksRow?.status).toBe('no_data');
	});

	test('plan-critic gate fails when no approval is recorded (critic_pre_plan default)', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-nocritic-');
		writePlan(dir, [{ id: '1.1', status: 'completed' }]);
		writeTaskEvidence(dir, {
			taskId: '1.1',
			satisfied: ['reviewer', 'test_engineer'],
			workflowState: 'complete',
		});
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		const row = report.gates.find((g) => g.name === 'plan_critic');
		expect(row?.status).toBe('fail');
		expect(report.verdict).toBe('fail');
	});

	test('not_evaluable lists the live-state checks; counts match the rows', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-noteval-');
		writePlan(dir, [{ id: '2.1', status: 'pending' }]);
		const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
		expect(report.not_evaluable.map((n) => n.name).sort()).toEqual([
			'agent_error_rate',
			'hard_limit_hits',
		]);
		const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
		expect(total).toBe(report.gates.length);
	});

	test('evaluation does not mutate the evaluated .swarm directory', async () => {
		const dir = makeFixtureDir('swarm-ci-tests-readonly-');
		writePlan(dir, [{ id: '1.1', status: 'completed' }]);
		writeTaskEvidence(dir, {
			taskId: '1.1',
			satisfied: ['reviewer', 'test_engineer'],
			workflowState: 'complete',
		});
		writeEvidenceBundle(dir, {
			taskId: '1.1',
			review: 'approved',
			tests: { passed: 3, failed: 0 },
		});
		const before = snapshotTree(dir);
		await evaluateAdvisoryCi({ directory: dir, tty: false });
		const after = snapshotTree(dir);
		expect(after).toEqual(before);
	});

	test('direct evaluation removes its shadow copy after success', async () => {
		const dir = makeFixtureDir('swarm-ci-shadow-cleanup-success-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		let shadowRoot: string | undefined;
		const realMkdtemp = fs.mkdtempSync.bind(fs);
		const mkdtempSpy = spyOn(fs, 'mkdtempSync').mockImplementation(((
			prefix: string,
			...rest: unknown[]
		) => {
			const root = realMkdtemp(prefix, ...(rest as any));
			if (prefix.includes('swarm-ci-shadow-')) shadowRoot = root;
			return root;
		}) as unknown as typeof fs.mkdtempSync);
		try {
			await evaluateAdvisoryCi({ directory: dir, tty: false });
			expect(shadowRoot).toBeDefined();
			expect(fs.existsSync(shadowRoot as string)).toBe(false);
		} finally {
			mkdtempSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);

	test('partial shadow-copy failure removes the allocated root', async () => {
		const dir = makeFixtureDir('swarm-ci-shadow-cleanup-partial-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		let shadowRoot: string | undefined;
		const realMkdtemp = fs.mkdtempSync.bind(fs);
		const mkdtempSpy = spyOn(fs, 'mkdtempSync').mockImplementation(((
			prefix: string,
			...rest: unknown[]
		) => {
			const root = realMkdtemp(prefix, ...(rest as any));
			if (prefix.includes('swarm-ci-shadow-')) shadowRoot = root;
			return root;
		}) as unknown as typeof fs.mkdtempSync);
		const readSpy = spyOn(fs, 'readSync').mockImplementation((() => {
			throw new Error('injected shadow-copy failure');
		}) as unknown as typeof fs.readSync);
		try {
			const report = await evaluateAdvisoryCi({ directory: dir, tty: false });
			expect(
				report.gates.find((gate) => gate.name === 'plan_critic')?.status,
			).toBe('error');
			expect(shadowRoot).toBeDefined();
			expect(fs.existsSync(shadowRoot as string)).toBe(false);
		} finally {
			readSpy.mockRestore();
			mkdtempSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);

	test('direct evaluation removes its shadow copy when downstream evaluation throws', async () => {
		const dir = makeFixtureDir('swarm-ci-shadow-cleanup-downstream-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		let shadowRoot: string | undefined;
		const realMkdtemp = fs.mkdtempSync.bind(fs);
		const mkdtempSpy = spyOn(fs, 'mkdtempSync').mockImplementation(((
			prefix: string,
			...rest: unknown[]
		) => {
			const root = realMkdtemp(prefix, ...(rest as any));
			if (prefix.includes('swarm-ci-shadow-')) shadowRoot = root;
			return root;
		}) as unknown as typeof fs.mkdtempSync);
		const originalSummary = _internals.computeEvidenceQualitySummary;
		_internals.computeEvidenceQualitySummary = async () => {
			throw new Error('injected downstream evaluation failure');
		};
		try {
			await expect(
				evaluateAdvisoryCi({ directory: dir, tty: false }),
			).rejects.toThrow('injected downstream evaluation failure');
			expect(shadowRoot).toBeDefined();
			expect(fs.existsSync(shadowRoot as string)).toBe(false);
		} finally {
			_internals.computeEvidenceQualitySummary = originalSummary;
			mkdtempSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);

	test('cleanup-registration failure removes its shadow copy before rethrowing', async () => {
		const dir = makeFixtureDir('swarm-ci-shadow-cleanup-registration-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		let shadowRoot: string | undefined;
		const realMkdtemp = fs.mkdtempSync.bind(fs);
		const mkdtempSpy = spyOn(fs, 'mkdtempSync').mockImplementation(((
			prefix: string,
			...rest: unknown[]
		) => {
			const root = realMkdtemp(prefix, ...(rest as any));
			if (prefix.includes('swarm-ci-shadow-')) shadowRoot = root;
			return root;
		}) as unknown as typeof fs.mkdtempSync);
		try {
			await expect(
				evaluateAdvisoryCi({
					directory: dir,
					tty: false,
					registerCleanup: () => {
						throw new Error('injected cleanup-registration failure');
					},
				}),
			).rejects.toThrow('injected cleanup-registration failure');
			expect(shadowRoot).toBeDefined();
			expect(fs.existsSync(shadowRoot as string)).toBe(false);
		} finally {
			mkdtempSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);
});

function snapshotTree(root: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				out.push([
					path.relative(root, full),
					String(fs.statSync(full).size) +
						':' +
						crypto
							.createHash('sha256')
							.update(fs.readFileSync(full))
							.digest('hex')
							.slice(0, 12),
				]);
			}
		}
	};
	const swarm = path.join(root, '.swarm');
	if (fs.existsSync(swarm)) walk(swarm);
	return out.sort((a, b) => a[0].localeCompare(b[0]));
}
