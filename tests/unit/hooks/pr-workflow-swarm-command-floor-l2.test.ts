/**
 * Issue #3315 acceptance check AC18 (trace 3315-prescribed-tools-reachable) —
 * non-recovery `swarm_command` invocations stay rejected in BOTH PR modes.
 *
 * Preserving floor check: GREEN at base and head. The E3 recovery admission
 * must stay NARROWER than `isAllowedRecoverySwarmCommand` in
 * `src/hooks/guardrails/nontransient-circuit.ts`, which also admits `handoff`
 * and every `full-auto status|retry-oversight|abort|resume|on|off|exit`
 * subcommand — those wider-allowlist members, plus bare `status` and an empty
 * command, must keep rejecting under the PR gates before and after the fix.
 * Each rejection is pinned to the active mode's gate message
 * (`/BLOCKED: PR_REVIEW/` / `/BLOCKED: PR_FEEDBACK/`), so an accidental reuse
 * of the wider allowlist would surface here as an unexpected admission.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const NON_RECOVERY_COMMANDS = [
	'handoff',
	'full-auto on',
	'full-auto resume',
	'full-auto abort',
	'status',
	'',
] as const;

describe('issue #3315 AC18 — non-recovery swarm_command commands stay rejected in both PR modes', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('rejects wider-allowlist and empty commands under a bound PR_REVIEW gate', async () => {
		const sessionId = `${SESSION_ID}-3315-ac18-review`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of NON_RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).rejects.toThrow(/BLOCKED: PR_REVIEW/);
		}
	});

	test('rejects wider-allowlist and empty commands under a bound PR_FEEDBACK gate', async () => {
		const sessionId = `${SESSION_ID}-3315-ac18-feedback`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of NON_RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
		}
	});
});
