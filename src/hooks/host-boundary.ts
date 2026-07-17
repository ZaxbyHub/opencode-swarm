/**
 * Host-boundary adapter (issue #1849).
 *
 * The single place that translates real OpenCode SDK callback payloads into a
 * stable, typed internal context. Every downstream knowledge/delegation hook
 * reads from this adapter — never directly from the raw `input`/`output`
 * callback arguments. This eliminates the class of defect where hooks guessed
 * SDK payload shapes (`input.agent`, `input.args`, synthetic `role:'system'`
 * messages) that the host never provides.
 *
 * Authoritative SDK contract (`@opencode-ai/plugin@1.x`, `Hooks` interface):
 *
 *   tool.execute.before:  input  { tool, sessionID, callID }
 *                         output { args }                    ← mutable tool args
 *   tool.execute.after:   input  { tool, sessionID, callID }
 *                         output { title, output, metadata }
 *   experimental.chat.messages.transform:
 *                         input  {}                          ← no sessionID/agent
 *                         output { messages: { info: Message, parts }[] }
 *   experimental.chat.system.transform:
 *                         input  { sessionID?, model }
 *                         output { system: string[] }
 *   chat.message:         input  { sessionID, agent?, ... }  ← agent IS provided here
 *
 * `Message = UserMessage | AssistantMessage` — there is NO `role:'system'`
 * message variant. `UserMessage` carries `agent` + `sessionID`; `AssistantMessage`
 * carries `sessionID` only. System content is delivered via the separate
 * `experimental.chat.system.transform` hook.
 *
 * Identity recovery strategy (verified against the SDK contract):
 *  - For `tool.execute.*` and `experimental.chat.messages.transform`, the
 *    reliable identity source is `swarmState.activeAgent.get(sessionID)`, which
 *    is populated by the `chat.message` hook (where `agent` IS provided).
 *  - For `messages.transform`, the last user message's `info.agent` is a
 *    first-turn fallback when `swarmState.activeAgent` has no entry yet.
 *  - Multi-swarm prefixed names (`cohort_architect`) are canonicalized via
 *    `stripKnownSwarmPrefix` (suffix-based; handles any user-defined prefix).
 */

import { ORCHESTRATOR_NAME } from '../config/agent-names.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { swarmState } from '../state.js';
import { log } from '../utils/logger.js';
import { getStoredInputArgs } from './guardrails/stored-input-args.js';

/** Resolved context for `tool.execute.before` / `tool.execute.after`. */
export interface ToolBoundaryContext {
	tool: string;
	sessionID: string;
	callID: string;
	/** Active agent for this session (from swarmState.activeAgent; architect fallback). */
	agent: string;
	/** Canonicalized role, e.g. `architect` for `cohort_architect`. */
	callerRole: string;
	/**
	 * Mutable tool arguments.
	 *  - toolBefore: `output.args` (the SDK mutation target).
	 *  - toolAfter: `getStoredInputArgs(callID)` (the snapshot taken in toolBefore
	 *    by `guardrails/tool-before.ts`).
	 * `null` when absent (the host did not supply args, or the snapshot was
	 * already cleaned up).
	 */
	args: Record<string, unknown> | null;
	/** True when the caller canonicalizes to the orchestrator/architect role. */
	isArchitect: boolean;
}

/** Resolved context for `experimental.chat.messages.transform`. */
export interface MessageTransformContext {
	sessionID: string | undefined;
	/** Active agent (swarmState.activeAgent primary; last user message fallback). */
	agent: string | undefined;
	callerRole: string | undefined;
	isArchitect: boolean;
	isDelegate: boolean;
}

/**
 * Minimal shape of `output.messages[].info` we read. The real SDK `Message`
 * union carries many more fields; we only depend on `role`, `agent`
 * (UserMessage only), and `sessionID`.
 */
export interface MessageInfoLike {
	role?: string;
	agent?: string;
	sessionID?: string;
}

export interface MessageArrayLike {
	messages?: Array<{ info?: MessageInfoLike }>;
}

/**
 * Resolve the active agent for a sessionID.
 *
 * PRIMARY: `swarmState.activeAgent.get(sessionID)` — set reliably by the
 * `chat.message` hook. FALLBACK: `ORCHESTRATOR_NAME` ('architect'), mirroring
 * the existing pre-#1849 behavior at `src/index.ts:2039-2041` (when no active
 * agent is mapped, the session is treated as the primary/architect).
 *
 * Never throws. Emits a bounded, debug-gated diagnostic only when the session
 * has no mapped agent (informational — the fallback is intentional, not an
 * error).
 */
