/**
 * GATE DENIAL TRACKER (issue #2063, workstream B1)
 *
 * The architect session had no containment for a *denial-retry* loop: every
 * fail-closed `tool.execute.before` hook throws, the host reports the throw as
 * a tool rejection, and the model happily re-issues the identical dispatch —
 * forever. Nothing counted the repeats, so nothing ever escalated.
 *
 * This module owns that counter. `noteGateDenial` is called from the single
 * catch site wrapping the fail-closed chain in `src/index.ts`. It:
 *   1. classifies the denial by the leading code token of the error message,
 *   2. increments a per-(sessionID, toolName, discriminator, code) streak,
 *   3. APPENDS (never rewrites) escalating guidance to the error message so the
 *      model reads it in the tool-rejection text, and
 *   4. at the hard rung, pushes an advisory + emits telemetry.
 *
 * The DISCRIMINATOR (reviewer round-4 REQUIRED 2) is the canonicalized
 * `subagent_type` of a `Task` call, and the empty string for every other tool.
 * Without it the reset was too wide: `resetGateDenialStreaks` drops a whole
 * (session, tool) prefix on any successful completion of that tool, so ONE
 * successful `Task` → `explorer` erased a 4-deep `ACCEPTANCE_FIELD_REQUIRED`
 * streak on `Task` → `coder`. Under the interleaving the loop actually
 * exhibits — deny coder, delegate an explorer to investigate, deny coder again —
 * the STOP rung was unreachable. Sub-scoping both the count and the reset by
 * dispatch target makes a success clear only what plausibly succeeded.
 *
 * Invariants this module must not break:
 *   - The caller ALWAYS rethrows. Decoration is append-only, so the leading
 *     code token of the original message stays byte-identical and every
 *     existing consumer that substring-matches a gate code keeps working.
 *   - Abort/cancel errors are excluded entirely (a user hitting escape three
 *     times is not a loop) — they neither count nor reset an existing streak.
 *   - Nothing here may throw. A tracker failure must never convert a
 *     fail-closed denial into a different error.
 *
 * NOT to be confused with `swarmState.gateDenialCounts` (src/state.ts:768),
 * which counts knowledge-application gate denials keyed by *critical-directive
 * identity*. Different trigger, different key, different lifecycle.
 *
 * Eviction is modelled on `BoundedPendingScopeMap`
 * (src/hooks/delegation-gate.ts:144-179) — TTL sweep plus a hard size cap — but
 * deliberately re-implemented here rather than imported, because
 * `delegation-gate.ts` is itself a member of the chain this module wraps and an
 * import would create a cycle.
 */

import { stripKnownSwarmPrefix } from '../config/schema';
import {
	_test_exports as actionCircuitTestExports,
	armActionCircuitAttempt,
	clearActionCircuit,
	clearAllActionCircuits,
	expireActionCircuit,
	noteActionCircuitFailure,
	peekActionCircuitCount,
} from '../failures/action-circuit.js';
import { createActionIdentity } from '../failures/action-identity.js';
import { ensureAgentSession, getAgentSession } from '../state';
import { telemetry } from '../telemetry.js';
import { pushAdvisory } from '../utils/advisory-queue';
import { normalizeToolNameLowerCase } from './normalize-tool-name';

/** Default streak length at which the "do not retry" guidance is appended. */
export const DEFAULT_GATE_DENIAL_WARN_THRESHOLD = 3;

/** Default streak length at which the hard STOP directive is appended. */
export const DEFAULT_GATE_DENIAL_STOP_THRESHOLD = 5;

/**
 * Maximum number of tracked (session, tool, code) streaks. A busy multi-swarm
 * process touches a handful per session; 500 is the same order as the other
 * bounded per-session maps in this codebase (MAX_TRACKED_STEP_SESSIONS).
 */
/**
 * Idle TTL for a streak. A denial streak that has not been touched for 30
 * minutes is stale by construction — the model moved on. Matches the
 * `execution_stall_episode_minutes` idleness window so the two containment
 * levers age out on the same clock.
 */
/**
 * Upper bound on the derived code token. Purely a key-size bound: a message
 * whose pre-colon prefix runs longer than this is not a gate code, it is prose,
 * and prose is classified as UNCLASSIFIED so a variable prefix cannot shatter a
 * streak into singletons.
 */
const MAX_CODE_LENGTH = 64;

/** Classification used when the message carries no recognisable code token. */
export const UNCLASSIFIED_GATE_DENIAL_CODE = 'UNCLASSIFIED';

function gateActionArgs(
	tool: string,
	_args: unknown,
	discriminator: string,
): Record<string, unknown> {
	if (normalizeToolNameLowerCase(tool ?? '') !== 'task') return {};
	return discriminator ? { subagent_type: discriminator } : {};
}

