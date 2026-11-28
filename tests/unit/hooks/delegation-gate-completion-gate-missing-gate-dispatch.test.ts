import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { canRunWhileTaskAwaitsCompletion } from '../../../src/hooks/delegation-gate';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

/**
 * The guard half of the tests_run catch-22 (2026-11-25): when a task's
 * required-gate set is complete for the gates it KNOWS (e.g. reviewer +
 * test_engineer) but an advisory gate receipt is still missing (the
 * escalation-required sounding-board consult grows required_gates only
 * through its own event), the task sits at tests_run and the completion
 * gate used to block the missing gate's dispatch — the consult could never
 * land. `canRunWhileTaskAwaitsCompletion` now permits a host Task dispatch
 * of a gate agent whose gate the awaiting task has NOT bound yet, in the
 * task-less prose shape (sounding board) or explicitly for the awaiting
 * task. Everything else keeps the completion remedy first-class.
 */
describe('completion gate: still-missing gate dispatches at tests_run (catch-22)', () => {
	let tempDir: string;
	const TASK = '3.1';

	beforeEach(() => {
		tempDir = mkdtempSync(
			path.join(canonicalTmpDir(), 'completion-missing-gate-'),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Seeds a task at tests_run with reviewer+TE bound, SB unbound. */
	async function seedAwaitingTaskAtTestsRun(): Promise<void> {
		await transitionTaskWorkflowEvidence(tempDir, TASK, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `mut:${TASK}`,
		});
		await transitionTaskWorkflowEvidence(tempDir, TASK, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `stage-a:${TASK}`,
		});
		await transitionTaskWorkflowEvidence(tempDir, TASK, {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'rev-sess',
			routeComplete: true,
			expectedGeneration: 1,
			transitionId: `rev:${TASK}`,
		});
		await transitionTaskWorkflowEvidence(tempDir, TASK, {
			type: 'stage_b_completed',
			gate: 'test_engineer',
			sessionId: 'te-sess',
			routeComplete: true,
			expectedGeneration: 1,
			transitionId: `te:${TASK}`,
		});
	}

	const canRun = (
		normalizedTool: string,
		args: Record<string, unknown>,
		requestedTaskId: string | null,
	) =>
		canRunWhileTaskAwaitsCompletion({
			directory: tempDir,
			normalizedTool,
			args,
			awaitingTaskId: TASK,
			requestedTaskId,
		});

	it('permits the task-less sounding-board dispatch (the unbound escalation consult)', async () => {
		await seedAwaitingTaskAtTestsRun();
		expect(
			canRun('task', { subagent_type: 'critic_sounding_board' }, null),
		).toBe(true);
	});

	it('permits an explicitly-awaiting-task dispatch of an unbound gate agent', async () => {
		await seedAwaitingTaskAtTestsRun();
		expect(
			canRun('task', { subagent_type: 'critic_sounding_board' }, TASK),
		).toBe(true);
	});

	it('still blocks the re-dispatch of an already-bound gate (redundant work)', async () => {
		await seedAwaitingTaskAtTestsRun();
		expect(canRun('task', { subagent_type: 'reviewer' }, TASK)).toBe(false);
		expect(canRun('task', { subagent_type: 'test_engineer' }, TASK)).toBe(
			false,
		);
	});

	it('still blocks non-gate agents and other tools (the completion remedy stays first-class)', async () => {
		await seedAwaitingTaskAtTestsRun();
		expect(canRun('task', { subagent_type: 'coder' }, TASK)).toBe(false);
		expect(
			canRun('task', { subagent_type: 'critic_sounding_board' }, '9.9'),
		).toBe(false);
		expect(canRun('declare_scope', {}, null)).toBe(false);
		expect(canRun('write', { file_path: 'src/x.ts' }, null)).toBe(false);
	});

	it('fail-closes on an unreadable evidence file (no dispatch permission without proof)', async () => {
		await seedAwaitingTaskAtTestsRun();
		// Corrupt the evidence file: the raw reader throws on invalid
		// JSON, and the exemption must keep the block instead of
		// permitting on a fault.
		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			`${TASK}.json`,
		);
		const { writeFileSync, mkdirSync } = await import('node:fs');
		mkdirSync(path.dirname(evidencePath), { recursive: true });
		writeFileSync(evidencePath, '{not-json');
		expect(
			canRun('task', { subagent_type: 'critic_sounding_board' }, null),
		).toBe(false);
	});
});
