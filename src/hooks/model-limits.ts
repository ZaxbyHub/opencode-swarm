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
	type ContextWindowSource,
	isUsableConfiguredWindow,
	isUsableContextWindow,
	resolveContextWindow,
} from '../config/context-window';
import { observeModelLimitResolution } from '../health/learning-health';
import { log, warn } from '../utils';

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
const MAX_TRACKED_MODEL_IDENTITIES = 256;
const loggedFirstCalls = new Set<string>();
const warnedUndersizedDefaults = new Set<string>();

function rememberBoundedModelIdentity(set: Set<string>, key: string): boolean {
	if (set.has(key)) return false;
	while (set.size >= MAX_TRACKED_MODEL_IDENTITIES) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
	set.add(key);
	return true;
}

/**
 * Coarse provenance class for a resolved model limit (issue #2044 item 1).
 * Maps the fine-grained {@link ContextWindowSource} rung onto the five classes
 * the issue names: `host` (the live `model.limit.context`), `override` (any
 * user-authored `model_limits` entry), `provider_cap` / `native` (the two
 * known-stale static tables), and `fallback` (the flat 128k default).
 */
export type ModelLimitSource =
	| 'host'
	| 'override'
	| 'provider_cap'
	| 'native'
	| 'fallback';

/** Provenance-bearing result of {@link resolveModelLimit} (issue #2044). */
export interface ModelLimitResolution {
	/** The resolved context limit in tokens. */
	limit: number;
	/** Coarse provenance class — the issue's enum. */
	source: ModelLimitSource;
	/** Which fine-grained resolution rung produced the limit. */
	resolution: ContextWindowSource;
}

const SOURCE_CLASS_BY_RESOLUTION: Readonly<
	Record<ContextWindowSource, ModelLimitSource>
> = {
	user_provider_model: 'override',
	user_model: 'override',
	user_default: 'override',
	live_model_limit: 'host',
	static_provider_cap: 'provider_cap',
	static_native: 'native',
	static_default: 'fallback',
};

export function classifyModelLimitSource(
	resolution: ContextWindowSource,
): ModelLimitSource {
	return SOURCE_CLASS_BY_RESOLUTION[resolution];
}

/**
 * Static-table lookup used as `fallbackLookup` for
 * {@link resolveContextWindow}. Preserves the historical precedence of the two
 * tables relative to each other (provider cap first, then a longest-prefix
 * native match), and says WHICH table matched so the resolution source can
 * distinguish `static_provider_cap` from `static_native` (issue #2044).
 * Reachable only when no live `model.limit.context` was available.
 */
export function lookupStaticModelLimit(
	modelID?: string,
	providerID?: string,
): { tokens: number; table: 'provider_cap' | 'native' } | undefined {
	if (providerID && PROVIDER_CAPS[providerID] !== undefined) {
		return { tokens: PROVIDER_CAPS[providerID], table: 'provider_cap' };
	}
	if (modelID) {
		const native = findNativeLimit(modelID);
		if (native !== undefined) return { tokens: native, table: 'native' };
	}
	return undefined;
}

