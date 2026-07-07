import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanStructureHash,
	initLedger,
	ledgerExists,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { derivePlanId } from '../../../src/plan/utils';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Re-export everything from the main test file for consumers
export { createDelegationGateHook } from '../../../src/hooks/delegation-gate';

/**
 * Record a plan-critic-approval ledger snapshot for `plan` the SAME way
 * production does (`recordPlanCriticApprovalSnapshotIfApplicable` in
 * src/hooks/delegation-gate.ts): a `critic_approved` snapshot tagged with the
 * `plan_critic_gate` approval marker and storing the STATUS-EXCLUDED structural
 * hash (`computePlanStructureHash`) as its `payload_hash`.
 *
 * Since PR #1706 shipped `assertPlanCriticApprovedForExecution`, any coder-role
 * `Task` dispatch made while a `.swarm/plan.json` exists now REQUIRES such a
 * snapshot or the gate throws `PLAN_CRITIC_GATE_VIOLATION`. Fixtures that write
 * a bare plan.json and then dispatch a coder must call this to record the
 * matching precondition — exactly as any real architect must obtain plan-critic
 * approval before EXECUTE.
 *
 * Unlike the reference `writePlan` helper, the delegation-gate fixture writers
 * do not call `initLedger`, so this initializes the ledger on first use. The
 * guard makes it safe to call repeatedly (append-only) for tests that rewrite
 * plan.json mid-test.
 */
export async function recordPlanCriticApproval(
	dir: string,
	plan: Plan,
): Promise<void> {
	if (!(await ledgerExists(dir))) {
		await initLedger(dir, derivePlanId(plan));
	}
	await takeSnapshotEvent(dir, plan, {
		source: 'critic_approved',
		approvalMetadata: { verdict: 'APPROVED', source: 'plan_critic_gate' },
		payloadHashOverride: computePlanStructureHash(plan),
	});
}

export function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

export function makeMessages(
	text: string,
	agent?: string,
	sessionID: string | undefined | null = 'test-session',
) {
	return {
		messages: [
			{
				info: {
					role: 'user' as const,
					agent,
					sessionID: sessionID ?? undefined,
				},
				parts: [{ type: 'text', text }],
			},
		],
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageWithParts = any;

// Helper to find user messages in the array (accounts for injected system messages)
export function findUserMessage(messages: { messages: MessageWithParts[] }) {
	return messages.messages.find(
		(m: MessageWithParts) => m.info?.role === 'user',
	);
}

// Helper to find system messages (for [NEXT] guidance)
export function findSystemMessage(messages: { messages: MessageWithParts[] }) {
	return messages.messages.find(
		(m: MessageWithParts) => m.info?.role === 'system',
	);
}

// Helper to get concatenated text from all system messages (for warning assertions)
export function getSystemWarningText(messages: {
	messages: MessageWithParts[];
}): string {
	return messages.messages
		.filter((m: MessageWithParts) => m.info?.role === 'system')
		.map((m: MessageWithParts) => m.parts?.[0]?.text ?? '')
		.join('\n');
}

// Helper to get the primary text content - finds user message text if present, otherwise first message
export function getPrimaryText(messages: {
	messages: MessageWithParts[];
}): string {
	const userMsg = findUserMessage(messages);
	if (userMsg?.parts?.[0]) {
		return userMsg.parts[0].text ?? '';
	}
	// Fallback to first message if no user message found
	return messages.messages[0]?.parts?.[0]?.text ?? '';
}
