import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

// Module-level fixture dir: seedDelegationRecord writes into it and the
// describe's beforeEach re-assigns it per test (mkdtemp + safe cleanup).
let dir = '';

/**
 * Regression coverage for the SWARM_CHILD_RESUME_UNTRACKABLE guard in the
 * delegation gate's toolBefore (native-async resume of a terminal child).
 *
 * Live failure (observed in a consumer project, session
 * ses_e011879ccffeYmCCyK3OntAvQh, 2026-11-21): a CRITIC-GATE re-review after
 * NEEDS_REVISION resumed the SAME critic child session (the v2 host's
 * subagent tool invites this: "call subagent again with this sessionID").
 * The durable delegation store models one immutable launch per child
 * session, so the resumed round was untrackable — toolAfter recorded a
 * correlation conflict for the new callID and the follow-up APPROVED
 * terminal was rejected as a late terminal. The verdict was silently lost,
 * `get_approved_plan` stayed at `no_approved_snapshot`, and the
 * architect-only `approve_plan_critic` escape hatch was unreachable from
 * the non-architect orchestrator session: a total deadlock.
 *
 * The guard fails loud BEFORE the child launches. These tests pin the
 * exact admission boundary.
 *
 * Untested branch (documented per the mock-coverage rule): the
 * `findByCorrelationIdDetailed` `uncertain` (unreadable store) branch
 * degrades open and skips the guard. Not covered because forcing an
 * uncertain store read requires corrupting the ledger past its recovery
 * bound (see status-service-delegation-health.test.ts for that fixture
 * class); the degrade-open choice is deliberate so a corrupt store cannot
 * brick every dispatch, and the toolAfter conflict advisory still applies.
 */

const CHILD = 'ses_child_critic_round1';

interface SeedRecordArgs {
	status?: 'pending' | 'running' | 'completed' | 'error' | 'stale';
	agent?: string;
	batchId?: string;
}

async function seedDelegationRecord({
	status = 'completed',
	agent = 'critic',
	batchId,
}: SeedRecordArgs = {}): Promise<void> {
	await mkdir(join(dir, '.swarm'), { recursive: true });
	await recordPendingDelegation(dir, {
		correlationId: CHILD,
		jobId: null,
		subagentSessionId: CHILD,
		parentSessionId: 'parent-session',
		callID: 'call-round-1',
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: null,
		evidenceTaskId: null,
		...(batchId !== undefined ? { batchId, laneId: 'lane-1' } : {}),
	});
	if (status !== 'pending') {
		const reason = `seeded ${status} terminal for ${CHILD}`;
		await appendDelegationTransition(dir, CHILD, {
			status,
			...(status === 'completed'
				? {
						result: {
							text: 'VERDICT: NEEDS_REVISION',
							chars: reason.length,
							truncated: false,
							digest: 'a'.repeat(64),
						},
					}
				: {}),
			...(status === 'error' || status === 'stale'
				? {
						result: {
							error: reason,
							chars: reason.length,
							truncated: false,
							digest: 'b'.repeat(64),
						},
					}
				: {}),
		});
	}
}

function criticResumeDispatch(sessionID: string | null = CHILD) {
	return {
		input: {
			tool: 'task',
			sessionID: 'parent-session',
			callID: 'call-resume-round-2',
		},
		output: {
			args: {
				// Native v2 shape after the adapter's arg mapping:
				// `agent` → `subagent_type`, and the resume token stays `sessionID`.
				subagent_type: 'critic',
				...(sessionID !== null ? { sessionID } : {}),
				background: true,
				description: 'Critic-Gate Re-Review Plan',
				prompt:
					'MODE: CRITIC-GATE — Re-Review of the revised plan after NEEDS_REVISION.',
			},
		},
	};
}

describe('delegation gate — native-async resume of a terminal child', () => {
	beforeEach(async () => {
		resetSwarmState();
		dir = canonicalMkdtemp('resume-guard-');
	});

	afterEach(async () => {
		resetSwarmState();
		closeAllProjectDbs();
		if (dir && existsSync(dir)) {
			(await import('../../helpers/safe-test-dir.js')).safeRmRecursive(dir);
		}
	});

	test('regression: refuses a critic re-review that resumes a completed child (SWARM_CHILD_RESUME_UNTRACKABLE)', async () => {
		// Previous behavior: the resumed CRITIC-GATE round was admitted, its
		// APPROVED verdict was silently lost (correlation conflict + late
		// terminal), and execution wedged at no_approved_snapshot.
		await seedDelegationRecord({ status: 'completed' });
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			dir,
		);
		const { input, output } = criticResumeDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'SWARM_CHILD_RESUME_UNTRACKABLE',
		);
	});

	test('refuses the resume for every terminal status, with the status in the message', async () => {
		for (const status of ['error', 'stale'] as const) {
			resetSwarmState();
			dir = canonicalMkdtemp('resume-guard-status-');
			await seedDelegationRecord({ status });
			const hook = createDelegationGateHook(
				makeConfig({ hooks: { background_subagents: true } }),
				dir,
			);
			const { input, output } = criticResumeDispatch();
			await expect(hook.toolBefore(input, output)).rejects.toThrow(
				`already terminal (${status})`,
			);
			(await import('../../helpers/safe-test-dir.js')).safeRmRecursive(dir);
			dir = '';
		}
	});

	test('allows the resume while the child record is still live (pending)', async () => {
		// A pending/running record's single terminal is still consumable, so a
		// follow-up while the child works stays admissible.
		await seedDelegationRecord({ status: 'pending' });
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			dir,
		);
		const { input, output } = criticResumeDispatch();

		await hook.toolBefore(input, output);
	});

	test('allows a resume whose sessionID has no durable record (fresh child)', async () => {
		await mkdir(join(dir, '.swarm'), { recursive: true });
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			dir,
		);
		const { input, output } = criticResumeDispatch('ses_never_seen_child');

		await hook.toolBefore(input, output);
	});

	test('never blocks lane/batch records (dispatch_lanes owns its resume semantics)', async () => {
		await seedDelegationRecord({ status: 'completed', batchId: 'batch-1' });
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			dir,
		);
		const { input, output } = criticResumeDispatch();

		await hook.toolBefore(input, output);
	});

	test('never blocks a non-canonical agent resume', async () => {
		await seedDelegationRecord({ status: 'completed', agent: 'general' });
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			dir,
		);
		const { input, output } = criticResumeDispatch();
		output.args.subagent_type = 'general';

		await hook.toolBefore(input, output);
	});

	test('a fresh critic dispatch without sessionID is unaffected by the guard', async () => {
		await seedDelegationRecord({ status: 'completed' });
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			dir,
		);
		const { input, output } = criticResumeDispatch(null);
		input.callID = 'call-fresh-round-2';

		await hook.toolBefore(input, output);
	});
});
