/**
 * Shared plan-critic approval recording (issues #2012, #2002 async parity).
 *
 * ONE approval implementation serves BOTH Task transports:
 *
 *  - the synchronous `tool.execute.after` path in the delegation gate (the
 *    critic child returned inline), and
 *  - the native async completion path (OpenCode 2.3 background subagents),
 *    where the trusted terminal result is delivered later through the
 *    background completion observer.
 *
 * Both callers must establish, BEFORE calling
 * {@link recordVerifiedPlanCriticApproval}, that the verdict text comes from a
 * host-verified critic child whose durable dispatch identity (parent session,
 * call id, role) is known. This module never trusts ambient session state —
 * every identity field is passed explicitly and embedded in the approval
 * audit metadata.
 *
 * Safety contract (fail-closed):
 *  - Only an `APPROVED` verdict ({@link extractPlanCriticVerdict}) records a
 *    snapshot. `NEEDS_REVISION`, `REJECTED`, missing, or unparseable verdicts
 *    never approve anything.
 *  - When the caller supplies `dispatchPlanStructureHash` (the async
 *    transport, captured at dispatch time and persisted on the delegation
 *    record), the CURRENT plan's structural hash must still equal it. A plan
 *    edited after the critic was dispatched cannot be approved by the old
 *    verdict — the caller is told to re-run the critic instead.
 *  - Replay safety: before writing, the ledger is scanned for an existing
 *    `plan_critic_gate` approval snapshot bound to the same `call_id`. A
 *    replay of the same terminal (crash recovery, duplicate completion event)
 *    is a no-op, so a terminal can never approve twice.
 *  - The snapshot itself is written through the single existing choke point
 *    `takeSnapshotEvent` (`source: 'critic_approved'`, structural-hash
 *    payload) — the exact shape `assertPlanCriticApprovedForExecution` and
 *    `loadLastPlanCriticApprovedSnapshot` already verify. No competing
 *    approval implementation exists.
 */

import type { Plan } from '../config/plan-schema';
import { log, warn } from '../utils/logger';
import {
	computePlanStructureHash,
	readLedgerEventsWithIntegrity,
	takeSnapshotEvent,
} from './ledger';
import { loadPlanJsonOnly } from './manager';
import { derivePlanId } from './utils';

/**
 * Substrings that, in a dispatch to `subagent_type: 'critic'`, mark it as a
 * plan critic-gate review. Kept lowercase (text is lowercased before
 * matching).
 */
export const PLAN_CRITIC_TASK_SIGNALS = [
	'critic-gate', // "MODE: CRITIC-GATE", "critic-gate protocol/review"
	'plan critic',
	'review plan',
	'review the plan',
	'plan.md', // critic-gate/SKILL.md: "Send the full plan.md content"
	'approve the plan',
	'plan approval',
	// Issue #2012: realistic architect phrasings that the original 7 signals
	// silently missed, wedging the ratchet-tighter critic_pre_plan gate with
	// no recovery. These are safe to add: the caller already narrows to
	// `subagent_type === 'critic'` (a target the trusted architect controls),
	// so a false positive is low-risk, while a false negative silently blocks
	// ALL EXECUTE-phase coder work with no auto-recovery.
	'pre-implementation review',
	'evaluate this plan',
	'evaluate the plan',
	'assess this plan',
	'assess the plan',
	'plan soundness',
	'before implementation',
	'review the plan below',
] as const;

export function taskLooksLikePlanCritic(
	args: Record<string, unknown>,
): boolean {
	const text = [
		args.prompt,
		args.task,
		args.description,
		args.message,
		args.input,
	]
		.filter((value): value is string => typeof value === 'string')
		.join('\n')
		.toLowerCase();
	if (!text) return false;
	// Broad-recall-biased on purpose: the caller already narrows to
	// `subagent_type === 'critic'` (a target the trusted architect controls), so
	// a false positive is low-risk, while a false negative silently blocks ALL
	// EXECUTE-phase coder work with no auto-recovery. Any single signal below —
	// drawn from the phrasings the critic-gate/plan skills tell the architect to
	// send — is therefore sufficient; no AND-pairing.
	return PLAN_CRITIC_TASK_SIGNALS.some((signal) => text.includes(signal));
}

function outputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (typeof output === 'number' || typeof output === 'boolean') {
		return String(output);
	}
	if (Array.isArray(output)) {
		return output.map(outputText).filter(Boolean).join('\n');
	}
	if (output && typeof output === 'object') {
		const record = output as Record<string, unknown>;
		const preferred = ['output', 'text', 'content', 'message', 'result'];
		const parts: string[] = [];
		for (const key of preferred) {
			if (key in record) parts.push(outputText(record[key]));
		}
		if (parts.length > 0) return parts.filter(Boolean).join('\n');
		try {
			return JSON.stringify(output);
		} catch {
			return '';
		}
	}
	return '';
}

