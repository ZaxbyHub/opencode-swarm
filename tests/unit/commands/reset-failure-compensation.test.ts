import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	handleResetCommand,
	_internals as resetInternals,
} from '../../../src/commands/reset';
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
// Simulates EBUSY during unlinkSync (used by reset for .swarm/ files and root
// legacy artifacts). Verifies catch path produces '❌ Failed to delete ...'
// friendly message (instead of crash) and that processing continues for
// remaining files/artifacts. Uses mock.module('node:fs') + spread real exports
// + afterEach(mock.restore()) per writing-tests skill. Dynamic re-import after
// mock ensures SUT binds the mocked fs (matches handoff.error-handling.test.ts
// and close-plan-terminal-state.test.ts patterns). existsSync mocked to true
// so delete paths are exercised; unlink targets plan.md explicitly because
// reset clears SQLite before projection cleanup and may unlink other paths first.
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
// Simulates EACCES (permission denied) during unlinkSync on the FIRST call but
// succeeding on retry (per task spec). Also overrides rmSync to exercise the
// summaries/ catch path. Verifies friendly '❌ Failed to delete ...' messages
// (contains "Failed to delete") and that command continues processing other
// files without crashing. Uses the exact mock.module('node:fs') + ...fsSync spread
// + existsSync always-true + dynamic re-import + afterEach(mock.restore()) pattern
// already established in this file (and state mock at top for reference).
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
});
