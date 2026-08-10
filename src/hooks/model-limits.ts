/**
 * Provider-Aware Model Limit Resolution — STATIC FALLBACK ONLY.
 *
 * > **The two tables below are a last resort, not the source of truth.**
 * > The authoritative context window is the live `model.limit.context` the host
 * > hands to `experimental.chat.system.transform`, resolved through
 * > `src/config/context-window.ts`. That value is already provider-specific:
 * > the host's model catalog is keyed `providers[providerID].models[modelID]`,
 * > and the on-disk catalog shows `github-copilot`'s `claude-sonnet-4.5` and
 * > `anthropic`'s `claude-sonnet-4-5` carrying different `limit.context`
 * > values. These tables are consulted only when no live value reached the
 * > call site (the `experimental.chat.messages.transform` paths on the very
 * > first turn of a session, before any `system.transform` has run).
 *
 * **These tables are known-stale and are deliberately NOT used to cap the live
 * value.** `PROVIDER_CAPS` claims Copilot caps everything at 128 000; the live
 * catalog shows Copilot Claude entries at 200 000 (`claude-sonnet-4.5`,
 * `claude-sonnet-4.6`) and 1 000 000 (`claude-fable-5`), with only `gpt-4.1`
 * actually at 128 000. Min-capping a correct live value against that would
 * reintroduce the too-small denominator the live derivation exists to remove.
 * `NATIVE_MODEL_LIMITS` is stale in the same direction (`claude-sonnet-4` is
 * listed at 200 000; the catalog reports 216 000).
 *
 * Do not "refresh" these tables by hand — that is the maintenance treadmill the
 * live derivation replaced. They exist so a first-turn `messages.transform`
 * consumer degrades to a plausible number instead of the flat 128 000 floor.
 */

import {
	type ContextWindowInputs,
	resolveContextWindow,
} from '../config/context-window';
import { log } from '../utils';

/**
 * Native model context limits (in tokens) when used on their native platform.
 *
 * Static fallback only — see the module header.
 */
export const NATIVE_MODEL_LIMITS: Record<string, number> = {
	'claude-sonnet-4': 200000,
	'claude-opus-4': 200000,
	'claude-haiku-4': 200000,
	'gpt-5': 400000,
	'gpt-5.1-codex': 400000,
	'gpt-5.1': 264000,
	'gpt-4.1': 1047576,
	'gemini-2.5-pro': 1048576,
	'gemini-2.5-flash': 1048576,
	o3: 200000,
	'o4-mini': 200000,
	'deepseek-r1': 163840,
	'deepseek-chat': 163840,
	'qwen3.5': 131072,
	'MiniMax-M3': 1000000,
	'MiniMax-M2.7': 204800,
};

/**
 * Provider-specific context caps that override native limits.
 *
 * Static fallback only, and known-stale — see the module header. This is NOT
 * applied as a ceiling over the live `model.limit.context`.
 */
export const PROVIDER_CAPS: Record<string, number> = {
	copilot: 128000,
	'github-copilot': 128000,
};

/**
 * Message structure from experimental.chat.messages.transform hook.
 */
interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
	modelID?: string;
	providerID?: string;
	[key: string]: unknown;
}

interface MessagePart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface MessageWithParts {
	info: MessageInfo;
	parts: MessagePart[];
}

/**
 * Extracts modelID and providerID from the most recent assistant message.
 *
 * @param messages - Array of messages from experimental.chat.messages.transform hook
 * @returns Object containing modelID and/or providerID if found
 *
 * @example
 * const info = extractModelInfo(messages);
 * // Returns: { modelID: 'claude-sonnet-4-6', providerID: 'anthropic' }
 * // Or: {} if no assistant messages or fields not found
 */
export function extractModelInfo(messages: MessageWithParts[]): {
	modelID?: string;
	providerID?: string;
} {
	if (!messages || messages.length === 0) {
		return {};
	}

	// Scan most recent assistant message for modelID and providerID
	// Process messages in reverse order (most recent first)
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message?.info) continue;

		// Look for assistant messages
		if (message.info.role === 'assistant') {
			const modelID = message.info.modelID;
			const providerID = message.info.providerID;

			// Return as soon as we find an assistant message with these fields
			if (modelID || providerID) {
				return {
					...(modelID ? { modelID } : {}),
					...(providerID ? { providerID } : {}),
				};
			}
		}
	}

	return {};
}

/**
 * Extracts the sessionID from a `experimental.chat.messages.transform` message
 * array, scanning newest-first.
 *
 * The messages hooks receive no `input.sessionID` (the plugin type declares
 * `input: {}`), but every message's `info` carries one. This is the key used to
 * look up the live `model.limit.context` that the `system.transform` hook
 * recorded for the session — see `getLiveContextWindow` in `src/state.ts`.
 *
 * @returns the sessionID, or `undefined` when no message carries one.
 */
export function extractSessionId(
	messages: MessageWithParts[] | undefined,
): string | undefined {
	if (!messages || messages.length === 0) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const sessionID = messages[i]?.info?.sessionID;
		if (typeof sessionID === 'string' && sessionID.length > 0) {
			return sessionID;
		}
	}
	return undefined;
}

// Track first-call logging to avoid spam
const loggedFirstCalls = new Set<string>();

