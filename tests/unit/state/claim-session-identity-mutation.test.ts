/**
 * #3403 (AC8): pin WHAT a successful coder scope-claim mutates on the child
 * session, by named field, so a future change to the claim's identity
 * semantics is deliberate. Covers both the fresh-create shape (the session
 * did not exist) and the overwrite shape (an existing session with a
 * different identity is taken over).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
} from '../../../src/state';
import { executeDeclareScope } from '../../../src/tools/declare-scope';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true, background_subagents: false },
	worktree: { policy: 'disabled' },
} as unknown as PluginConfig;

interface Fixture {
	directory: string;
	hook: ReturnType<typeof createDelegationGateHook>;
	cleanup: () => void;
}

async function setup(testId: string): Promise<Fixture> {
	resetSwarmState();
	const directory = canonicalMkdtemp(`claim-identity-${testId}-`);
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'tests@example.com']);
	git(directory, ['config', 'user.name', 'Tests']);
	fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
	git(directory, ['add', 'base.txt']);
	git(directory, ['commit', '-m', 'test: seed repository']);
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
	);
	await writeApprovedPlan(directory, [
		{ id: '1.1', files: ['src/feature.ts'] },
	]);
	const parent = ensureAgentSession('parent', 'architect', directory);
	parent.currentTaskId = '1.1';
	parent.lastCoderDelegationTaskId = '1.1';
	const declared = await executeDeclareScope(
		{
			taskId: '1.1',
			files: ['src/feature.ts'],
			working_directory: directory,
		},
		directory,
		{ sessionID: 'parent', messageID: 'm-1' },
	);
	if (!declared.success) throw new Error('declare-scope failed');
	const hook = createDelegationGateHook(config, directory);
	return {
		directory,
		hook,
		cleanup: () => {
			resetSwarmState();
			try {
				fs.rmSync(directory, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

async function claim(fixture: Fixture, child: string): Promise<void> {
	const args = {
		subagent_type: 'coder',
		task_id: '1.1',
		prompt:
			'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented',
	};
	await fixture.hook.toolBefore(
		{ tool: 'Task', sessionID: 'parent', callID: `call-${child}` },
		{ args },
	);
	await fixture.hook.taskMetadata({
		callID: `call-${child}`,
		parentSessionID: 'parent',
		childSessionID: child,
	});
}

describe('#3403 claim session-identity mutation (named fields)', () => {
	test('fresh create: the claim creates the session with the coder identity and the claimed task scope', async () => {
		const fixture = await setup('fresh');
		try {
			expect(getAgentSession('child-fresh')).toBeUndefined();
			await claim(fixture, 'child-fresh');
			const session = getAgentSession('child-fresh');
			expect(session).toBeDefined();
			// Mutated fields, by name:
			expect(session?.agentName).toBe('coder'); // identity overwrite target
			expect(session?.currentTaskId).toBe('1.1'); // claimed task stamp
			expect(session?.declaredCoderScope).toEqual(['src/feature.ts']); // claimed scope stamp
		} finally {
			fixture.cleanup();
		}
	}, 30_000);

	test('overwrite: an existing session with a different identity is taken over, and the PRM ladder resets for the new delegation', async () => {
		const fixture = await setup('overwrite');
		try {
			const pre = ensureAgentSession(
				'child-existing',
				'reviewer',
				fixture.directory,
			);
			pre.currentTaskId = '2.2';
			pre.declaredCoderScope = ['src/other.ts'];
			// Arm PRM state that a reused session id must NOT inherit (#2134).
			pre.prmEscalationLevel = 3;
			pre.prmInitialized = true;
			pre.prmTrajectoryStep = 7;
			pre.prmPatternCounts = new Map([['repeated-pattern', 2]]);
			pre.prmDelegationCallId = 'call-stale';

			await claim(fixture, 'child-existing');
			const post = getAgentSession('child-existing');
			// Mutated fields, by name:
			expect(post?.agentName).toBe('coder'); // agentName OVERWRITTEN from 'reviewer'
			expect(post?.currentTaskId).toBe('1.1'); // currentTaskId overwritten from '2.2'
			expect(post?.declaredCoderScope).toEqual(['src/feature.ts']); // declaredCoderScope overwritten
			expect(post?.prmDelegationCallId).toBe('call-child-existing'); // re-stamped for THIS dispatch
			// PRM ladder reset (#2134): every resettable field the reset clears.
			expect(post?.prmEscalationLevel).toBe(0);
			expect(post?.prmInitialized).toBe(false);
			expect(post?.prmTrajectoryStep).toBe(0);
			expect(post?.prmPatternCounts?.size).toBe(0);
		} finally {
			fixture.cleanup();
		}
	}, 30_000);
});
