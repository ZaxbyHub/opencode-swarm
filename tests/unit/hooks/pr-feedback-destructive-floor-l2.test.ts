/**
 * Issue #3315 AC16 — PR_FEEDBACK destructive/publication FLOOR.
 *
 * GREEN at base and head (floor): history-rewriting, force-push, empty-commit,
 * index/tree-mutating, and stash commands must keep rejecting with a BLOCKED
 * refusal both at the unfixed base and after the #3315 `git add` / commit
 * classifier work. Nothing in the #3315 admission surface may widen any of
 * these. `git reset --soft` is deliberately NOT in this list: it becomes
 * issue #3316's sanctioned move and gets its own acceptance checks there.
 *
 * The "git commit while armed" case pins the armed-window immutability floor:
 * once the gate is armed for publication, even the sanctioned standalone
 * commit shape is refused ("the approved commit is immutable"). No reusable
 * exported armed-publication helper exists under tests/unit/hooks, so the
 * armed fixture adapts the proven raw-state writer from
 * pr-workflow-gate-controller-tools.test.ts (writeArmedState): a consistent
 * prFeedbackReadyToPublish mirror plus prFeedbackPublication generation
 * record written straight to the gate state file, so no migration runs and
 * the armed branch governs (issue #2108).
 *
 * Shared-fixture bound PR_FEEDBACK gate (git resolvers stubbed through the
 * _test_exports seam; no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
	type PrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	SESSION_ID as FIXTURE_SESSION_ID,
	HEAD_SHA,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const SESSION_ID = `${FIXTURE_SESSION_ID}-destructive-floor-l2`;
const ARMED_SESSION_ID = `${FIXTURE_SESSION_ID}-destructive-armed-l2`;

async function shellOutcome(session: string, command: string): Promise<string> {
	return enforcePrWorkflowToolBefore(tempDir, session, 'shell', {
		command,
	}).then(
		() => 'RESOLVED',
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

/**
 * Write a raw armed PR_FEEDBACK state directly to disk (adapted from
 * writeArmedState in tests/unit/hooks/pr-workflow-gate-controller-tools.test.ts).
 * The armed window is the publication-generation record plus its derived
 * legacy mirror; a consistent pair means no migration runs and the armed
 * branch (not the invalidated fall-through) governs.
 */
async function writeArmedState(sessionID: string): Promise<void> {
	const relative = _test_exports.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(tempDir, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const state: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 5,
		sessionID,
		mode: 'PR_FEEDBACK',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
		prHeadSha: HEAD_SHA,
		prFeedbackReadyToPublish: {
			revisionDigest: 'revision-test',
			localHead: 'def456',
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/fix/x',
			remoteRef: 'refs/remotes/origin/fix/x',
			validatedAt: '2026-07-19T00:00:00.000Z',
		} as PrWorkflowGateState['prFeedbackReadyToPublish'],
		prFeedbackPublication: {
			schemaVersion: 1,
			active: {
				schemaVersion: 1,
				generation: 1,
				state: 'armed',
				workspaceIdentity: `test-workspace-${sessionID}`,
				sessionID,
				intakeHeadSha: HEAD_SHA,
				localHeadRef: 'refs/heads/fix/x',
				localHead: 'def456',
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/fix/x',
				remoteRef: 'refs/remotes/origin/fix/x',
				revisionDigest: 'revision-test',
				evidence: {
					stageAValidatedAt: '2026-07-19T00:00:00.000Z',
					batches: [
						{
							phase: 'closeout-critic',
							batchId: 'batch-armed-floor',
							laneId: 'closeout-critic',
						},
					],
				},
				createdAt: '2026-07-19T00:00:00.000Z',
				armedAt: '2026-07-19T00:00:00.000Z',
			},
			history: [],
			attempts: [],
		} as NonNullable<PrWorkflowGateState['prFeedbackPublication']>,
	};
	await fs.writeFile(absolute, JSON.stringify(state, null, 2), 'utf-8');
}

describe('issue #3315 AC16 — destructive and publication commands stay blocked', () => {
	beforeEach(async () => {
		setupPrWorkflowGateFixtures();
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
	});
	afterEach(teardownPrWorkflowGateFixtures);

	test.each([
		// history rewriting / empty commits on the publication verb itself
		'git commit --amend -m "fix: thing"',
		'git commit --allow-empty -m "fix: thing"',
		// publication shells (unarmed: publication is not armed)
		'git push origin main',
		'git push --force origin pr-head',
		'git push origin HEAD:refs/heads/other',
		// index/tree mutation and stash plumbing (fail-closed shell)
		'git reset HEAD~1',
		'git reset --hard origin/pr-head',
		'git revert HEAD',
		'git rm --cached src/foo.ts',
		'git clean -fd',
		'git stash',
		'git stash -u',
		// NOTE: `git reset --soft` is deliberately absent — it becomes issue
		// #3316's sanctioned move and is covered by that issue's checks.
	])('%s rejects with a BLOCKED refusal', async (command) => {
		await expect(shellOutcome(SESSION_ID, command)).resolves.toMatch(/BLOCKED/);
	});

	test('git commit while armed refuses: the approved commit is immutable', async () => {
		await writeArmedState(ARMED_SESSION_ID);
		await expect(
			shellOutcome(ARMED_SESSION_ID, 'git commit -m "fix: thing"'),
		).resolves.toMatch(
			/armed for publication; the approved commit is immutable/,
		);
	});
});
