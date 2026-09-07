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
 *   1. classifies the denial by its bounded structured cause (falling back to
 *      the leading code token of the error message),
 *   2. increments a per-(sessionID, invocationID, stable action, cause) streak,
 *   3. APPENDS (never rewrites) escalating guidance to the error message so the
 *      model reads it in the tool-rejection text, and
 *   4. at the hard rung, pushes an advisory + emits telemetry.
 *
 * The action projection intentionally retains only stable routing fields. It
 * canonicalizes the `Task` role and target aliases, while omitting prompts,
 * command content, and other retry-varying payloads. The same projection is
 * used by note, reset, and the test peek/expiry seams, so a success can clear
 * only what plausibly succeeded.
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

import { createHash } from 'node:crypto';
import { stripKnownSwarmPrefix } from '../config/schema';
import { SPAWN_CIRCUIT_DENIAL_CODE } from '../dispatch/spawn-circuit.js';
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
const MAX_ACTION_STRING_LENGTH = 128;
const MAX_ACTION_PATH_PREFIX_ITEMS = 64;
const STABLE_TARGET_KEYS = ['url', 'uri', 'source_url', 'pr_url'] as const;

/** Classification used when the message carries no recognisable code token. */
export const UNCLASSIFIED_GATE_DENIAL_CODE = 'UNCLASSIFIED';

function readOwnDataValue(record: unknown, key: string): unknown {
	if (!record || typeof record !== 'object' || Array.isArray(record))
		return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		return descriptor && 'value' in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function readFirstNormalizedOwnDataValue<T>(
	record: unknown,
	keys: readonly string[],
	normalize: (value: unknown) => T | undefined,
): T | undefined {
	for (const key of keys) {
		const value = readOwnDataValue(record, key);
		try {
			const normalized = normalize(value);
			if (normalized !== undefined) return normalized;
		} catch {
			/* A malformed argument cannot break the fail-closed caller. */
		}
	}
	return undefined;
}

function boundedActionString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	// Keep the semantic value intact here. `createActionIdentity` applies the
	// shared bounded hashing policy to public fields and path collections; raw
	// prefix truncation would make two long targets collide.
	return trimmed;
}

function boundedActionScalar(
	value: unknown,
): string | number | boolean | undefined {
	if (typeof value === 'string') return boundedActionString(value);
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'boolean') return value;
	return undefined;
}

function boundedStableTarget(value: unknown): string | undefined {
	const normalized = boundedActionString(value);
	if (normalized === undefined || hasControlCharacters(normalized)) {
		return undefined;
	}
	return normalized;
}

interface PathAliasProjection {
	value: string | string[];
	tailDigest?: string;
}

function boundedPathAlias(value: unknown): PathAliasProjection | undefined {
	if (typeof value === 'string') {
		const normalized = boundedActionString(value);
		return normalized === undefined ? undefined : { value: normalized };
	}
	if (!Array.isArray(value)) return undefined;
	try {
		const paths = value
			.map((entry) => boundedActionString(entry))
			.filter((entry): entry is string => entry !== undefined);
		if (paths.length === 0) return undefined;
		const normalizedPaths = [...new Set(paths)].sort();
		if (normalizedPaths.length <= MAX_ACTION_PATH_PREFIX_ITEMS) {
			return { value: normalizedPaths };
		}
		const tailHasher = createHash('sha256');
		tailHasher.update(
			`tail-count:${normalizedPaths.length - MAX_ACTION_PATH_PREFIX_ITEMS};`,
		);
		for (
			let index = MAX_ACTION_PATH_PREFIX_ITEMS;
			index < normalizedPaths.length;
			index += 1
		) {
			const pathValue = normalizedPaths[index];
			// Index and value length framing keeps concatenations unambiguous while
			// the hash keeps raw paths out of the action projection.
			tailHasher.update(`entry-index:${index};length:${pathValue.length};`);
			tailHasher.update(pathValue);
		}
		const tailDigest = tailHasher.digest('hex').slice(0, 16);
		return { value: normalizedPaths, tailDigest };
	} catch {
		return undefined;
	}
}

