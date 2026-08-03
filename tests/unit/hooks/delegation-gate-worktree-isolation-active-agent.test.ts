/**
 * Issue #2002 fail-open regression — active-agent registration ordering.
 *
 * Companion to tests/unit/hooks/scope-guard-worktree-session-root.test.ts and
 * tests/unit/hooks/guardrails-worktree-session-root.test.ts, which cover the
 * scope-guard and guardrails write-gate halves of this regression from the
 * consuming side. This file covers the PRODUCING side: the exact call inside
 * precreateStandardWorktreeSession (src/hooks/delegation-gate/worktree-isolation.ts)
 * that registers a worktree-lane child session.
 *
 * Prior behavior: recordSessionWorkspaceRoot(sessionId, laneRoot) called
 * ensureAgentSession(sessionId) with NO agent name for an unregistered
 * session. That routed to startAgentSession(sessionId, 'unknown', ...),
 * which set swarmState.activeAgent to 'unknown' — a FAIL-OPEN state:
 * 'unknown' is truthy, so it clears the no-active-agent guard in
 * src/hooks/guardrails/tool-before.ts, then lands in the noScopeLenient
 * branch that skips the authority check entirely, while scope-guard.ts
 * returns early because the role isn't 'coder'. The lane child's shell
 * writes would run completely unenforced.
 *
 * Fixed contract: recordSessionWorkspaceRoot refuses to create a session.
 * worktree-isolation.ts now calls
 * ensureAgentSession(createResult.data.id, 'coder', provisionResult.worktreePath)
 * BEFORE recordSessionWorkspaceRoot, so the child session is always
 * registered with its real 'coder' identity first.
 *
 * This test proves that end-to-end contract through the real
 * precreateStandardWorktreeSession entry point — not a hand-simulated call
 * order — so a regression in the production ordering fails this test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
	_internals as worktreeIsolationInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	resetSwarmState,
	resolveSessionWorkspaceDirectory,
	swarmState,
} from '../../../src/state';

function initGitRepo(repoPath: string): void {
	fs.mkdirSync(repoPath, { recursive: true });
	const env = { ...process.env, LC_ALL: 'C' };
	const result = spawnSync('git', ['init', '-q'], { cwd: repoPath, env });
	if (result.status !== 0) {
		throw new Error(`git init failed: ${result.stderr?.toString()}`);
	}
	spawnSync('git', ['config', 'user.email', 'test@opencode.swarm'], {
		cwd: repoPath,
		env,
	});
	spawnSync('git', ['config', 'user.name', 'Swarm Test'], {
		cwd: repoPath,
		env,
	});
	spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'initial'], {
		cwd: repoPath,
		env,
	});
}

describe('precreateStandardWorktreeSession registers activeAgent before recording the workspace root (#2002)', () => {
	let gitDir: string;
	let origProvisionWorktree: typeof worktreeIsolationInternals.provisionWorktree;
	let laneWorktreePath: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		gitDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-active-agent-')),
		);
		initGitRepo(gitDir);
		laneWorktreePath = path.join(gitDir, '.swarm-worktrees', 'lane-child');
		fs.mkdirSync(laneWorktreePath, { recursive: true });

		// Stub provisionWorktree so no real `git worktree add` runs — the
		// worktree-lifecycle path (collision check, lock, owner ledger) still
		// executes for real against gitDir.
		origProvisionWorktree = worktreeIsolationInternals.provisionWorktree;
		worktreeIsolationInternals.provisionWorktree = async () => ({
			worktreePath: laneWorktreePath,
			branchName: 'swarm/lane/parent-session/task-active-agent',
			purpose: 'lane',
			id: 'task-active-agent',
			sessionId: 'parent-session',
		});
	});

	afterEach(() => {
		worktreeIsolationInternals.provisionWorktree = origProvisionWorktree;
		swarmState.opencodeClient = null;
		try {
			fs.rmSync(gitDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetStandardWorktreeIsolationState();
		resetSwarmState();
	});

	it('REGRESSION #2002: swarmState.activeAgent is "coder" for the child session immediately after precreate, with no manual repair', async () => {
		const childSessionId = 'child-session-active-agent';
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: childSessionId } }),
			},
		} as unknown as typeof swarmState.opencodeClient;

		expect(swarmState.activeAgent.has(childSessionId)).toBe(false);

		await precreateStandardWorktreeSession({
			config: {
				worktree: { policy: 'auto', merge_strategy: 'merge' },
			} as unknown as PluginConfig,
			directory: gitDir,
			parentSessionID: 'parent-session',
			callID: 'call-active-agent',
			taskId: 'task-active-agent',
			outputArgs: {},
		});

		// The production call site is
		// ensureAgentSession(createResult.data.id, 'coder', provisionResult.worktreePath)
		// immediately before recordSessionWorkspaceRoot — no test in this file
		// calls swarmState.activeAgent.set(...) to fabricate this result.
		expect(swarmState.activeAgent.get(childSessionId)).toBe('coder');
		expect(swarmState.agentSessions.get(childSessionId)?.agentName).toBe(
			'coder',
		);

		// The workspace root recording that depends on registration-first
		// ordering also succeeded — confirms the two calls ran in the
		// documented order, not just that activeAgent happens to be 'coder'
		// for an unrelated reason.
		expect(resolveSessionWorkspaceDirectory(childSessionId, gitDir)).toBe(
			laneWorktreePath,
		);
	});
});
