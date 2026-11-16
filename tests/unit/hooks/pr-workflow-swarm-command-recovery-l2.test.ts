/**
 * Issue #3315 acceptance check AC17 (trace 3315-prescribed-tools-reachable) —
 * `swarm_command` recovery commands are reachable in BOTH PR gate modes.
 *
 * Discriminating check: RED at base, GREEN after the fix. At the unfixed base
 * `swarm_command` carries no `prWorkflow` capability, so PR_REVIEW rejects it
 * with "read-only and fail-closed" and PR_FEEDBACK rejects it with "rejects
 * unclassified plugin/MCP tools" — the `resolves.toBeUndefined()` assertions
 * below fail there. Once the E3 fix admits the two recovery commands, this
 * check turns GREEN.
 *
 * The third test (feedback-round FB-26/AC17-gap) pins the ARMED half of the
 * contract: the recovery carve-out runs BEFORE the armed-publication block in
 * the PR_FEEDBACK admission chain, so `diagnose` / `guardrail reset` stay
 * reachable even while `prFeedbackReadyToPublish` is staged — while a
 * non-recovery `swarm_command` still hits the unclassified-tool barrier.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	readPrWorkflowGateStateFromDisk,
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const RECOVERY_COMMANDS = ['diagnose', 'guardrail reset'] as const;

describe('issue #3315 AC17 — swarm_command recovery commands reachable in both PR modes', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('admits diagnose and guardrail reset under a bound PR_REVIEW gate', async () => {
		const sessionId = `${SESSION_ID}-3315-ac17-review`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).resolves.toBeUndefined();
		}
	});

	test('admits diagnose and guardrail reset under a bound PR_FEEDBACK gate', async () => {
		const sessionId = `${SESSION_ID}-3315-ac17-feedback`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).resolves.toBeUndefined();
		}
	});

	test('admits diagnose and guardrail reset while a PR_FEEDBACK gate is armed for publication', async () => {
		const sessionId = `${SESSION_ID}-3315-ac17-armed`;
		const state = await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		// Stage the armed-publication record directly (the shape
		// complete_pr_workflow would write): the recovery carve-out must run
		// ahead of the armed block, not be swallowed by it.
		await withSessionStateMutation(tempDir, sessionId, async () => {
			const current = await readPrWorkflowGateStateFromDisk(tempDir, sessionId);
			expect(current).not.toBeNull();
			await writeStateWhileLocked(tempDir, {
				...state,
				prFeedbackReadyToPublish: {
					revisionDigest: 'f'.repeat(64),
					localHead: HEAD_SHA,
					remoteName: 'origin',
					remoteBranchRef: 'refs/heads/pr-head',
					remoteRef: 'refs/remotes/origin/pr-head',
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			});
		});
		_test_exports.resetTrackedStateCache();
		for (const command of RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).resolves.toBeUndefined();
		}
		// The carve-out is narrow: a non-recovery swarm_command is still refused
		// (by the unclassified-tool barrier that precedes the armed block).
		await expect(
			enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
				command: 'plan',
			}),
		).rejects.toThrow(/unclassified plugin\/MCP tools/);
	});
});
