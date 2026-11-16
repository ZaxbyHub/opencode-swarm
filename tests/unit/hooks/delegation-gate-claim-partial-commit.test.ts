/**
 * #3403 (AC2): the coder scope-claim activation is all-or-nothing. A claim
 * failure other than SCOPE_NOT_DECLARED (and a claim that throws) must roll
 * this attempt's lineage write back so no dispatch is left with lineage
 * committed while its route/full-auto bindings are permanently skipped — while
 * the #3036 benign path (reviewer/test-engineer children returning at
 * SCOPE_NOT_DECLARED) keeps its lineage byte-identically.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import {
	getAgentSession,
	resetSwarmState,
	resolveDispatchParent,
	restoreDispatchParentEntry,
	writeDispatchParentEntry,
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
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.error?.message ||
				result.stderr ||
				result.stdout ||
				`git ${args.join(' ')} exited ${result.status}`,
		);
	}
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

function makeFixture(testId: string): Fixture {
	resetSwarmState();
	const directory = canonicalMkdtemp(`claim-partial-${testId}-`);
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
	return {
		directory,
		hook: null as unknown as Fixture['hook'],
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

const TASK_PROMPTS = {
	'1.1': 'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented',
	'1.2': 'TASK: 1.2\nFILE: src/other.ts\nACCEPTANCE: other is implemented',
} as const;

async function publish(
	fixture: Fixture,
	callID: string,
	taskId: keyof typeof TASK_PROMPTS,
): Promise<void> {
	await fixture.hook.toolBefore(
		{ tool: 'Task', sessionID: 'parent', callID },
		{
			args: {
				subagent_type: 'coder',
				task_id: taskId,
				prompt: TASK_PROMPTS[taskId],
			},
		},
	);
}

async function claimChild(
	fixture: Fixture,
	callID: string,
	childSessionID: string,
): Promise<void> {
	await fixture.hook.taskMetadata({
		callID,
		parentSessionID: 'parent',
		childSessionID,
	});
}

async function setup(testId: string): Promise<Fixture> {
	const fixture = makeFixture(testId);
	await writeApprovedPlan(fixture.directory, [
		{ id: '1.1', files: ['src/feature.ts'] },
		{ id: '1.2', files: ['src/other.ts'] },
	]);
	const parent = await import('../../../src/state').then((m) =>
		m.ensureAgentSession('parent', 'architect', fixture.directory),
	);
	parent.currentTaskId = '1.1';
	parent.lastCoderDelegationTaskId = '1.1';
	for (const [taskId, file] of [
		['1.1', 'src/feature.ts'],
		['1.2', 'src/other.ts'],
	] as const) {
		const declared = await executeDeclareScope(
			{ taskId, files: [file], working_directory: fixture.directory },
			fixture.directory,
			{ sessionID: 'parent', messageID: `m-${taskId}` },
		);
		if (!declared.success)
			throw new Error(`declare-scope failed for ${taskId}`);
	}
	fixture.hook = createDelegationGateHook(config, fixture.directory);
	return fixture;
}

/**
 * Two live pending generations match one Task callID (task 1.1 and task 1.2
 * published under the same callID), so any claim for it resolves to
 * SCOPE_BINDING_AMBIGUOUS — a typed, non-ALREADY_CLAIMED failure.
 */
async function publishAmbiguous(
	fixture: Fixture,
	callID: string,
): Promise<void> {
	await publish(fixture, callID, '1.1');
	await publish(fixture, callID, '1.2');
}