/**
 * Upper bound on the derived discriminator. `subagent_type` is model-supplied
 * text, so it is bounded for the same reason {@link MAX_CODE_LENGTH} bounds the
 * code: an unbounded map key is an unbounded map.
 */
const MAX_DISCRIMINATOR_LENGTH = 64;

/**
 * Sub-scope of a denial streak inside one (session, tool) pair.
 *
 * For a `Task` call this is the canonicalized dispatch target, so `mega_coder`
 * and `coder` share one streak (matching `canonicalDispatchRole` in
 * `guardrails/execution-stall.ts`). Every other tool — and a `Task` whose
 * `subagent_type` is absent or not a string — yields `''`, which preserves the
 * pre-discriminator behavior for them exactly.
 *
 * Deliberately reads `subagent_type` ONLY. `parseDelegationArgs`
 * (`hooks/skill-propagation-gate.ts:400`) additionally falls back to the first
 * non-empty line of the delegation PROMPT, which would turn arbitrary
 * model-authored prose into a map key — an unbounded-cardinality hazard
 * (invariant 8) and a way for the model to shatter its own streak into
 * singletons by varying one line of text.
 *
 * Never throws.
 */
export function gateDenialDiscriminator(tool: string, args: unknown): string {
	try {
		if (normalizeToolNameLowerCase(tool ?? '') !== 'task') return '';
		const subagentType = (args as Record<string, unknown> | undefined)
			?.subagent_type;
		if (typeof subagentType !== 'string' || subagentType.length === 0) {
			return '';
		}
		const canonical = stripKnownSwarmPrefix(subagentType).trim().toLowerCase();
		if (canonical.length === 0) return '';
		return canonical.slice(0, MAX_DISCRIMINATOR_LENGTH);
	} catch {
		return '';
	}
}

/**
 * Derive the denial classification from an error message: the leading token up
 * to the first `:`, trimmed.
 *
 * `'ACCEPTANCE_FIELD_COVERAGE_MISMATCH: task 1.1 ...'` -> `'ACCEPTANCE_FIELD_COVERAGE_MISMATCH'`
 * `'FULL_AUTO_DENY [path_out_of_root]: ...'`           -> `'FULL_AUTO_DENY [path_out_of_root]'`
 * `'Blocked by skill propagation gate'`                -> `'UNCLASSIFIED'` (no colon)
 *
 * The whole point of the classification is that repeats of the SAME cause share
 * a value, so anything that cannot be a stable code (empty, absent, or longer
 * than {@link MAX_CODE_LENGTH}) collapses to UNCLASSIFIED rather than producing
 * a per-occurrence key.
 */
export function deriveGateDenialCode(message: string): string {
	if (typeof message !== 'string') return UNCLASSIFIED_GATE_DENIAL_CODE;
	const colonIndex = message.indexOf(':');
	if (colonIndex <= 0) return UNCLASSIFIED_GATE_DENIAL_CODE;
	const candidate = message.slice(0, colonIndex).trim();
	if (candidate.length === 0 || candidate.length > MAX_CODE_LENGTH) {
		return UNCLASSIFIED_GATE_DENIAL_CODE;
	}
	return candidate;
}

/**
 * True when the thrown value is a user/host abort rather than a policy denial.
 * Aborts must not count toward a denial streak AND must not reset one: a user
 * cancelling mid-loop does not mean the loop was resolved.
 */
export function isAbortLikeError(err: unknown): boolean {
	if (err && typeof err === 'object') {
		const name = (err as { name?: unknown }).name;
		if (name === 'AbortError') return true;
		const message = (err as { message?: unknown }).message;
		if (typeof message === 'string' && message.startsWith('AbortError')) {
			return true;
		}
	}
	return false;
}

/** The append-only warn rung. Exported so tests assert the exact wording. */
export function gateDenialWarnText(count: number, code: string): string {
	return `\n[swarm] This is denial #${count} with the same cause (${code}). Do NOT retry the same dispatch; fix the named cause or present the blocker to the user.`;
}

/**
 * The append-only hard rung, modelled on `nonTransientHardStopMessage`
 * (src/hooks/guardrails/nontransient-circuit.ts:336-354).
 */
export function gateDenialStopText(
	count: number,
	code: string,
	tool: string,
): string {
	return `\n[swarm] GATE DENIAL LOOP: ${count} consecutive ${code} denial(s) for tool ${tool}. STOP tool calls and report the blocker to the user with the full error text.`;
}

