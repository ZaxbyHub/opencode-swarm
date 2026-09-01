/**
 * Context-window denominator resolution — the SINGLE derivation.
 *
 * Every "how many tokens does this model's context window hold?" question in
 * the plugin resolves here: the context-budget denominator (`budgetTokens` in
 * `src/hooks/system-enhancer.ts` Path A and Path B), the hard-enforcement
 * threshold in `src/hooks/context-budget.ts`, the knowledge-injector headroom
 * gate, the `context_status` tool, and the `/swarm status` render.
 *
 * ## Why this exists
 *
 * The denominator used to be a hardcoded 128 000. That number is stale:
 * current frontier and mid-tier models ship 200k–1M windows, and 256k is
 * common even for locally-hosted models. A budget that reports "87 % used"
 * against a window that is really 1M does not just emit a spurious advisory —
 * `context-budget.ts` HARD-PRUNES messages at `critical_threshold × limit`, so
 * a too-small denominator silently deletes context the model still needed.
 *
 * The authoritative value is already in the host's hands. The
 * `experimental.chat.system.transform` hook input carries
 * `model: Model` (`@opencode-ai/plugin`), and `Model.limit.context`
 * (`@opencode-ai/sdk`) is the live window for THAT provider's entry of THAT
 * model. Provider-specific caps are already baked in, because the host's model
 * catalog is keyed `providers[providerID].models[modelID]` — verified against
 * the on-disk catalog, where `github-copilot`'s `claude-sonnet-4.5` and
 * `anthropic`'s `claude-sonnet-4-5` carry DIFFERENT `limit.context` values.
 * A user's `provider.<id>.models.<id>.limit.context` override in
 * `opencode.json` is merged into the same object before it reaches the hook.
 *
 * ## Resolution order (first usable value wins)
 *
 *   1. `context_budget.model_limits["<providerID>/<modelID>"]`
 *   2. `context_budget.model_limits["<modelID>"]`
 *   3. `context_budget.model_limits.default`
 *   4. the LIVE `model.limit.context` from the hook input
 *   5. the static fallback table (`src/hooks/model-limits.ts`), injected as
 *      `fallbackLookup` — reachable only when no live value is available
 *   6. `DEFAULT_MODEL_CONTEXT_TOKENS`
 *
 * Steps 1–3 are ABOVE the live value on purpose: a user who writes a
 * `model_limits` entry is asking for a smaller *working* budget than the
 * physical window, and that intent must not be overridden by the hardware.
 * This is why `context_budget.model_limits` no longer carries a zod
 * `.default({ default: … })` — a schema-injected value is not user intent, and
 * would have shadowed the live window for every user who has a
 * `context_budget` block at all. See `ContextBudgetConfigSchema` in
 * `./schema.ts`.
 *
 * Steps 5–6 are last resorts, NOT a cap on step 4. The hand-maintained table
 * is stale in the downward direction (it claims Copilot caps everything at
 * 128 000; the live catalog shows Copilot Claude entries at 200 000 and
 * 1 000 000), so min-capping the live value against it would reintroduce
 * exactly the too-small denominator this module exists to remove.
 */

/**
 * LAST-RESORT context-budget denominator (tokens) — rung 6 above.
 *
 * Declared HERE rather than imported from `./schema`, deliberately: this module
 * is loaded transitively by `src/hooks/model-limits.ts` and therefore by every
 * `messages.transform` consumer, and several test files replace
 * `src/config/schema` with a non-spreading `mock.module` factory. Importing a
 * symbol from schema here would make Bun throw
 * `SyntaxError: Export named 'DEFAULT_MODEL_CONTEXT_TOKENS' not found` in those
 * files at import time (see the "mock.module() Export Completeness" section of
 * the writing-tests skill). Keeping this module dependency-free removes the
 * whole class. `./schema` re-exports the constant, so every existing importer
 * is unaffected.
 *
 * It is reached only when the user configured no `model_limits` entry, the host
 * supplied no usable `model.limit.context`, and the static fallback table in
 * `src/hooks/model-limits.ts` had no opinion either. It is deliberately NOT the
 * primary source: 128 000 is stale for current models, which routinely ship
 * 200k–1M windows.
 *
 * Historical note: `budgetTokens` used to be derived from
 * `context_budget.model_limits.default` in `src/hooks/system-enhancer.ts`, but
 * `context_budget` is schema-OPTIONAL, so a user with no block fell back to
 * `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens` in
 * `src/services/context-budget-service.ts` instead. Those two numbers had
 * drifted (128000 vs 40000), so the unconfigured default measured the swarm's
 * architect system prompt — approximately 34.5k estimated tokens — against a
 * 40k denominator and reported ~86% on turn one (34500/40000 = 86.25%; an
 * earlier revision of this comment said 87%) — enough to fire the budget
 * warning, the `CONTEXT PRESSURE`
 * advisory (src/index.ts) and the compaction EMERGENCY tier
 * (`observation/reflection/emergency` = 40/60/80) immediately.
 */
export const DEFAULT_MODEL_CONTEXT_TOKENS = 128000;

