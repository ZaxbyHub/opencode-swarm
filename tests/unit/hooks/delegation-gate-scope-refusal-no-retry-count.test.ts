/**
 * A scope-prep refusal must not count as a coder retry failure (the
 * 2026-11-26 task 2.16 retry-circuit wedge).
 *
 * Faked wedge arc from the live incident: after ONE real coder failure (a
 * provider-budget abort), every further gate-side refusal of a coder
 * dispatch — a scope-prep error, no child ever running — wrote a
 * `dispatch_no_mutation` retry-accounting transition. The refusals
 * themselves pushed the task to the bounded retry threshold, demanded a
 * critic consultation, burned the critic-guided simplified retry with
 * ANOTHER refusal, and wedged the task at TASK_RETRY_USER_ESCALATION_REQUIRED
 * with no coder attempt in between.
 *
 * Pins: a refused dispatch leaves retryCount, lastOutcome, and the
 * transition chain untouched; repeated refusals do not spiral into the
 * escalation ladder; the escalation events file stays empty for the task.
 * The explicit empty-plan-scope settlement (the designed read-only flow,
 * #2763/#3560) is covered by delegation-gate-empty-scope-2763.test.ts and
 * is deliberately NOT re-pinned here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';
const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function runGit(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		encoding: 'utf-8',
		stdio: 'ignore',
		stdin: 'ignore',
		timeout: 5000,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`fixture git command failed: ${args.join(' ')}`);
	}
}

/** The pre-refusal 2.16 shape: retryCount 2 from REAL failures. */
async function seedRetryCountTwo(directory: string): Promise<void> {
	for (let i = 0; i < 2; i += 1) {
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'dispatch_no_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `background-coder-terminal:seed-${i}`,
			context: {
				declaredFiles: ['src/feature.ts'],
				testEngineerExempt: false,
			},
		});
	}
}

function conflictingCoderArgs(): {
	subagent_type: string;
	task_id: string;
	prompt: string;
} {
	return {
		subagent_type: 'coder',
		task_id: TASK_ID,
		// The FILE directive points OUTSIDE the authoritative plan scope
		// (the exact 2.16 refusal shape: plan files_touched vs the dispatch's
		// declared scope) — the scope preflight refuses with SCOPE_CONFLICT
		// and NO child ever runs.
		prompt: `TASK: ${TASK_ID}\nFILE: src/outside-plan.ts\nACCEPTANCE: implement the feature`,
	};
}

function retryEscalationEvents(directory: string): number {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return 0;
	return fs
		.readFileSync(eventsPath, 'utf8')
		.trim()
		.split('\n')
		.filter(
			(line) =>
				line.includes('coder_retry_circuit_breaker') &&
				line.includes(`"${TASK_ID}"`),
		).length;
}

describe('scope-prep refusals do not count as coder retry failures (task 2.16)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(
		async () => {
			resetSwarmState();
			({ dir: directory, cleanup } = createSafeTestDir('scope-refusal-retry-'));
			runGit(directory, ['init', '--quiet']);
			runGit(directory, [
				'config',
				'user.email',
				'scope-refusal@example.invalid',
			]);
			runGit(directory, ['config', 'user.name', 'Scope refusal test']);
			fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(directory, 'src', 'feature.ts'),
				'export const feature = 1;\n',
			);
			runGit(directory, ['add', 'src/feature.ts']);
			runGit(directory, ['commit', '--quiet', '-m', 'scope refusal fixture']);
			fs.appendFileSync(
				path.join(directory, '.git', 'info', 'exclude'),
				'\n.swarm/\n',
			);
			// The plan task HAS scope: a directive-less dispatch is a plain
			// refusal, never the explicit empty-plan-scope settlement.
			await writeApprovedPlan(directory, [
				{ id: TASK_ID, files: ['src/feature.ts'] },
			]);
			const session = ensureAgentSession('parent', 'architect', directory);
			session.currentTaskId = TASK_ID;
		},
		{ timeout: 30_000 },
	);

	afterEach(
		() => {
			resetSwarmState();
			cleanup();
		},
		{ timeout: 30_000 },
	);

	test(
		'a refused dispatch leaves the retry accounting untouched',
		async () => {
			await seedRetryCountTwo(directory);
			const before = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, TASK_ID),
			);
			expect(before.retryCount).toBe(2);

			const hook = createDelegationGateHook(config, directory);
			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: 'parent', callID: 'refused-1' },
					{ args: conflictingCoderArgs() },
				),
			).rejects.toThrow(/scope/);

			const after = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, TASK_ID),
			);
			// Pre-fix this refusal pushed retryCount to 3 and rotated
			// lastOutcome/lastTransitionId to its own coder-preflight marker.
			expect(after.retryCount).toBe(2);
			expect(after.lastOutcome).toBe(before.lastOutcome);
			expect(after.lastTransitionId).toBe(before.lastTransitionId);
			expect(after.retryHistory).toEqual(before.retryHistory);
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(directory, TASK_ID))
					.authoritative,
			).toBe(true);
		},
		{ timeout: 30_000 },
	);

	test(
		'repeated refusals do not spiral into the escalation ladder',
		async () => {
			await seedRetryCountTwo(directory);
			const hook = createDelegationGateHook(config, directory);
			for (let i = 0; i < 5; i += 1) {
				await expect(
					hook.toolBefore(
						{ tool: 'Task', sessionID: 'parent', callID: `refused-loop-${i}` },
						{ args: conflictingCoderArgs() },
					),
				).rejects.toThrow(/scope/);
			}

			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, TASK_ID),
			);
			expect(workflow.retryCount).toBe(2);
			// No consultation/escalation events were emitted by the refusals.
			expect(retryEscalationEvents(directory)).toBe(0);
		},
		{ timeout: 30_000 },
	);
});