export interface GateDenialOptions {
	/**
	 * `guardrails.enabled`. The thresholds live in the `guardrails` config block
	 * and the loader force-sets `enabled: false` when a user turns guardrails
	 * off, so that flag has to mean "no guardrails behavior" here too — otherwise
	 * the config surface lies. When false the denial is neither counted nor
	 * decorated, and no advisory or telemetry is produced. Defaults to true.
	 */
	enabled?: boolean;
	/** `guardrails.gate_denial_warn_threshold` */
	warnThreshold?: number;
	/** `guardrails.gate_denial_stop_threshold` */
	stopThreshold?: number;
}

export interface GateDenialOutcome {
	/** Classification used for the streak key. */
	code: string;
	/** Streak length AFTER this denial. `0` when the denial was not counted. */
	count: number;
	/** Whether the warn rung fired on this denial. */
	warned: boolean;
	/** Whether the hard rung fired on this denial. */
	stopped: boolean;
	/** Whether the error message was mutated. */
	decorated: boolean;
}

const NOT_COUNTED: GateDenialOutcome = Object.freeze({
	code: UNCLASSIFIED_GATE_DENIAL_CODE,
	count: 0,
	warned: false,
	stopped: false,
	decorated: false,
});

/**
 * Count one fail-closed denial and, past the configured rungs, APPEND guidance
 * to `err.message` in place.
 *
 * The caller is responsible for rethrowing the SAME object — mutating in place
 * preserves `name`, `stack`, and any custom fields a gate attached, which
 * constructing a replacement Error would destroy.
 *
 * `args` are the resolved `tool.execute.before` args of the DENIED call. They
 * derive the discriminator, so a `Task` → `coder` streak and a `Task` →
 * `explorer` streak are counted (and reset) separately. Omitting them is safe
 * and reproduces the pre-discriminator single-bucket behavior.
 *
 * Never throws.
 */
export function noteGateDenial(
	sessionID: string,
	tool: string,
	err: unknown,
	options?: GateDenialOptions,
	args?: unknown,
): GateDenialOutcome {
	try {
		// Guardrails turned off: no counting, no decoration, no side effects.
		if (options?.enabled === false) return NOT_COUNTED;

		// Abort/cancel: not a policy denial. Do not count, do not reset, do not
		// decorate.
		if (isAbortLikeError(err)) return NOT_COUNTED;

		// Non-Error throws (strings, plain objects) carry no writable `message`
		// contract. Classify nothing and decorate nothing rather than guessing.
		if (
			!err ||
			typeof err !== 'object' ||
			typeof (err as { message?: unknown }).message !== 'string'
		) {
			return NOT_COUNTED;
		}

		const errorObject = err as { message: string };
		const originalMessage = errorObject.message;
		const code = deriveGateDenialCode(originalMessage);
		const normalizedTool = normalizeToolNameLowerCase(tool ?? '');
		const discriminator = gateDenialDiscriminator(tool, args);
		const session = ensureAgentSession(sessionID);
		const invocationID = session.activeInvocationId ?? 0;
		const action = createActionIdentity({
			tool: normalizedTool,
			args: gateActionArgs(tool, args, discriminator),
		});
		const generationToken = armActionCircuitAttempt(
			sessionID,
			invocationID,
			action.digest,
		);

		const warnThreshold = normalizeThreshold(
			options?.warnThreshold,
			DEFAULT_GATE_DENIAL_WARN_THRESHOLD,
		);
		const stopThreshold = normalizeThreshold(
			options?.stopThreshold,
			DEFAULT_GATE_DENIAL_STOP_THRESHOLD,
		);
		const circuitKind = `policy.gate_denial:${code}`;
		const { entry } = noteActionCircuitFailure({
			sessionID,
			invocationID,
			actionDigest: action.digest,
			circuitKind,
			signal: originalMessage,
			generationToken,
			hardStopThreshold:
				code === UNCLASSIFIED_GATE_DENIAL_CODE
					? Number.MAX_SAFE_INTEGER
					: stopThreshold,
		});
		if (!entry) return NOT_COUNTED;
		const count = entry.count;

		const warned = count >= warnThreshold;
		// The STOP rung is deliberately NARROWER than the warn rung (reviewer
		// round-4 advisory E). UNCLASSIFIED is the catch-all bucket for every
		// denial whose message carries no stable code token, so five UNCLASSIFIED
		// denials are not evidence of five repeats of ONE cause — they may be five
		// different gates. The warn text ("denial #N with the same cause") is
		// cheap and still useful there, but the STOP directive tells the agent to
		// halt and report, and issuing that on a mixed bucket would stop a session
		// that is not actually looping. A real gate code is required to reach it.
		const stopped =
			count >= stopThreshold && code !== UNCLASSIFIED_GATE_DENIAL_CODE;
		if (!warned && !stopped) {
			return { code, count, warned: false, stopped: false, decorated: false };
		}

		let appended = '';
		if (warned) appended += gateDenialWarnText(count, code);
		if (stopped) appended += gateDenialStopText(count, code, normalizedTool);

		let decorated = false;
		try {
			// Append-only: the original message (and therefore the leading code
			// token every downstream consumer matches on) is preserved verbatim.
			errorObject.message = originalMessage + appended;
			decorated = errorObject.message !== originalMessage;
		} catch {
			// A frozen/getter-only `message` must not break the rethrow.
			decorated = false;
		}

		if (stopped) {
			try {
				pushAdvisory(
					session,
					`[swarm:gate-denial-loop:${code}] GATE DENIAL LOOP: ${count} consecutive ${code} denial(s) for tool ${normalizedTool}. STOP tool calls and report the blocker to the user with the full error text.`,
					{ dedupeKey: `[swarm:gate-denial-loop:${code}]` },
				);
			} catch {
				/* advisory delivery is best-effort; never blocks the rethrow */
			}
			try {
				telemetry.gateDenialLoop(sessionID, normalizedTool, code, count);
			} catch {
				/* telemetry is fire-and-forget */
			}
		}

		return { code, count, warned, stopped, decorated };
	} catch {
		// Defense in depth: the tracker must never change WHICH error propagates.
		return NOT_COUNTED;
	}
}