/**
 * Smallest context window this module will accept from an untrusted source.
 *
 * Mirrors the `z.number().min(1000)` floor that `ContextBudgetConfigSchema`
 * already enforces on user-authored `model_limits` values, so live catalog data
 * and user config are held to one standard. This is not theoretical: a survey
 * of the host's on-disk model catalog (`~/.cache/opencode/models.json`, ~6.2k
 * entries; the file is a per-machine, auto-refreshing artifact, so the exact
 * total moves) found 124 entries with `limit.context: 0`. Dividing by that
 * yields `Infinity` percent and would fire the EMERGENCY compaction tier on
 * turn one.
 */
export const MIN_PLAUSIBLE_CONTEXT_TOKENS = 1000;

/** Which rung of the resolution order produced the value. */
export type ContextWindowSource =
	| 'user_provider_model'
	| 'user_model'
	| 'user_default'
	| 'live_model_limit'
	| 'static_provider_cap'
	| 'static_native'
	| 'static_default';

export interface ContextWindowResolution {
	/**
	 * The resolved denominator, in tokens. Always a finite integer ≥ 1, so it is
	 * never a divide-by-zero. Through a PARSED config it is additionally ≥ 1000:
	 * every rung except the user rungs is gated on
	 * {@link isUsableContextWindow} (≥ {@link MIN_PLAUSIBLE_CONTEXT_TOKENS}), and
	 * the user rungs are themselves floored at 1000 by
	 * `ContextBudgetConfigSchema`. A direct programmatic call may still supply a
	 * user value between 1 and 999 and get it back — that is deliberate
	 * (honouring explicit intent), and it is why the guarantee stated here is
	 * ≥ 1 rather than ≥ 1000.
	 */
	tokens: number;
	/** Which rung produced `tokens` — surfaced in debug logs and tests. */
	source: ContextWindowSource;
}

export interface ContextWindowInputs {
	/**
	 * `config.context_budget?.model_limits` exactly as the user authored it.
	 * Pass `undefined` when the user has no `context_budget` block.
	 */
	userLimits?: Record<string, number> | undefined;
	/** Model identifier, when known (e.g. `claude-sonnet-4-6`). */
	modelID?: string | undefined;
	/** Provider identifier, when known (e.g. `github-copilot`). */
	providerID?: string | undefined;
	/**
	 * The live `model.limit.context` for this turn. Deliberately `unknown`:
	 * it crosses the plugin-host boundary, and the survey above shows the
	 * catalog really does ship `0` for some entries.
	 */
	liveContextLimit?: unknown;
	/**
	 * Last-resort static lookup. Injected rather than imported so this module
	 * stays free of any dependency on `src/hooks/`. The lookup must say WHICH
	 * static table matched (`provider_cap` vs `native`) so the resolution source
	 * stays honest (#2044): the two tables have different staleness profiles and
	 * downstream provenance consumers (the `context_status` tool, the
	 * model-limit-fallback health alarm) distinguish them. Returning `undefined`
	 * means "no opinion" and falls through to `DEFAULT_MODEL_CONTEXT_TOKENS`.
	 */
	fallbackLookup?:
		| ((
				modelID?: string,
				providerID?: string,
		  ) => { tokens: number; table: 'provider_cap' | 'native' } | undefined)
		| undefined;
}

/**
 * Normalize a `model_limits` lookup key (#2044 alias handling): trim + lowercase
 * on BOTH sides of the lookup so `Anthropic/Claude-Sonnet-4-6` and
 * `anthropic/claude-sonnet-4-6` hit the same entry. Lookup-side only — stored
 * config is never rewritten, and this deliberately does NOT introduce a
 * hand-maintained model-alias table (see the `src/hooks/model-limits.ts` module
 * header for why that is a maintenance treadmill).
 */
function normalizeLimitKey(key: string): string {
	return key.trim().toLowerCase();
}

/**
 * True when `value` can be used as a divisor at all: a finite number strictly
 * greater than zero.
 *
 * This is the bar applied to USER-AUTHORED `model_limits` values. It is
 * deliberately weaker than {@link isUsableContextWindow}: `ContextBudgetConfigSchema`
 * already enforces `z.number().min(1000)` on that record, so anything smaller
 * cannot reach here through a parsed config — and silently DISCARDING a value a
 * user explicitly wrote would be worse than honouring it. What this does reject
 * is the set that breaks arithmetic outright (`NaN`, `±Infinity`, `0`,
 * negatives, non-numbers), which a direct programmatic call can still supply.
 *
 * The bar is `>= 1`, not `> 0` (#1619 review round 4). `resolveContextWindow`
 * applies `Math.floor` to whatever this admits, so a fractional value in
 * `(0, 1)` — e.g. `{ default: 0.5 }` from a programmatic caller — passed a
 * `> 0` test and then floored to a **zero denominator**, producing the exact
 * `Infinity %` this guard exists to prevent. `>= 1` closes that without
 * discarding any value a user could author through a parsed config (the schema
 * floor is 1000) and without changing the verdict for any previously-accepted
 * integer.
 */