function resolveAgent(sessionID: string | undefined): string {
	if (typeof sessionID === 'string' && sessionID.length > 0) {
		const mapped = swarmState.activeAgent.get(sessionID);
		if (mapped) return mapped;
	}
	log('[host-boundary] no activeAgent mapped; defaulting to orchestrator', {
		sessionID: sessionID ?? '<none>',
	});
	return ORCHESTRATOR_NAME;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toArgs(v: unknown): Record<string, unknown> | null {
	return isPlainObject(v) ? v : null;
}

/**
 * Build the `tool.execute.before` context.
 *
 * Reads `agent` from `swarmState.activeAgent` (NOT `input.agent`, which the
 * host does not provide) and `args` from `output.args` (NOT `input.args`).
 */
export function resolveToolBeforeContext(
	input: { tool: string; sessionID: string; callID: string },
	output: { args?: unknown },
): ToolBoundaryContext {
	const agent = resolveAgent(input.sessionID);
	const callerRole = stripKnownSwarmPrefix(agent).toLowerCase();
	return {
		tool: input.tool,
		sessionID: input.sessionID,
		callID: input.callID,
		agent,
		callerRole,
		args: toArgs(output?.args),
		isArchitect: callerRole === ORCHESTRATOR_NAME,
	};
}

/**
 * Build the `tool.execute.after` context.
 *
 * `args` is recovered from the snapshot taken in toolBefore via
 * `setStoredInputArgs(callID, output.args)` (`guardrails/tool-before.ts`). The
 * SDK `tool.execute.after` input has no `args` field and the output carries only
 * `title`/`output`/`metadata`, so the snapshot is the only correct source.
 */
export function resolveToolAfterContext(input: {
	tool: string;
	sessionID: string;
	callID: string;
}): ToolBoundaryContext {
	const agent = resolveAgent(input.sessionID);
	const callerRole = stripKnownSwarmPrefix(agent).toLowerCase();
	return {
		tool: input.tool,
		sessionID: input.sessionID,
		callID: input.callID,
		agent,
		callerRole,
		args: toArgs(getStoredInputArgs(input.callID)),
		isArchitect: callerRole === ORCHESTRATOR_NAME,
	};
}

/**
 * Build the `experimental.chat.messages.transform` context.
 *
 * The SDK `input` is `{}`, so session/agent identity is recovered from
 * `output.messages[].info`:
 *  - `sessionID` from any message's `info.sessionID` (every `Message` carries it).
 *  - `agent` PRIMARY from `swarmState.activeAgent.get(sessionID)`; FALLBACK from
 *    the LAST user message's `info.agent` (`UserMessage` carries `agent`).
 *
 * Critically, this NEVER searches for a `role:'system'` message — the SDK
 * `Message` union has no system-role variant, and looking for one was the root
 * cause of the dark-in-production architect injection (#1768/#1849).
 */
export function resolveMessageTransformContext(
	output: MessageArrayLike,
): MessageTransformContext {
	const messages = Array.isArray(output?.messages) ? output.messages : [];

	// sessionID: any message's info.sessionID (UserMessage and AssistantMessage
	// both carry it).
	let sessionID: string | undefined;
	for (const m of messages) {
		const sid = m?.info?.sessionID;
		if (typeof sid === 'string' && sid.length > 0) {
			sessionID = sid;
			break;
		}
	}

	// Agent: PRIMARY from session state (set by chat.message). FALLBACK: scan for
	// the LAST user message's info.agent (UserMessage carries agent).
	let agent: string | undefined = resolveAgentOptional(sessionID);
	if (!agent) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const info = messages[i]?.info;
			if (
				info?.role === 'user' &&
				typeof info.agent === 'string' &&
				info.agent
			) {
				agent = info.agent;
				break;
			}
		}
	}

	const callerRole = agent
		? stripKnownSwarmPrefix(agent).toLowerCase()
		: undefined;
	return {
		sessionID,
		agent,
		callerRole,
		isArchitect: callerRole === ORCHESTRATOR_NAME,
		isDelegate: !!agent && !!callerRole && callerRole !== ORCHESTRATOR_NAME,
	};
}

/** Like resolveAgent but returns undefined instead of the orchestrator fallback. */
function resolveAgentOptional(
	sessionID: string | undefined,
): string | undefined {
	if (typeof sessionID === 'string' && sessionID.length > 0) {
		const mapped = swarmState.activeAgent.get(sessionID);
		if (mapped) return mapped;
	}
	return undefined;
}

export const _internals = {
	resolveAgent,
	resolveAgentOptional,
	toArgs,
	isPlainObject,
};