function normalizeThreshold(
	value: number | undefined,
	fallback: number,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.floor(value);
}

/**
 * Clear every denial streak for one (sessionID, toolName, discriminator) triple.
 *
 * Called when the fail-closed chain completes successfully for that tool: the
 * dispatch that was being denied now passes, so the streak is over.
 *
 * Two levels of scoping, both load-bearing:
 *   - by TOOL, so a successful `read` does not erase an in-progress `Task`
 *     denial loop; and
 *   - by DISCRIMINATOR, so a successful `Task` → `explorer` does not erase an
 *     in-progress `Task` → `coder` denial loop. `args` are the resolved
 *     `tool.execute.before` args of the call that just SUCCEEDED, which is the
 *     only thing that can be said to have been resolved. Omitting them clears
 *     the `''` bucket only.
 */
export function resetGateDenialStreaks(
	sessionID: string,
	tool: string,
	args?: unknown,
): void {
	try {
		const session = getAgentSession(sessionID);
		const invocationID = session?.activeInvocationId ?? 0;
		const action = createActionIdentity({
			tool: normalizeToolNameLowerCase(tool ?? ''),
			args: gateActionArgs(tool, args, gateDenialDiscriminator(tool, args)),
		});
		clearActionCircuit(sessionID, invocationID, action.digest, {
			reason: 'success',
		});
	} catch {
		/* never throws into the hook chain */
	}
}

/**
 * Drop all tracked streaks.
 *
 * A test/reset helper only — there is no `/swarm close` (or any other
 * production) caller. Streak lifetime in production is governed by
 * {@link GATE_DENIAL_TTL_MS}, the {@link MAX_TRACKED_DENIAL_STREAKS} LRU cap,
 * and `resetGateDenialStreaks`.
 */
export function clearGateDenialStreaks(): void {
	clearAllActionCircuits();
}

export const _test_exports = {
	MAX_TRACKED_DENIAL_STREAKS:
		actionCircuitTestExports.MAX_TRACKED_ACTION_CIRCUITS,
	GATE_DENIAL_TTL_MS: actionCircuitTestExports.ACTION_CIRCUIT_TTL_MS,
	MAX_CODE_LENGTH,
	MAX_DISCRIMINATOR_LENGTH,
	streakCount: (): number => actionCircuitTestExports.size(),
	/** Read a streak length without mutating it. */
	peekStreak: (
		sessionID: string,
		tool: string,
		code: string,
		discriminator = '',
	): number =>
		peekActionCircuitCount(
			sessionID,
			getAgentSession(sessionID)?.activeInvocationId ?? 0,
			createActionIdentity({
				tool: normalizeToolNameLowerCase(tool),
				args: gateActionArgs(tool, undefined, discriminator),
			}).digest,
			`policy.gate_denial:${code}`,
		),
	/** Force a streak's TTL into the past so eviction can be tested. */
	expireStreak: (
		sessionID: string,
		tool: string,
		code: string,
		discriminator = '',
	): void => {
		expireActionCircuit(
			sessionID,
			getAgentSession(sessionID)?.activeInvocationId ?? 0,
			createActionIdentity({
				tool: normalizeToolNameLowerCase(tool),
				args: gateActionArgs(tool, undefined, discriminator),
			}).digest,
			`policy.gate_denial:${code}`,
		);
	},
} as const;
