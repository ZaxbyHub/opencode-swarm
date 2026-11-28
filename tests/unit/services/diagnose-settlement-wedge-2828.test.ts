/**
 * Issue #2828 — the "Coder Settlements" diagnose check must surface the
 * settlement_wedge class: a task whose workflow drifted to idle/blocked
 * while a COMMITTED accepted coder settlement plus green post-settlement
 * pre-check proof still justify Stage A. Pins the end-to-end diagnose
 * rendering (task line + /swarm recover remediation) for both shapes so the
 * category can never be silently dropped from operator output again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	settleAt,
	writeCommittedWal,
	writeGreenBundles,
} from '../workflow/_settlement-recovery-2828-helpers';

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('diagnose-sw-2828-'));
});

afterEach(() => {
	resetSwarmState();
	cleanup();
});

function findCheck(
	checks: Array<{ name: string; status: string; detail: string }>,
	name: string,
) {
	return checks.find((entry) => entry.name === name);
}

describe('diagnose — settlement_wedge visibility (issue #2828)', () => {
	test('surfaces the idle settlement wedge with the recover remediation', async () => {
		await settleAt(directory, '2.1', 'idle');
		writeCommittedWal(directory, '2.1');
		await writeGreenBundles(directory);

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');

		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('task 2.1 [settlement_wedge]');
		expect(check?.detail).toContain('workflow at idle');
		expect(check?.detail).toContain('/swarm recover 2.1');
		expect(check?.detail).toContain('settlement_wedge');
	});

	test('surfaces the blocked settlement wedge with the recover remediation', async () => {
		await settleAt(directory, '2.2', 'blocked');
		writeCommittedWal(directory, '2.2');
		await writeGreenBundles(directory);

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');

		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('task 2.2 [settlement_wedge]');
		expect(check?.detail).toContain('workflow at blocked');
		expect(check?.detail).toContain('/swarm recover 2.2');
	});

	// The requirements-receipt fallback made the chain-verified
	// accepted_mutation transition a settlement fact, so the settleAt
	// fixture is receipt-backed rather than receipts-less. Its bundles
	// predate the receipt, so the wedge is real and the remediation must
	// name the pre-check bar rather than promise a passing repair.
	test('a receipt-backed idle task whose proof predates the receipt is a wedge naming the pre-check bar', async () => {
		await settleAt(directory, '2.3', 'idle');
		await writeGreenBundles(directory);

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');

		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('task 2.3 [settlement_wedge]');
		expect(check?.detail).toContain('workflow at idle');
		expect(check?.detail).toContain('run pre_check_batch first');
		expect(check?.detail).toContain('/swarm recover 2.3');
	});
});