/**
 * Resolves the context limit for a given model/provider combination WITH
 * provenance (issue #2044).
 *
 * Thin adapter over the single derivation in `src/config/context-window.ts` —
 * this function exists so the `experimental.chat.messages.transform` consumers
 * (`context-budget.ts`, `knowledge-injector.ts`, `tools/context-status.ts`,
 * `final-context-accounting.ts`) keep their existing
 * `(modelID, providerID, overrides)` call shape while receiving the typed
 * `{ limit, source }` provenance the observability series requires. All
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
 * Any value that is not a finite number ≥ 1000 (untrusted rungs) / ≥ 1 (user
 * rungs) is SKIPPED, never coerced; skipped user overrides are surfaced via a
 * bounded `invalid_override_skipped` observation instead of silently
 * disappearing (issue #2044 item 2).
 *
 * @param modelID - The model identifier (e.g., "claude-sonnet-4-6", "gpt-5")
 * @param providerID - The provider identifier (e.g., "github-copilot", "anthropic")
 * @param configOverrides - User configuration overrides (`context_budget.model_limits`)
 * @param liveContextLimit - The live `model.limit.context` recorded for this
 *   session by the `system.transform` hook, when one has been seen
 * @returns The resolved limit with coarse source class and fine-grained rung
 *
 * @example
 * // Live value wins over the stale static tables
 * resolveModelLimit("claude-sonnet-4-6", "github-copilot", {}, 200000)
 * // Returns: { limit: 200000, source: 'host', resolution: 'live_model_limit' }
 *
 * @example
 * // Explicit user override beats the live value
 * resolveModelLimit("gpt-5", "github-copilot", { "github-copilot/gpt-5": 60000 }, 400000)
 * // Returns: { limit: 60000, source: 'override', resolution: 'user_provider_model' }
 *
 * @example
 * // No live value: falls back to the static table (prefix match)
 * resolveModelLimit("claude-sonnet-4-6-20260301", "anthropic", {})
 * // Returns: { limit: 200000, source: 'native', resolution: 'static_native' }
 *
 * @example
 * // Malformed live value is ignored, not divided by
 * resolveModelLimit(undefined, undefined, {}, 0)
 * // Returns: { limit: 128000, source: 'fallback', resolution: 'static_default' }
 */
export function resolveModelLimit(
	modelID?: string,
	providerID?: string,
	configOverrides: Record<string, number> = {},
	liveContextLimit?: unknown,
	/** Project directory (threaded from the consumers) — scopes the #2044
	 * fallback-health observation to the owning project. */
	directory?: string,
): ModelLimitResolution {
	const invalidOverride = recordInvalidOverrides(
		modelID,
		providerID,
		configOverrides,
	);
	warnNormalizedKeyCollisions(configOverrides);
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
	maybeWarnUndersizedDefault(
		modelID,
		providerID,
		resolution.source,
		resolution.tokens,
		liveContextLimit,
	);
	_internals.observeResolution({
		modelID,
		providerID,
		directory,
		resolution: resolution.source,
		// Alias provenance (#2044 item 2): which override key class matched.
		aliasKeyClass:
			resolution.source === 'user_provider_model'
				? 'compound'
				: resolution.source === 'user_model'
					? 'model'
					: resolution.source === 'user_default'
						? 'default'
						: undefined,
		invalidOverride,
	});
	return {
		limit: resolution.tokens,
		source: classifyModelLimitSource(resolution.source),
		resolution: resolution.source,
	};
}

/**
 * Bounded observation seam (invariant-7 DI): routes the model-limit fallback
 * fact into the learning-health registry. Tests replace this to avoid touching
 * global health state; production uses the real observer.
 */
export const _internals: {
	observeResolution: typeof observeModelLimitResolution;
} = {
	observeResolution: observeModelLimitResolution,
};

/**
 * Surface user-authored override values that fail usability validation
 * (issue #2044 item 2): the invalid entry is skipped — never coerced — and the
 * skip is warned once per model/provider identity so operators can see why a
 * configured limit had no effect. Keys are reported by class (compound /
 * model / default), values as the raw number; neither is content.
 *
 * Health-observation scoping (PR-comment C8/C9): the returned flag is TRUE on
 * EVERY resolve while an invalid key RELEVANT TO THIS IDENTITY remains in the
 * config (sticky — the alarm must not self-recover while the bad config is
 * unchanged), and only keys that could apply to this identity count
 * ('default', a matching model-only key, or a matching compound key) so an
 * unrelated-model typo never raises a fallback alarm against an otherwise
 * healthy host-sourced identity. The warn log stays bounded once-per-identity.
 */