describe('#3403 claim partial-commit atomicity', () => {
	test('a second claimant throws AND its lineage write is rolled back (no half-applied activation)', async () => {
		const fixture = await setup('already-claimed');
		try {
			await publish(fixture, 'call-1', '1.1');
			await claimChild(fixture, 'call-1', 'child-winner');
			expect(resolveDispatchParent('child-winner')).toBe('parent');

			await expect(
				claimChild(fixture, 'call-1', 'child-loser'),
			).rejects.toThrow('SCOPE_BINDING_ALREADY_CLAIMED');
			// The loser's lineage write was rolled back — not left behind.
			expect(resolveDispatchParent('child-loser')).toBeUndefined();
			// The winner's lineage is untouched.
			expect(resolveDispatchParent('child-winner')).toBe('parent');
			// The loser's post-claim bindings were skipped.
			expect(getAgentSession('child-loser')).toBeUndefined();

			// Every subsequent progress tick re-throws and still leaves no
			// half-applied state.
			await expect(
				fixture.hook.taskMetadata({
					callID: 'call-1',
					parentSessionID: 'parent',
					childSessionID: 'child-loser',
				}),
			).rejects.toThrow('SCOPE_BINDING_ALREADY_CLAIMED');
			expect(resolveDispatchParent('child-loser')).toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	}, 30_000);

	test('an AMBIGUOUS claim (multiple live generations) rolls its lineage write back', async () => {
		const fixture = await setup('ambiguous');
		try {
			await publishAmbiguous(fixture, 'call-amb');
			await expect(
				claimChild(fixture, 'call-amb', 'child-amb'),
			).rejects.toThrow('SCOPE_BINDING_AMBIGUOUS');
			expect(resolveDispatchParent('child-amb')).toBeUndefined();
			expect(getAgentSession('child-amb')).toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	}, 30_000);

	test.each([
		'SCOPE_BINDING_PERSISTENCE_FAILED',
		'SCOPE_BINDING_EXPIRED',
		'SCOPE_BINDING_STORE_OVERLOADED',
	])('a typed %s claim failure rolls its lineage write back', async (code) => {
		const fixture = await setup(`typed-${code}`);
		const original = _internals.claimScopeBindingForChildDurably;
		// Injected typed failure: the same non-benign rollback arm the real
		// persistence/expiry/overload results reach.
		_internals.claimScopeBindingForChildDurably = (async () => ({
			ok: false,
			code,
			message: 'injected typed failure',
		})) as never;
		try {
			await expect(
				claimChild(fixture, `call-${code}`, `child-${code}`),
			).rejects.toThrow(code);
			expect(resolveDispatchParent(`child-${code}`)).toBeUndefined();
		} finally {
			_internals.claimScopeBindingForChildDurably = original;
			fixture.cleanup();
		}
	}, 30_000);

	test('a THROWN claim rolls its lineage write back before the exception propagates', async () => {
		const fixture = await setup('thrown-claim');
		const original = _internals.claimScopeBindingForChildDurably;
		_internals.claimScopeBindingForChildDurably = async () => {
			throw new Error('scope store unavailable');
		};
		try {
			await expect(
				claimChild(fixture, 'call-throw', 'child-throw'),
			).rejects.toThrow('scope store unavailable');
			expect(resolveDispatchParent('child-throw')).toBeUndefined();
		} finally {
			_internals.claimScopeBindingForChildDurably = original;
			fixture.cleanup();
		}
	}, 30_000);

	test('overlapping failed taskMetadata attempts for one child leave NO lineage (serialized)', async () => {
		const fixture = await setup('overlap-both-fail');
		try {
			await publishAmbiguous(fixture, 'call-overlap');
			// Two attempts for the SAME child in flight at once — the shape
			// message.part.updated ticks produce. Serialized, the second attempt
			// captures the first attempt's ROLLED-BACK state, not its in-flight
			// write, so both failing leaves no lineage behind.
			const settled = await Promise.allSettled([
				claimChild(fixture, 'call-overlap', 'child-both'),
				claimChild(fixture, 'call-overlap', 'child-both'),
			]);
			for (const outcome of settled) {
				expect(outcome.status).toBe('rejected');
			}
			expect(resolveDispatchParent('child-both')).toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	}, 30_000);

	test('#3036 preservation: a SCOPE_NOT_DECLARED taskMetadata still records lineage', async () => {
		const fixture = await setup('scope-not-declared');
		try {
			// No toolBefore publish for call-none: the claim finds no pending
			// generation and returns early — the reviewer/test-engineer shape.
			await fixture.hook.taskMetadata({
				callID: 'call-none',
				parentSessionID: 'parent',
				childSessionID: 'child-reviewer',
			});
			expect(resolveDispatchParent('child-reviewer')).toBe('parent');
		} finally {
			fixture.cleanup();
		}
	}, 30_000);

	test('a failed claim restores PRE-EXISTING adopted lineage instead of deleting it', async () => {
		const fixture = await setup('adopted-restore');
		try {
			// Pre-existing best-effort adopted lineage for the loser.
			writeDispatchParentEntry('child-loser', 'adopted-parent');
			await publish(fixture, 'call-1', '1.1');
			await claimChild(fixture, 'call-1', 'child-winner');
			await expect(
				claimChild(fixture, 'call-1', 'child-loser'),
			).rejects.toThrow('SCOPE_BINDING_ALREADY_CLAIMED');
			expect(resolveDispatchParent('child-loser')).toBe('adopted-parent');
		} finally {
			fixture.cleanup();
		}
	}, 30_000);

	test('stale-race (i): an older failure never clobbers a newer DIFFERENT-parent write', () => {
		resetSwarmState();
		const gen1 = writeDispatchParentEntry('child-race', 'parent-old');
		const previous = 'adopted-parent';
		// A newer activation for the same child lands while attempt 1's claim
		// is still in flight.
		writeDispatchParentEntry('child-race', 'parent-new');
		restoreDispatchParentEntry('child-race', gen1, previous);
		expect(resolveDispatchParent('child-race')).toBe('parent-new');
	});

	test('stale-race (ii): an older failure never deletes a newer SAME-parent write', () => {
		resetSwarmState();
		const gen1 = writeDispatchParentEntry('child-race2', 'parent');
		// A newer successful activation wrote the SAME parent.
		writeDispatchParentEntry('child-race2', 'parent');
		// The older attempt had no previous entry — its rollback would delete.
		restoreDispatchParentEntry('child-race2', gen1, undefined);
		expect(resolveDispatchParent('child-race2')).toBe('parent');
	});

	test('a retry after a competing-claim failure converges to the uninterrupted state', async () => {
		const fixture = await setup('retry-converge');
		try {
			await publish(fixture, 'call-1', '1.1');
			await claimChild(fixture, 'call-1', 'child-winner');
			await expect(
				claimChild(fixture, 'call-1', 'child-later'),
			).rejects.toThrow('SCOPE_BINDING_ALREADY_CLAIMED');
			// A FRESH dispatch (new call, new task, new pending generation)
			// claimed by the previously-losing child converges: lineage
			// present, session stamped, no residue from the failed attempt.
			await publish(fixture, 'call-2', '1.2');
			await claimChild(fixture, 'call-2', 'child-later');
			expect(resolveDispatchParent('child-later')).toBe('parent');
			const session = getAgentSession('child-later');
			expect(session?.agentName).toBe('coder');
			expect(session?.currentTaskId).toBe('1.2');
		} finally {
			fixture.cleanup();
		}
	}, 30_000);
});