export function isUsableConfiguredWindow(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

/**
 * True when `value` is a plausible context-window size reported by an
 * UNTRUSTED source: a finite number at or above
 * {@link MIN_PLAUSIBLE_CONTEXT_TOKENS}.
 *
 * Applied to the live `model.limit.context` and to the static fallback table.
 * Stricter than {@link isUsableConfiguredWindow} because nothing validates the
 * host's model catalog on the way in and no real model ships a sub-1000-token
 * window — so a small value there is corrupt data, not intent. Rejects, by
 * construction, `undefined`, `null`, non-numbers, `NaN`, `Infinity`,
 * `-Infinity`, `0` and every negative: the shapes that turn a percentage into
 * `NaN` / `Infinity` and drive spurious EMERGENCY compaction directives.
 */
export function isUsableContextWindow(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= MIN_PLAUSIBLE_CONTEXT_TOKENS
	);
}

/**
 * Safely read `model.limit.context` off the `experimental.chat.system.transform`
 * hook input's `model` object.
 *
 * Typed as `unknown` on purpose. The plugin `.d.ts` declares `model: Model`
 * (non-optional), but this hook runs inside the host's transform chain: a throw
 * here takes down ALL system enhancement for the turn, so the read never
 * assumes the declared shape actually arrived.
 *
 * @returns the raw value, or `undefined` when the path is absent.
 */
export function readModelContextLimit(model: unknown): unknown {
	if (typeof model !== 'object' || model === null) return undefined;
	const limit = (model as { limit?: unknown }).limit;
	if (typeof limit !== 'object' || limit === null) return undefined;
	return (limit as { context?: unknown }).context;
}

/**
 * Safely read `model.id` / `model.providerID` off the hook input's `model`.
 *
 * Same defensive posture as {@link readModelContextLimit}: the declared type
 * says these are strings, but this runs on the host boundary. Empty strings are
 * normalised to `undefined` so a blank identity never becomes a config-lookup
 * key like `"/"`.
 */
export function readModelIdentity(
	model: unknown,
	key: 'id' | 'providerID',
): string | undefined {
	if (typeof model !== 'object' || model === null) return undefined;
	const value = (model as Record<string, unknown>)[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve the context-window denominator and report which rung produced it.
 *
 * @see the module header for the full resolution order and its rationale.
 */
export function resolveContextWindow(
	inputs: ContextWindowInputs,
): ContextWindowResolution {
	const { userLimits, modelID, providerID, liveContextLimit, fallbackLookup } =
		inputs;

	// 1–3: explicit user intent, most specific key first. Keys are matched
	// normalized (trim + lowercase) on both sides so provider/model casing or
	// stray whitespace never silently disables a user-authored limit (#2044).
	if (userLimits) {
		let normalized: Record<string, number> | undefined;
		const normalizedLimits = (): Record<string, number> => {
			if (normalized === undefined) {
				normalized = {};
				for (const [key, value] of Object.entries(userLimits)) {
					normalized[normalizeLimitKey(key)] = value;
				}
			}
			return normalized;
		};
		if (modelID && providerID) {
			const compound =
				normalizedLimits()[normalizeLimitKey(`${providerID}/${modelID}`)];
			if (isUsableConfiguredWindow(compound)) {
				return { tokens: Math.floor(compound), source: 'user_provider_model' };
			}
		}
		if (modelID) {
			const byModel = normalizedLimits()[normalizeLimitKey(modelID)];
			if (isUsableConfiguredWindow(byModel)) {
				return { tokens: Math.floor(byModel), source: 'user_model' };
			}
		}
		const byDefault = normalizedLimits().default;
		if (isUsableConfiguredWindow(byDefault)) {
			return { tokens: Math.floor(byDefault), source: 'user_default' };
		}
	}

	// 4: the live window reported by the host for this exact provider/model.
	if (isUsableContextWindow(liveContextLimit)) {
		return { tokens: Math.floor(liveContextLimit), source: 'live_model_limit' };
	}

	// 5: stale static table — only when no live value arrived. The lookup says
	// which table matched so the source distinguishes `static_provider_cap`
	// (PROVIDER_CAPS, known-stale in the downward direction) from
	// `static_native` (NATIVE_MODEL_LIMITS, stale independently) — #2044.
	if (fallbackLookup) {
		const fromTable = fallbackLookup(modelID, providerID);
		if (fromTable !== undefined && isUsableContextWindow(fromTable.tokens)) {
			return {
				tokens: Math.floor(fromTable.tokens),
				source:
					fromTable.table === 'provider_cap'
						? 'static_provider_cap'
						: 'static_native',
			};
		}
	}

	// 6: last resort.
	return { tokens: DEFAULT_MODEL_CONTEXT_TOKENS, source: 'static_default' };
}

/**
 * Convenience wrapper around {@link resolveContextWindow} for call sites that
 * only need the number.
 */
export function resolveContextWindowTokens(
	inputs: ContextWindowInputs,
): number {
	return resolveContextWindow(inputs).tokens;
}