function gateActionArgs(tool: string, args: unknown): Record<string, unknown> {
	const projection: Record<string, unknown> = {};
	const normalizedTool = normalizeToolNameLowerCase(tool ?? '');
	if (normalizedTool === 'task') {
		const discriminator = gateDenialDiscriminator(tool, args);
		if (discriminator) projection.subagent_type = discriminator;
	}

	const record = args;
	const taskId = readFirstNormalizedOwnDataValue(
		record,
		['taskId', 'task_id', 'id'],
		boundedActionScalar,
	);
	if (taskId !== undefined) projection.taskId = taskId;
	if (normalizedTool === 'update_task_status') {
		const status = readFirstNormalizedOwnDataValue(
			record,
			['status'],
			boundedActionScalar,
		);
		if (status !== undefined) projection.status = status;
	}
	const phase = readFirstNormalizedOwnDataValue(
		record,
		['phase', 'phase_number'],
		boundedActionScalar,
	);
	if (phase !== undefined) projection.phase = phase;
	const mode = readFirstNormalizedOwnDataValue(
		record,
		['mode', 'execution_mode'],
		boundedActionScalar,
	);
	if (mode !== undefined) projection.mode = mode;
	const background = readFirstNormalizedOwnDataValue(
		record,
		['background', 'run_in_background', 'runInBackground'],
		(value) => {
			if (typeof value === 'boolean') return value;
			if (typeof value !== 'string') return undefined;
			const normalized = value.trim().toLowerCase();
			return normalized === 'true'
				? true
				: normalized === 'false'
					? false
					: undefined;
		},
	);
	if (background !== undefined) projection.background = background;
	const workingDirectory = readFirstNormalizedOwnDataValue(
		record,
		['working_directory', 'workingDirectory'],
		boundedActionScalar,
	);
	if (workingDirectory !== undefined) {
		projection.working_directory = workingDirectory;
	}
	const scopeId = readFirstNormalizedOwnDataValue(
		record,
		['scope_id', 'scopeId', 'scope'],
		boundedActionScalar,
	);
	if (scopeId !== undefined) projection.scope_id = scopeId;
	const pathAlias = readFirstNormalizedOwnDataValue(
		record,
		['filePath', 'file', 'path', 'paths', 'files'],
		boundedPathAlias,
	);
	if (pathAlias !== undefined) {
		projection.path = pathAlias.value;
		if (pathAlias.tailDigest !== undefined) {
			projection.path_tail_digest = pathAlias.tailDigest;
		}
	}
	const stableTarget = readFirstNormalizedOwnDataValue(
		record,
		STABLE_TARGET_KEYS,
		boundedStableTarget,
	);
	if (stableTarget !== undefined) projection.url = stableTarget;
	return projection;
}

function gateActionIdentity(tool: string, args: unknown) {
	return createActionIdentity({
		tool: normalizeToolNameLowerCase(tool ?? ''),
		args: gateActionArgs(tool, args),
	});
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
		const subagentType = readOwnDataValue(args, 'subagent_type');
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
	if (isGenericLegacyGateCode(candidate)) {
		return UNCLASSIFIED_GATE_DENIAL_CODE;
	}
	return candidate;
}

function isGenericLegacyGateCode(candidate: string): boolean {
	const normalized = candidate.trim().replace(/\s+/g, ' ').toUpperCase();
	return (
		normalized === 'BLOCKED' ||
		normalized === 'WRITE BLOCKED' ||
		normalized.startsWith('[SANDBOX] BLOCKED') ||
		normalized.startsWith('SANDBOX BLOCKED') ||
		normalized.startsWith('SANDBOX_')
	);
}

