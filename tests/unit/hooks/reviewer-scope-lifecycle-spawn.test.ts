import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Captured once at module scope so restoration in afterEach is a true restore
// of the original seam values, never a hand-written literal.
const realSpawn = _internals.spawn;
const realResolveGitExecutable = _internals.resolveGitExecutable;

let directory = '';
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

/** Minimal fake ChildProcess: emits a clean (exit 0, empty stdout) close. */
function fakeCleanChild(): ReturnType<typeof _internals.spawn> {
	const emitter = new EventEmitter() as unknown as ReturnType<
		typeof _internals.spawn
	> & { stdout: EventEmitter; kill: () => void };
	emitter.stdout = new EventEmitter();
	emitter.kill = () => {};
	queueMicrotask(() => {
		emitter.emit('close', 0);
	});
	return emitter;
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('reviewer-scope-lifecycle-spawn-');
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	startAgentSession('parent', 'architect', directory);
	startAgentSession('fixture-child', 'coder', directory);
	installActiveScopeBinding({
		directory,
		childSessionId: 'fixture-child',
		parentSessionId: 'parent',
		dispatchCallId: 'fixture-call',
		taskId: '1.1',
		files: ['src/a.ts'],
	});
});

afterEach(() => {
	_internals.spawn = realSpawn;
	_internals.resolveGitExecutable = realResolveGitExecutable;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer-scope-lifecycle no-change status probe (issue #2236 regression)', () => {
	test('spawns the resolved git executable path, not a bare "git" literal, args kept in array form', async () => {
		// A Windows-realistic install path containing a space — the shape that
		// breaks naive string handling and would be silently masked by a
		// hardcoded 'git' literal at the call site.
		const RESOLVED_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
		_internals.resolveGitExecutable = () => RESOLVED_GIT;

		let spawnCalls = 0;
		let capturedCommand: string | undefined;
		let capturedArgs: readonly string[] | undefined;
		_internals.spawn = ((command: string, args: readonly string[]) => {
			spawnCalls += 1;
			capturedCommand = command;
			capturedArgs = args;
			return fakeCleanChild();
		}) as typeof _internals.spawn;

		const childSessionID = 'child-nochange';
		startAgentSession(childSessionID, 'coder', directory);
		swarmState.activeAgent.set(childSessionID, 'coder');
		swarmState.agentSessions.get(childSessionID)!.delegationActive = true;
		installActiveScopeBinding({
			directory,
			childSessionId: childSessionID,
			parentSessionId: 'parent',
			dispatchCallId: 'coder-nochange',
			taskId: '1.1',
			files: ['src/a.ts'],
		});

		const started = await beginApprovedReviewerScopeLifecycle({
			directory,
			tool: 'Task',
			args: {
				subagent_type: 'coder',
				prompt: 'TASK: 1.1\nImplement the task.',
			},
			parentSessionID: 'parent',
			callID: 'coder-nochange',
		});
		expect(started).toBe('coder_started');

		// Zero observed writes routes into verifyWorkingTreeClean, which is the
		// only call site that reaches _internals.spawn in this module.
		const completed = await completeReviewerScopeLifecycle({
			directory,
			tool: 'Task',
			args: {
				subagent_type: 'coder',
				prompt: 'TASK: 1.1\nImplement the task.',
			},
			output: SUCCESS_OUTPUT,
			parentSessionID: 'parent',
			callID: 'coder-nochange',
		});
		expect(completed).toBe('coder_no_change');

		// Non-vacuous: prove the spawn seam actually fired before trusting its
		// captured arguments — a path that never spawns must not pass silently.
		expect(spawnCalls).toBeGreaterThan(0);
		expect(capturedCommand).toBe(RESOLVED_GIT);
		// Array form, not a collapsed shell string — proves the fix did not
		// regress into string-concatenation of the space-containing path.
		expect(capturedArgs).toEqual(['status', '--porcelain']);
	});
});
