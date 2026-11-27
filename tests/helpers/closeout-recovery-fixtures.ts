/**
 * Shared fixtures for the durable closeout recovery suites (r13 P0-3/P1-2/P1-5/P2-2).
 *
 * Split out of tests/unit/background/completion-observer-closeout-recovery.test.ts
 * for the FR-006 file cap; both recovery files drive the same deterministic
 * manual-terminal and stub seams through these helpers.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildBackgroundCompletionEventId,
	recordPendingDelegation,
} from '../../src/background/pending-delegations';
import { parseTaskEnvelope } from '../../src/background/task-envelope';
import { captureWorkspaceSnapshot } from '../../src/background/workspace-snapshot';
import type { Plan } from '../../src/config/plan-schema';
import { telemetry } from '../../src/telemetry';

export function writePlan(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Closeout Recovery Plan',
		swarm: 'closeout-recovery',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

export function completionEvent(
	childSessionId: string,
	state: 'completed' | 'error' | 'cancelled',
	body: string,
	parentSessionId = 'ses_recovery_parent',
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
				},
			},
		},
	};
}

export async function recordPending(
	directory: string,
	options: { agent?: string; workflowGeneration?: number } = {},
): Promise<void> {
	const agent = options.agent ?? 'reviewer';
	await recordPendingDelegation(directory, {
		correlationId: 'ses_recovery_child',
		jobId: 'job-recovery',
		subagentSessionId: 'ses_recovery_child',
		parentSessionId: 'ses_recovery_parent',
		callID: 'call-recovery-1',
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		...(options.workflowGeneration !== undefined
			? { workflowGeneration: options.workflowGeneration }
			: {}),
		workspace: captureWorkspaceSnapshot(directory),
	});
}

/**
 * Deterministic manual terminal construction — EXACTLY the envelope→terminal
 * mapping the live observer performs (same digest, chars, truncated, and
 * eventId), so a manually claimed terminal is byte-identical to the one the
 * observer would claim from the same completion event.
 */
export function manualTerminal(body: string): {
	eventId: string;
	status: 'completed' | 'error' | 'cancelled';
	recordedAt: number;
	result: {
		text?: string;
		error?: string;
		chars: number;
		truncated: boolean;
		digest: string;
	};
} | null {
	const envelope = parseTaskEnvelope(body);
	if (!envelope) return null;
	const isError = envelope.state !== 'completed';
	const text = isError
		? (envelope.errorText ?? '')
		: (envelope.resultText ?? '');
	const digest = createHash('sha256').update(text).digest('hex');
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId: 'ses_recovery_child',
			jobId: 'job-recovery',
			status: envelope.state,
			resultDigest: digest,
		}),
		status: envelope.state,
		recordedAt: Date.now(),
		result: {
			...(isError ? { error: text } : { text }),
			chars: envelope.resultChars ?? text.length,
			truncated: envelope.resultTruncated ?? false,
			digest,
		},
	};
}

/** Stub telemetry.delegationEnd, capturing emissions; restored in finally. */
export function captureDelegationEnds(): {
	count: () => number;
	restore: () => void;
} {
	let emissions = 0;
	const orig = telemetry.delegationEnd;
	(telemetry as { delegationEnd: unknown }).delegationEnd = () => {
		emissions += 1;
	};
	return {
		count: () => emissions,
		restore: () => {
			(telemetry as { delegationEnd: unknown }).delegationEnd = orig;
		},
	};
}
