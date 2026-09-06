import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	handleResetCommand,
	_internals as resetInternals,
} from '../../../src/commands/reset';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import { getPlanLedgerState } from '../../../src/plan/ledger-sqlite';
import { savePlan } from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalResetInternals = { ...resetInternals };

let tempDir: string;

beforeEach(async () => {
	tempDir = canonicalMkdtemp('swarm-reset-failure-test-');
	await mkdir(join(tempDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	Object.assign(resetInternals, originalResetInternals);
	if (existsSync(tempDir)) {
		closeProjectDb(tempDir);
		await rm(tempDir, { recursive: true, force: true });
	}
});

// ── EBUSY / LOCKED FILE ERROR HANDLING (FR-007) ──────────────────────────────
// Simulates EBUSY through the reset command's _internals dependency-injection
// seam. The seam keeps this test isolated without Bun's process-wide
// mock.module leakage and verifies that non-critical cleanup remains fail-open.
describe('EBUSY simulation for locked files during reset (FR-007)', () => {
	test('reports friendly error for EBUSY on a noncritical file and continues processing', async () => {
		const contextPath = join(tempDir, '.swarm', 'context.md');
		await writeFile(contextPath, 'context');
		const ebusiError = Object.assign(
			new Error('EBUSY: resource busy or locked'),
			{
				code: 'EBUSY',
			},
		);

		resetInternals.unlinkSync = ((
			filePath: Parameters<typeof resetInternals.unlinkSync>[0],
		) => {
			if (filePath === contextPath) throw ebusiError;
			return originalResetInternals.unlinkSync(filePath);
		}) as typeof resetInternals.unlinkSync;

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('❌ Failed to delete context.md');
	});
});

// ── EACCES / PERMISSION DENIED + rmSync FAILURE PATH (FR-014) ─────────────────────
// Exercises the authoritative projection deletion failure through the same
// _internals seam. The test asserts fail-closed reset behavior and preserves
// the prior ledger/projection bytes for retry.
describe('EACCES simulation for permission-denied files during reset (FR-014)', () => {
	test('aborts and preserves authority when plan.json cannot be deleted', async () => {
		const planPath = join(tempDir, '.swarm', 'plan.json');
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Surviving reset plan',
			swarm: 'reset-test',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
		};
		await savePlan(tempDir, plan);
		const ledgerPath = join(tempDir, '.swarm', 'plan-ledger.jsonl');
		const markdownPath = join(tempDir, '.swarm', 'plan.md');
		const planBefore = await readFile(planPath);
		const markdownBefore = await readFile(markdownPath);
		const ledgerBefore = await readFile(ledgerPath);
		const stateBefore = getPlanLedgerState(tempDir);
		const eaccesError = Object.assign(new Error('EACCES: permission denied'), {
			code: 'EACCES',
		});

		resetInternals.unlinkSync = ((
			filePath: Parameters<typeof resetInternals.unlinkSync>[0],
		) => {
			if (filePath === planPath) throw eaccesError;
			return originalResetInternals.unlinkSync(filePath);
		}) as typeof resetInternals.unlinkSync;

		const resetResult = await handleResetCommand(tempDir, ['--confirm']);

		expect(resetResult).toContain('## Swarm Reset Aborted');
		expect(resetResult).toContain('EACCES');
		expect(resetResult).not.toContain('Swarm Reset Complete');
		expect(existsSync(planPath)).toBe(true);
		expect(existsSync(ledgerPath)).toBe(true);
		expect(await readFile(planPath)).toEqual(planBefore);
		expect(await readFile(markdownPath)).toEqual(markdownBefore);
		expect(await readFile(ledgerPath)).toEqual(ledgerBefore);
		expect(getPlanLedgerState(tempDir)).toEqual(stateBefore);
	});

	test('reports compensation failures when restoring a deleted critical projection fails', async () => {
		const planPath = join(tempDir, '.swarm', 'plan.json');
		const markdownPath = join(tempDir, '.swarm', 'plan.md');
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Restore-failure plan',
			swarm: 'reset-test',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
		};
		await savePlan(tempDir, plan);
		const originalClearPlanLedgerForReset =
			resetInternals.clearPlanLedgerForReset;
		const originalWriteFileSync = resetInternals.writeFileSync;
		resetInternals.clearPlanLedgerForReset = async () => {
			throw new Error('ledger cleanup failed');
		};
		const restoreError = Object.assign(new Error('EACCES: restore failed'), {
			code: 'EACCES',
		});

		resetInternals.writeFileSync = ((
			filePath: Parameters<typeof resetInternals.writeFileSync>[0],
			data: Parameters<typeof resetInternals.writeFileSync>[1],
		) => {
			if (filePath === planPath) throw restoreError;
			return originalWriteFileSync(filePath, data);
		}) as typeof resetInternals.writeFileSync;

		try {
			const resetResult = await handleResetCommand(tempDir, ['--confirm']);

			expect(resetResult).toContain('## Swarm Reset Aborted');
			expect(resetResult).toContain('Compensation failed');
			expect(resetResult).toContain('plan.json: EACCES: restore failed');
			expect(existsSync(planPath)).toBe(false);
			expect(existsSync(markdownPath)).toBe(true);
		} finally {
			resetInternals.clearPlanLedgerForReset = originalClearPlanLedgerForReset;
			resetInternals.writeFileSync = originalWriteFileSync;
		}
	});
});