/**
 * Static-table lookup used as `fallbackLookup` for
 * {@link resolveContextWindow}. Preserves the historical precedence of
 * the two tables relative to each other (provider cap first, then a
 * longest-prefix native match), and is reachable only when no live
 * `model.limit.context` was available.
 */
export function lookupStaticModelLimit(
	modelID?: string,
	providerID?: string,
): number | undefined {
	if (providerID && PROVIDER_CAPS[providerID] !== undefined) {
		return PROVIDER_CAPS[providerID];
	}
	if (modelID) {
		return findNativeLimit(modelID);
	}
	return undefined;
}

/**
 * Resolves the context limit for a given model/provider combination.
 *
 * Thin adapter over the single derivation in `src/config/context-window.ts` —
 * this function exists so the `experimental.chat.messages.transform` consumers
 * (`context-budget.ts`, `knowledge-injector.ts`, `tools/context-status.ts`)
 * keep their existing `(modelID, providerID, overrides)` call shape. All
 * ordering logic lives in the shared resolver; see its module header.
 *
 * Resolution order (first usable value wins):
 * 1. `configOverrides["<providerID>/<modelID>"]`
 * 2. `configOverrides["<modelID>"]`
 * 3. `configOverrides.default`
 * 4. `liveContextLimit` — the host's live `model.limit.context` for this session
 * 5. `PROVIDER_CAPS[providerID]`, else a longest-prefix `NATIVE_MODEL_LIMITS`
 *    match (both known-stale; see the module header)
 * 6. `DEFAULT_MODEL_CONTEXT_TOKENS` (128000)
 *
 * Two ordering changes vs. the pre-#1619 implementation, both deliberate:
 * - `configOverrides.default` moved from below the static tables to above
 *   them. An explicitly authored user value losing to a hardcoded table was a
 *   defect; it is now consistent with the compound and model-only keys, which
 *   already outranked the tables.
 * - The live `model.limit.context` was inserted above both tables, which is
 *   the entire point of this change.
 *
 * Any value that is not a finite number ≥ 1000 is skipped rather than used, so
 * a malformed override or a catalog entry with `limit.context: 0` can never
 * produce a `NaN` / `Infinity` percentage.
 *
 * @param modelID - The model identifier (e.g., "claude-sonnet-4-6", "gpt-5")
 * @param providerID - The provider identifier (e.g., "github-copilot", "anthropic")
 * @param configOverrides - User configuration overrides (`context_budget.model_limits`)
 * @param liveContextLimit - The live `model.limit.context` recorded for this
 *   session by the `system.transform` hook, when one has been seen
 * @returns The resolved context limit in tokens
 *
 * @example
 * // Live value wins over the stale static tables
 * resolveModelLimit("claude-sonnet-4-6", "github-copilot", {}, 200000)
 * // Returns: 200000
 *
 * @example
 * // Explicit user override beats the live value
 * resolveModelLimit("gpt-5", "github-copilot", { "github-copilot/gpt-5": 60000 }, 400000)
 * // Returns: 60000
 *
 * @example
 * // No live value: falls back to the static table (prefix match)
 * resolveModelLimit("claude-sonnet-4-6-20260301", "anthropic", {})
 * // Returns: 200000
 *
 * @example
 * // Malformed live value is ignored, not divided by
 * resolveModelLimit(undefined, undefined, {}, 0)
 * // Returns: 128000
 */
export function resolveModelLimit(
	modelID?: string,
	providerID?: string,
	configOverrides: Record<string, number> = {},
	liveContextLimit?: unknown,
): number {
	const inputs: ContextWindowInputs = {
		userLimits: configOverrides,
		modelID,
		providerID,
		liveContextLimit,
		fallbackLookup: lookupStaticModelLimit,
	};
	const resolution = resolveContextWindow(inputs);
	logFirstCall(
		modelID ?? '',
		providerID ?? '',
		resolution.source,
		resolution.tokens,
	);
	return resolution.tokens;
}

/**
 * Finds a native limit by prefix matching the modelID.
 * E.g., "claude-sonnet-4-6-20260301" matches "claude-sonnet-4" → 200000
 */
function findNativeLimit(modelID: string): number | undefined {
	// Try exact match first
	if (NATIVE_MODEL_LIMITS[modelID] !== undefined) {
		return NATIVE_MODEL_LIMITS[modelID];
	}

	// Try prefix matching (longest match wins)
	let bestMatch: string | undefined;
	for (const key of Object.keys(NATIVE_MODEL_LIMITS)) {
		if (modelID.startsWith(key)) {
			if (!bestMatch || key.length > bestMatch.length) {
				bestMatch = key;
			}
		}
	}

	return bestMatch ? NATIVE_MODEL_LIMITS[bestMatch] : undefined;
}

/**
 * Logs the first call for a model/provider combination to aid debugging.
 */
function logFirstCall(
	modelID: string,
	providerID: string,
	source: string,
	limit: number,
): void {
	const key = `${modelID || 'unknown'}::${providerID || 'unknown'}`;
	if (!loggedFirstCalls.has(key)) {
		loggedFirstCalls.add(key);
		// Startup diagnostic: debug-gated, not a warning (helps verify limit resolution at startup)
		log(
			`[model-limits] Resolved limit for ${modelID || '(no model)'}@${providerID || '(no provider)'}: ${limit} (source: ${source})`,
		);
	}
}