function boundedStructuredGateCode(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const candidate = value.trim();
	if (
		candidate.length === 0 ||
		candidate.length > MAX_CODE_LENGTH ||
		hasControlCharacters(candidate)
	) {
		return undefined;
	}
	if (isGenericLegacyGateCode(candidate)) return undefined;
	return candidate;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * Resolve a denial cause from an own data property only. Accessors and
 * inherited values are intentionally ignored so a hostile/frozen error cannot
 * make tracking invoke arbitrary code. The message parser remains the
 * trajectory logger's message-only boundary.
 */
export function deriveStructuredGateDenialCode(
	err: unknown,
): string | undefined {
	for (const key of ['gateCode', 'code'] as const) {
		const candidate = boundedStructuredGateCode(readOwnDataValue(err, key));
		if (candidate !== undefined) return candidate;
	}
	return undefined;
}

function deriveGateDenialCause(err: unknown, message: string): string {
	return deriveStructuredGateDenialCode(err) ?? deriveGateDenialCode(message);
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
	if (code === UNCLASSIFIED_GATE_DENIAL_CODE) {
		return `\n[swarm] This is denial #${count} with no stable cause classification. Do NOT retry the same dispatch; diagnose the current blocker and present it to the user if it persists.`;
	}
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
	actionPattern = tool,
): string {
	const safePattern = actionPattern
		.slice(0, MAX_ACTION_STRING_LENGTH)
		.replace(/[^a-zA-Z0-9_.:-]/g, '_');
	return `\n[swarm] GATE DENIAL LOOP: ${count} consecutive ${code} denial(s) for action ${safePattern}. Do not retry this exact action unchanged. Diagnose the current cause, then repair or rescope it; otherwise handoff, abort, or exit Full-Auto.`;
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

		// Issue #2507: spawn-protection denials own their own escalation
		// ladder (threshold -> OPEN -> single half-open probe -> reopen).
		// Counting them here as a second policy.gate_denial streak would put
		// two accounting owners on one failure category (AGENTS.md invariant
		// 9); every retry of an open action is already denied before any
		// host launch, so containment does not depend on a second STOP rung.
		const errorObject = err as { message: string };
		const code = deriveGateDenialCause(err, errorObject.message);
		if (code === SPAWN_CIRCUIT_DENIAL_CODE) {
			return NOT_COUNTED;
		}

		const originalMessage = errorObject.message;
		const normalizedTool = normalizeToolNameLowerCase(tool ?? '');
		const session = ensureAgentSession(sessionID);
		const invocationID = session.activeInvocationId ?? 0;
		const action = gateActionIdentity(tool, args);
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
		if (stopped) {
			appended += gateDenialStopText(
				count,
				code,
				normalizedTool,
				action.pattern,
			);
		}

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
			const stopText = gateDenialStopText(
				count,
				code,
				normalizedTool,
				action.pattern,
			);
			const advisoryKey = `[swarm:gate-denial-loop:${code}:${action.digest.slice(0, 12)}]`;
			try {
				pushAdvisory(session, `${advisoryKey}${stopText}`, {
					dedupeKey: advisoryKey,
				});
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
		const action = gateActionIdentity(tool, args);
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
		target: unknown = undefined,
	): number =>
		peekActionCircuitCount(
			sessionID,
			getAgentSession(sessionID)?.activeInvocationId ?? 0,
			gateActionIdentity(
				tool,
				typeof target === 'string' ? { subagent_type: target } : target,
			).digest,
			`policy.gate_denial:${code}`,
		),
	/** Force a streak's TTL into the past so eviction can be tested. */
	expireStreak: (
		sessionID: string,
		tool: string,
		code: string,
		target: unknown = undefined,
	): void => {
		expireActionCircuit(
			sessionID,
			getAgentSession(sessionID)?.activeInvocationId ?? 0,
			gateActionIdentity(
				tool,
				typeof target === 'string' ? { subagent_type: target } : target,
			).digest,
			`policy.gate_denial:${code}`,
		);
	},
} as const;