function recordInvalidOverrides(
	modelID: string | undefined,
	providerID: string | undefined,
	configOverrides: Record<string, number>,
): boolean {
	if (!configOverrides || typeof configOverrides !== 'object') return false;
	const normalizedModel = modelID?.trim().toLowerCase();
	const normalizedCompound = `${providerID ?? ''}/${modelID ?? ''}`
		.trim()
		.toLowerCase();
	let relevantInvalid = false;
	for (const [key, value] of Object.entries(configOverrides)) {
		if (isUsableConfiguredWindow(value)) continue;
		const keyClass =
			key === 'default' ? 'default' : key.includes('/') ? 'compound' : 'model';
		const normalizedKey = key.trim().toLowerCase();
		const relevant =
			keyClass === 'default' ||
			(keyClass === 'model' &&
				normalizedModel !== undefined &&
				normalizedKey === normalizedModel) ||
			(keyClass === 'compound' && normalizedKey === normalizedCompound);
		if (relevant) relevantInvalid = true;
		const identity = `${modelID || 'unknown'}::${providerID || 'unknown'}::${keyClass}::${String(value)}`;
		if (rememberBoundedModelIdentity(invalidOverrideReports, identity)) {
			warn(
				`[model-limits] context_budget.model_limits.${key}=${String(value)} for ${modelID || '(no model)'}@${providerID || '(no provider)'} is not a usable limit (finite number ≥ 1); skipping it — not coercing.`,
				{ modelID, providerID, keyClass, value },
			);
		}
	}
	return relevantInvalid;
}

const invalidOverrideReports = new Set<string>();

/**
 * Warn (bounded once per collision pair) when two distinct override keys
 * normalize to the same lookup key (PR-comment C10): case/whitespace variants
 * like `gpt-5` and `GPT-5` silently collapse last-wins under normalized
 * matching — the user should hear about the ambiguity once.
 */
function warnNormalizedKeyCollisions(
	configOverrides: Record<string, number>,
): void {
	const byNormalized = new Map<string, string[]>();
	for (const key of Object.keys(configOverrides)) {
		const normalized = key.trim().toLowerCase();
		byNormalized.set(normalized, [
			...(byNormalized.get(normalized) ?? []),
			key,
		]);
	}
	for (const [normalized, keys] of byNormalized) {
		if (keys.length < 2) continue;
		const identity = `collision::${normalized}`;
		if (!rememberBoundedModelIdentity(invalidOverrideReports, identity)) {
			continue;
		}
		warn(
			`[model-limits] context_budget.model_limits has ${keys.length} keys that normalize identically (${keys.join(
				', ',
			)}); only the last one in config order takes effect under normalized matching.`,
			{ keys },
		);
	}
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
	if (rememberBoundedModelIdentity(loggedFirstCalls, key)) {
		// Startup diagnostic: debug-gated, not a warning (helps verify limit resolution at startup)
		log(
			`[model-limits] Resolved limit for ${modelID || '(no model)'}@${providerID || '(no provider)'}: ${limit} (source: ${source})`,
		);
	}
}

function maybeWarnUndersizedDefault(
	modelID: string | undefined,
	providerID: string | undefined,
	source: string,
	resolvedTokens: number,
	liveContextLimit: unknown,
): void {
	if (source !== 'user_default') return;
	if (!isUsableContextWindow(liveContextLimit)) return;

	const liveTokens = Math.floor(liveContextLimit);
	if (liveTokens <= resolvedTokens) return;

	const key = `${modelID || 'unknown'}::${providerID || 'unknown'}`;
	if (!rememberBoundedModelIdentity(warnedUndersizedDefaults, key)) return;

	warn(
		`[model-limits] context_budget.model_limits.default=${resolvedTokens} is below live model window ${liveTokens} for ${modelID || '(no model)'}@${providerID || '(no provider)'}; keeping the configured default.`,
		{
			modelID,
			providerID,
			resolvedTokens,
			liveTokens,
			source,
		},
	);
}