export function extractPlanCriticVerdict(
	output: unknown,
): 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | null {
	const text = outputText(output);
	if (!text) return null;

	// Primary signal (highest confidence): a `VERDICT: <TOKEN>` line. The critic
	// system prompt (src/agents/critic.ts) instructs this exact shape, so a
	// conforming critic always matches here. Also tolerates markdown-bold labels
	// (`**VERDICT**:`) which LLMs frequently emit despite the plain instruction.
	const primary =
		/^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(APPROVED|NEEDS_REVISION|REJECTED)\b/im.exec(
			text,
		);
	if (primary) {
		return primary[1].toUpperCase() as
			| 'APPROVED'
			| 'NEEDS_REVISION'
			| 'REJECTED';
	}

	// Fallback 1: a `## Verdict` (or `### Verdict`, …) heading followed (within
	// 2 lines) by a line whose only non-whitespace content is the verdict token.
	// Matches critics that emit the verdict under a markdown heading instead of
	// the `VERDICT:` label. The heading must be the verdict section specifically
	// (not e.g. `## PLAN REVIEW`), so the `Verdict` word is required.
	const heading = /^(#{1,6})\s*Verdict\s*$/im.exec(text);
	if (heading && heading.index !== undefined) {
		const after = text.slice(heading.index + heading[0].length);
		const nextLines = after.split('\n').slice(0, 3).join('\n');
		const headingMatch = /^\s*(APPROVED|NEEDS_REVISION|REJECTED)\s*$/im.exec(
			nextLines,
		);
		if (headingMatch) {
			return headingMatch[1].toUpperCase() as
				| 'APPROVED'
				| 'NEEDS_REVISION'
				| 'REJECTED';
		}
	}

	// Fallback 2: a BARE verdict token on its own line — but ONLY in the final
	// few lines of output (so a mid-review mention like "this is approved for
	// execution" cannot trigger it) and ONLY when the line does not contain a
	// `|` separator (which marks the critic-rubric template line
	// `VERDICT: APPROVED | NEEDS_REVISION | REJECTED`, an enumeration rather
	// than a real verdict) and is not inside a fenced code block.
	//
	// Issue #2012: real critics do not always emit the `VERDICT:` label, and a
	// missing snapshot here permanently wedges every coder delegation because
	// the gate is ratchet-tighter with no escape hatch. The tail-only + no-pipe
	// + no-code-fence guards keep false positives out while recovering the
	// common "the critic just wrote APPROVED at the end" case.
	const lines = text.split('\n');
	const tailStart = Math.max(0, lines.length - 6);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		// Match 3+ backticks so a 4-backtick fenced block (common for nested
		// code blocks) also toggles the fence state, not just exactly ```.
		// The regex is "3 or more backtick characters" — the {3,} quantifier
		// applies to the single preceding backtick literal.
		if (/^\s*(?:`{3,})/.test(lines[i])) inFence = !inFence;
		if (i < tailStart) continue;
		if (inFence) continue;
		const line = lines[i];
		if (line.includes('|')) continue;
		const bare = /^\s*(APPROVED|NEEDS_REVISION|REJECTED)\s*$/i.exec(line);
		if (bare) {
			return bare[1].toUpperCase() as
				| 'APPROVED'
				| 'NEEDS_REVISION'
				| 'REJECTED';
		}
	}

	return null;
}

/** Which Task transport produced the approval request (audit metadata). */
export type PlanCriticApprovalTransport = 'sync_task' | 'async_completion';

export interface PlanCriticApprovalRequest {
	/** Dispatching (parent) session id — embedded in the approval audit. */
	parentSessionId: string;
	/** Tool call id of the critic dispatch — the replay-dedup key. */
	callId: string;
	/**
	 * The critic child's result text. Callers must have established that this
	 * text is the host-verified terminal result of the critic child bound to
	 * `(parentSessionId, callId)` — never raw model text from an unverified
	 * source.
	 */
	verdictText: unknown;
	/**
	 * Structural hash of the plan captured at DISPATCH time and persisted on
	 * the delegation record (async transport). When present, the current plan
	 * must still match it; a plan edited after the dispatch cannot be approved
	 * by the old verdict.
	 */
	dispatchPlanStructureHash?: string;
	transport: PlanCriticApprovalTransport;
}

export type PlanCriticApprovalRecording =
	| { outcome: 'recorded'; planId: string }
	/** The verdict is not an approval (or absent) — nothing to record. */
	| { outcome: 'not_approved'; reason: string }
	/** A verified approval exists already (replay) or the plan changed. */
	| { outcome: 'skipped'; reason: string }
	/** The approval could not be persisted; the gate stays blocked. */
	| { outcome: 'failed'; reason: string };

/**
 * Whether the ledger already carries a `plan_critic_gate` approval snapshot
 * bound to the exact `callId` (verified-prefix scan; a quarantined suffix is
 * never trusted — see #2531). This is the durable replay fence: a terminal
 * event may be delivered more than once (duplicate completion, crash
 * recovery, maintenance replay), but it can only ever approve once.
 */
export async function hasPlanCriticApprovalSnapshotForCall(
	directory: string,
	callId: string,
): Promise<boolean> {
	if (!callId) return false;
	try {
		const integrity = await readLedgerEventsWithIntegrity(directory);
		for (let i = integrity.events.length - 1; i >= 0; i--) {
			const event = integrity.events[i];
			if (event.event_type !== 'snapshot') continue;
			if (event.source !== 'critic_approved') continue;
			const payload = event.payload as
				| (Record<string, unknown> & {
						approval?: Record<string, unknown>;
				  })
				| undefined;
			if (payload?.approval?.source !== 'plan_critic_gate') continue;
			if (payload.approval.call_id === callId) return true;
		}
		return false;
	} catch (error) {
		// An unreadable ledger cannot PROVE the absence of a prior approval.
		// Fail closed: report "already present" so the caller skips the write
		// rather than risking a duplicate approval after a partial crash. The
		// caller surfaces this as a skipped recording with the read error.
		warn(
			`[plan-critic-approval] ledger read failed while checking for prior approval of call ${callId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return true;
	}
}

/**
 * Record the plan-critic approval snapshot for a verified critic child
 * completion. See the module docstring for the full safety contract. Never
 * throws — every failure is a typed outcome so both transports can surface it
 * without breaking their own error containment.
 */
export async function recordVerifiedPlanCriticApproval(
	directory: string,
	request: PlanCriticApprovalRequest,
): Promise<PlanCriticApprovalRecording> {
	if (extractPlanCriticVerdict(request.verdictText) !== 'APPROVED') {
		return { outcome: 'not_approved', reason: 'verdict is not APPROVED' };
	}

	// Issue #2012: a critic APPROVED verdict that fails to record a snapshot
	// permanently wedges the ratchet-tighter critic_pre_plan gate (no escape
	// hatch). loadPlanJsonOnly can transiently return null if the critic
	// dispatch landed microseconds before a concurrent save_plan flush. The
	// architect skill ordering (save_plan → CRITIC-GATE) is the primary
	// guarantee; this bounded retry is cheap insurance against the race so a
	// legitimate APPROVED is not silently dropped. Keep attempts tiny — the
	// common path resolves on the first read.
	let plan: Plan | null = await loadPlanJsonOnly(directory);
	if (!plan) {
		for (let attempt = 0; attempt < 2 && !plan; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			plan = await loadPlanJsonOnly(directory);
		}
	}
	if (!plan) {
		return {
			outcome: 'failed',
			reason: 'plan.json not readable after retry',
		};
	}

	// Async-transport staleness fence: the critic reviewed the plan as it was
	// at DISPATCH time (hash persisted on the delegation record). If the plan
	// changed since, this APPROVED verdict is stale — it must not approve the
	// edited plan. The architect must re-run the critic (or use the audited
	// manual escape hatch).
	if (
		request.dispatchPlanStructureHash !== undefined &&
		computePlanStructureHash(plan) !== request.dispatchPlanStructureHash
	) {
		return {
			outcome: 'skipped',
			reason:
				'plan structure changed since the critic dispatch — the APPROVED verdict no longer covers the current plan; re-run the critic gate',
		};
	}

	// Durable replay fence: the exact dispatch (callId) may only ever produce
	// one approval snapshot. Duplicate terminal delivery, crash recovery, and
	// maintenance replays all land here as no-ops.
	if (await hasPlanCriticApprovalSnapshotForCall(directory, request.callId)) {
		return {
			outcome: 'skipped',
			reason: 'an approval snapshot for this dispatch already exists',
		};
	}

	try {
		// Store the STRUCTURAL hash (status-excluded) as the snapshot's
		// payload_hash so `assertPlanCriticApprovedForExecution` can match this
		// approval after the architect flips the current task to `in_progress`
		// before delegating its coder. This MUST be the same hash function the
		// gate compares against (`computePlanStructureHash`), or the staleness
		// check would never match.
		await takeSnapshotEvent(directory, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				verdict: 'APPROVED',
				source: 'plan_critic_gate',
				session_id: request.parentSessionId,
				call_id: request.callId,
				approved_at: new Date().toISOString(),
				transport: request.transport,
			},
			payloadHashOverride: computePlanStructureHash(plan),
		});
		return { outcome: 'recorded', planId: derivePlanId(plan) };
	} catch (error) {
		log(
			`[plan-critic-approval] snapshot write failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return {
			outcome: 'failed',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
