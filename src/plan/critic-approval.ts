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

/**
 * Signals that carry EXPLICIT plan-gate intent. The critic-gate protocol
 * (`.opencode/skills/critic-gate/SKILL.md`) instructs the architect to mark
 * the dispatch with `MODE: CRITIC-GATE`; the substring `critic-gate` covers
 * every documented variant of that marker. This is deliberately much
 * narrower than {@link PLAN_CRITIC_TASK_SIGNALS}: an ordinary critic review
 * that merely mentions `plan.md` or "review the plan" is NOT a plan-gate
 * review and must never auto-approve the `critic_pre_plan` gate (audit
 * P2-1 — a false positive releases the coder gate on an unverified review).
 */
export const PLAN_CRITIC_GATE_INTENT_SIGNALS = ['critic-gate'] as const;

/**
 * Whether a critic dispatch carries EXPLICIT plan-gate intent. Only a
 * dispatch classified here may create the durable plan-critic dispatch
 * binding (`BackgroundPlanCriticDispatch` in
 * `src/background/pending-delegations.ts`) whose existence is the
 * precondition for ANY automatic approval recording. The broad
 * {@link taskLooksLikePlanCritic} heuristic remains for non-security
 * classification only — it is never sufficient for an auto-approval.
 */
export function taskIsExplicitPlanCriticGate(
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
	return PLAN_CRITIC_GATE_INTENT_SIGNALS.some((signal) =>
		text.includes(signal),
	);
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

/**
 * A fully valid, unambiguous `VERDICT:` line. The label (optionally
 * markdown-bold), the colon, and EXACTLY ONE verdict token that ends the
 * line — no alternatives list (`|`, `/`, `,`), no trailing prose, no
 * partial prefix. Case-insensitive; CRLF is normalized before matching.
 */
const VERDICT_LINE =
	/^[ \t]*(?:\*\*)?VERDICT(?:\*\*)?[ \t]*:[ \t]*(APPROVED|NEEDS_REVISION|REJECTED)[ \t]*$/i;

/** A `## Verdict`-style heading (the verdict section specifically). */
const VERDICT_HEADING = /^#{1,6}[ \t]*Verdict[ \t]*$/i;

/** A bare verdict token as the ONLY content of a line. */
const BARE_VERDICT_LINE = /^[ \t]*(APPROVED|NEEDS_REVISION|REJECTED)[ \t]*$/i;

/**
 * Opening fence marker: at least three backticks or tildes at line start
 * (an info string may follow for an opening backtick fence).
 */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Remove every region that can never carry the authoritative verdict:
 * fenced code blocks (``` and ~~~ with proper open/close marker pairing),
 * markdown blockquote lines, and table/enumeration rows containing `|`.
 * Returns the surviving lines joined with `\n`.
 *
 * Closing-fence pairing follows the CommonMark rule: a closing fence must
 * use the same marker character and be at least as long as the opening
 * fence, so a 4-backtick block containing a 3-backtick snippet does not
 * close early and leak its content as real verdict text.
 */
function stripVerdictExclusionZones(text: string): string {
	const lines = text.split(/\r?\n/);
	let fenceChar: '`' | '~' | null = null;
	let fenceLength = 0;
	const kept: string[] = [];
	for (const line of lines) {
		const fenceMatch = FENCE_OPEN.exec(line);
		if (fenceChar !== null) {
			if (fenceMatch && fenceMatch[1][0] === fenceChar) {
				const rest = line.slice(fenceMatch[0].length);
				// Closing fence: same marker, at least the opening length, and
				// nothing but that marker (+ whitespace) on the line.
				if (fenceMatch[1].length >= fenceLength && /^[ \t]*$/.test(rest)) {
					fenceChar = null;
					fenceLength = 0;
				}
			}
			// Any other line inside the fence is dropped.
			continue;
		}
		if (fenceMatch) {
			fenceChar = fenceMatch[1][0] as '`' | '~';
			fenceLength = fenceMatch[1].length;
			continue;
		}
		// Markdown blockquote (incl. nested `>>`) — quoted output templates.
		if (/^[ \t]*>/.test(line)) continue;
		// Table rows AND the rubric enumeration
		// (`VERDICT: APPROVED | NEEDS_REVISION | REJECTED`) — a `|` on a
		// verdict-shaped line is an alternatives list, never a verdict.
		if (line.includes('|')) continue;
		kept.push(line);
	}
	return kept.join('\n');
}

export function extractPlanCriticVerdict(
	output: unknown,
): 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | null {
	const rawText = outputText(output);
	if (!rawText) return null;

	const text = stripVerdictExclusionZones(rawText);
	if (!text) return null;
	const lines = text.split('\n');

	type VerdictToken = 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	const candidates: VerdictToken[] = [];

	// Primary signal: fully valid `VERDICT: <TOKEN>` lines OUTSIDE code
	// fences, quotes, and tables. Multiple verdict lines are only accepted
	// when they are unanimous — contradictory verdicts (e.g. an "Example:"
	// template followed by the real negative verdict) are ambiguous and
	// fail closed (audit P0-1 case C).
	const strictTokens: VerdictToken[] = [];
	for (const line of lines) {
		const match = VERDICT_LINE.exec(line);
		if (match) {
			strictTokens.push(match[1].toUpperCase() as VerdictToken);
		}
	}
	if (strictTokens.length > 0) {
		const first = strictTokens[0];
		if (!strictTokens.every((token) => token === first)) return null;
		candidates.push(first);
	}

	// Fallback 1: a `## Verdict` heading followed (within 3 lines) by a line
	// whose only content is the verdict token. Runs on the stripped text, so
	// a token inside a fence/quote/table under the heading is never read.
	for (let i = 0; i < lines.length; i++) {
		if (!VERDICT_HEADING.test(lines[i])) continue;
		const window = lines.slice(i + 1, i + 4);
		for (const nextLine of window) {
			const match = BARE_VERDICT_LINE.exec(nextLine);
			if (match) {
				candidates.push(match[1].toUpperCase() as VerdictToken);
				break;
			}
		}
		break;
	}

	// Fallback 2: a BARE verdict token on its own line, only in the final
	// few lines of the (stripped) output — recovers the "the critic just
	// wrote APPROVED at the end" case (issue #2012) while a mid-review
	// mention cannot trigger it.
	const tailStart = Math.max(0, lines.length - 6);
	for (let i = lines.length - 1; i >= tailStart; i--) {
		const match = BARE_VERDICT_LINE.exec(lines[i]);
		if (match) {
			candidates.push(match[1].toUpperCase() as VerdictToken);
			break;
		}
	}

	// Cross-strategy agreement: every recovered candidate must agree.
	if (candidates.length === 0) return null;
	const verdict = candidates[0];
	if (!candidates.every((token) => token === verdict)) return null;
	return verdict;
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
	 * True when the host delivered the terminal result TRUNCATED (the
	 * envelope's resultTruncated flag). A truncated text cannot prove a
	 * final verdict — the authoritative `VERDICT:` line may be cut off —
	 * so no approval is ever recorded (audit P0-1 item 10).
	 */
	verdictTruncated?: boolean;
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
	/**
	 * A verified approval exists already (replay, `alreadyRecorded`) or the
	 * plan changed concurrently (`conflict`). Nothing is recorded.
	 */
	| {
			outcome: 'skipped';
			reason: string;
			reasonCode?: 'already_recorded' | 'conflict';
	  }
	/**
	 * The approval could not be persisted; the gate stays blocked. A
	 * `ledger_unreadable` reasonCode distinguishes a broken ledger from a
	 * plain write failure (audit P1-1 diagnosis fix).
	 */
	| {
			outcome: 'failed';
			reason: string;
			reasonCode?:
				| 'ledger_unreadable'
				| 'plan_unreadable'
				| 'write_failed';
	  };

/** Durable replay-fence probe result for one dispatch (call id). */
export type PlanCriticApprovalSnapshotPresence =
	| { status: 'absent' }
	| { status: 'present' }
	| { status: 'unreadable'; reason: string };

/**
 * Durable replay fence with an EXPLICIT read diagnosis: `present` (an
 * approval snapshot for this call id exists), `absent` (provably none), or
 * `unreadable` (the ledger could not be read — absence is NOT proven). The
 * legacy boolean wrapper below maps `unreadable` to `true` (conservative),
 * but recording decisions use this tri-state so a broken ledger is never
 * silently conflated with an existing approval.
 */
export async function inspectPlanCriticApprovalSnapshotForCall(
	directory: string,
	callId: string,
): Promise<PlanCriticApprovalSnapshotPresence> {
	if (!callId) return { status: 'absent' };
	try {
		// failClosedOnReadError: an approval fence must never mistake an
		// unreadable ledger (EACCES/EIO/EISDIR/…) for a provably empty one —
		// a present approval or a poison line could hide behind the read
		// error. Missing ledgers are still a clean `absent`.
		const integrity = await readLedgerEventsWithIntegrity(directory, {
			failClosedOnReadError: true,
		});
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
			if (payload.approval.call_id === callId) return { status: 'present' };
		}
		return { status: 'absent' };
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : String(error);
		warn(
			`[plan-critic-approval] ledger read failed while checking for prior approval of call ${callId}: ${reason}`,
		);
		return { status: 'unreadable', reason };
	}
}

/**
 * Whether the ledger already carries a `plan_critic_gate` approval snapshot
 * bound to the exact `callId` (verified-prefix scan; a quarantined suffix is
 * never trusted — see #2531). This is the durable replay fence: a terminal
 * event may be delivered more than once (duplicate completion, crash
 * recovery, maintenance replay), but it can only ever approve once.
 * Unreadable ledgers conservatively report `true` (cannot prove absence);
 * callers that need the distinction use
 * {@link inspectPlanCriticApprovalSnapshotForCall}.
 */
export async function hasPlanCriticApprovalSnapshotForCall(
	directory: string,
	callId: string,
): Promise<boolean> {
	const presence = await inspectPlanCriticApprovalSnapshotForCall(
		directory,
		callId,
	);
	return presence.status !== 'absent';
}

/**
 * Typed pre-commit fence failures. Thrown INSIDE the ledger evidence lock
 * (via takeSnapshotEvent's preCommitCheck) so a concurrent writer can never
 * interleave a check-then-write cycle; the recorder maps each code to a
 * distinct typed outcome.
 */
class PlanCriticApprovalFenceError extends Error {
	readonly code: 'already_recorded' | 'conflict' | 'ledger_unreadable';
	constructor(
		code: 'already_recorded' | 'conflict' | 'ledger_unreadable',
		message: string,
	) {
		super(message);
		this.name = 'PlanCriticApprovalFenceError';
		this.code = code;
	}
}

/**
 * Record the plan-critic approval snapshot for a verified critic child
 * completion. See the module docstring for the full safety contract. Never
 * throws — every failure is a typed outcome so both transports can surface it
 * without breaking their own error containment.
 *
 * Concurrency contract (audit P1-1): the existence check and the snapshot
 * commit run under ONE serialization boundary — the ledger evidence lock —
 * via takeSnapshotEvent's `preCommitCheck`. Two racing recorders for the
 * same dispatch cannot both pass the check: the lock serializes them, and
 * the loser's fence re-scan observes the winner's committed snapshot and
 * aborts with `already_recorded`. The same fence re-verifies the plan's
 * structural hash immediately before the commit, so a plan edited between
 * the outer check and the commit aborts with `conflict` instead of writing
 * a stale approval.
 */
export async function recordVerifiedPlanCriticApproval(
	directory: string,
	request: PlanCriticApprovalRequest,
): Promise<PlanCriticApprovalRecording> {
	if (request.verdictTruncated === true) {
		// A truncated terminal text cannot prove a final verdict — the
		// authoritative VERDICT line may be cut off mid-token.
		return {
			outcome: 'not_approved',
			reason:
				'terminal result truncated — an APPROVED verdict is not provable from a cut-off result',
		};
	}
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
	const expectedStructureHash =
		request.dispatchPlanStructureHash ?? computePlanStructureHash(plan);
	if (
		request.dispatchPlanStructureHash !== undefined &&
		computePlanStructureHash(plan) !== request.dispatchPlanStructureHash
	) {
		return {
			outcome: 'skipped',
			reasonCode: 'conflict',
			reason:
				'plan structure changed since the critic dispatch — the APPROVED verdict no longer covers the current plan; re-run the critic gate',
		};
	}

	// Fast-path replay fence (diagnostic only — the authoritative dedup runs
	// inside the ledger lock below). An unreadable ledger is a DISTINCT
	// failure (not "already recorded"): the caller can surface a broken
	// ledger instead of a phantom prior approval.
	const presence = await inspectPlanCriticApprovalSnapshotForCall(
		directory,
		request.callId,
	);
	if (presence.status === 'present') {
		return {
			outcome: 'skipped',
			reasonCode: 'already_recorded',
			reason: 'an approval snapshot for this dispatch already exists',
		};
	}
	if (presence.status === 'unreadable') {
		return {
			outcome: 'failed',
			reasonCode: 'ledger_unreadable',
			reason: `ledger unreadable while checking for prior approval: ${presence.reason}`,
		};
	}

	try {
		// Store the STRUCTURAL hash (status-excluded) as the snapshot's
		// payload_hash so `assertPlanCriticApprovedForExecution` can match this
		// approval after the architect flips the current task to `in_progress`
		// before delegating its coder. This MUST be the same hash function the
		// gate compares against (`computePlanStructureHash`), or the staleness
		// check would never match.
		//
		// preCommitCheck runs INSIDE the ledger evidence lock, immediately
		// before the append, and re-verifies BOTH fence conditions against
		// the then-current durable state (audit P1-1):
		//  1. no approval snapshot for this call id exists yet, and
		//  2. the current plan still hashes to the structure the verdict
		//     covers. A concurrent plan edit between the outer check and the
		//     commit aborts with `conflict` — a stale approval can never land.
		await takeSnapshotEvent(
			directory,
			plan,
			{
				source: 'critic_approved',
				approvalMetadata: {
					verdict: 'APPROVED',
					source: 'plan_critic_gate',
					session_id: request.parentSessionId,
					call_id: request.callId,
					approved_at: new Date().toISOString(),
					transport: request.transport,
				},
				payloadHashOverride: expectedStructureHash,
				preCommitCheck: async () => {
					// Deterministic fault-injection seam for the exact race
					// point (between the outer checks and the in-lock fence).
					// Production leaves this null; tests use it to mutate the
					// plan (or the store) while the writer holds the lock.
					if (_internals.onPreCommitFence) {
						await _internals.onPreCommitFence(directory, request.callId);
					}
					// (1) durable replay fence — re-scan under the lock.
					const current =
						await inspectPlanCriticApprovalSnapshotForCall(
							directory,
							request.callId,
						);
					if (current.status === 'present') {
						throw new PlanCriticApprovalFenceError(
							'already_recorded',
							'an approval snapshot for this dispatch was committed concurrently',
						);
					}
					if (current.status === 'unreadable') {
						throw new PlanCriticApprovalFenceError(
							'ledger_unreadable',
							`ledger unreadable under the write lock: ${current.reason}`,
						);
					}
					// (2) plan-structure fence — the plan the verdict covers
					// must still be the current plan at commit time.
					const planNow = await loadPlanJsonOnly(directory);
					if (!planNow) {
						throw new PlanCriticApprovalFenceError(
							'conflict',
							'plan.json disappeared before the approval commit',
						);
					}
					if (computePlanStructureHash(planNow) !== expectedStructureHash) {
						throw new PlanCriticApprovalFenceError(
							'conflict',
							'plan structure changed before the approval commit — the APPROVED verdict no longer covers the current plan; re-run the critic gate',
						);
					}
				},
			},
		);
		return { outcome: 'recorded', planId: derivePlanId(plan) };
	} catch (error) {
		if (
			error instanceof PlanCriticApprovalFenceError &&
			error.code === 'already_recorded'
		) {
			return {
				outcome: 'skipped',
				reasonCode: 'already_recorded',
				reason: error.message,
			};
		}
		if (
			error instanceof PlanCriticApprovalFenceError &&
			error.code === 'conflict'
		) {
			return {
				outcome: 'skipped',
				reasonCode: 'conflict',
				reason: error.message,
			};
		}
		if (
			error instanceof PlanCriticApprovalFenceError &&
			error.code === 'ledger_unreadable'
		) {
			return {
				outcome: 'failed',
				reasonCode: 'ledger_unreadable',
				reason: error.message,
			};
		}
		log(
			`[plan-critic-approval] snapshot write failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return {
			outcome: 'failed',
			reasonCode: 'write_failed',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Test-only dependency seam (repo `_internals` DI convention — no
 * mock.module). `onPreCommitFence` runs INSIDE the pre-commit fence, under
 * the ledger evidence lock, right before the dedup/plan-hash checks — the
 * exact point a concurrent mutation would interleave in production.
 */
export const _internals: {
	onPreCommitFence: null | ((
		directory: string,
		callId: string,
	) => Promise<void> | void);
} = {
	onPreCommitFence: null,
};
