/**
 * Issue #1896 (sub-issue 3): shared model-fallback dispatch helper.
 *
 * Before this, the ONLY place a role failed over to its configured
 * `fallback_models` was the guardrails `toolAfter` hook (which fires on
 * tool-result payloads). Every direct model-dispatch stage — critic oversight,
 * lean-turbo reviewer, lane runner — called the provider directly and never
 * failed over, so a role that hit its quota mid-run failed the stage outright.
 *
 * All those stages dispatch via `client.session.prompt({ body: { agent, model }})`,
 * which accepts a per-call `model: {providerID, modelID}` override. This helper
 * wraps such a dispatch with (a) bounded, per-model transient retry and (b)
 * model-fallback advance — kept INDEPENDENT per AGENTS.md invariant #9. The
 * fallback index is owned LOCALLY here: every stage dispatches into an ephemeral
 * child session, so the only reachable `session.model_fallback_index` belongs to
 * the parent orchestrator (a different agent) and must not be reused.
 *
 * The helper does NOT import `src/agents/index.ts` (avoids a heavy import cycle);
 * the caller injects a `resolveFallback(index)` closure that wraps
 * `resolveFallbackModel(baseRole, index, getSwarmAgents(swarmId))`.
 */

/** Per-call model override shape accepted by `client.session.prompt` body. */
export interface ModelOverride {
	providerID: string;
	modelID: string;
}

/**
 * Parse a `provider/model` string into the per-call override shape. Returns
 * undefined for empty/blank input. Throws on a value with no provider or no
 * model segment.
 */
export function parseModelString(model: string): ModelOverride | undefined {
	if (!model || !model.trim()) return undefined;
	const separator = model.indexOf('/');
	if (separator <= 0 || separator === model.length - 1) {
		throw new Error(
			`fallback model must use provider/model syntax, got: "${model}"`,
		);
	}
	return {
		providerID: model.slice(0, separator),
		modelID: model.slice(separator + 1),
	};
}

export interface ModelFallbackResult<T> {
	result: T;
	/** undefined = the agent's registered/primary model; otherwise the `provider/model` string used. */
	modelUsed?: string;
	/** 0 = primary; 1.. = which configured fallback landed. */
	fallbackIndex: number;
	/** total dispatch attempts made (across models + same-model retries). */
	attempts: number;
}

export interface DispatchWithModelFallbackOptions<T> {
	/** Dispatch using `model` (undefined = the agent's registered/primary model). */
	dispatch: (model: ModelOverride | undefined) => Promise<T>;
	/**
	 * Resolve the 1-based fallback model as a `provider/model` string, or null
	 * when the fallback chain is exhausted. Typically wraps
	 * `resolveFallbackModel(baseRole, index, getSwarmAgents(swarmId))`.
	 */
	resolveFallback: (fallbackIndex: number) => string | null;
	/** Classify a dispatch error: 'transient' → retry/failover; 'permanent' → throw immediately. */
	classify: (error: unknown) => 'transient' | 'permanent';
	/** Bounded transient retries on the SAME model before advancing (invariant #9 — independent of fallback). Default 1. */
	maxTransientRetriesPerModel?: number;
	/** Backoff before a same-model retry (NOT before a fallback advance). Default 2**(n-1)*1000 ms. */
	backoffMs?: (retryAttempt: number) => number;
	/** Notified when advancing to a fallback model (for advisory/telemetry). */
	onFallback?: (info: { toModel: string; fallbackIndex: number }) => void;
	/** DI for tests (avoid real waits). */
	sleep?: (ms: number) => Promise<void>;
}

const defaultBackoff = (retryAttempt: number): number =>
	2 ** (retryAttempt - 1) * 1000;
const defaultSleep = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Try the primary model, then each configured fallback, retrying transient
 * failures a bounded number of times per model. A permanent failure throws
 * immediately (no retry, no advance). When every model is exhausted transiently,
 * the last error is rethrown.
 */
export async function dispatchWithModelFallback<T>(
	opts: DispatchWithModelFallbackOptions<T>,
): Promise<ModelFallbackResult<T>> {
	const maxRetries = Math.max(0, opts.maxTransientRetriesPerModel ?? 1);
	const backoff = opts.backoffMs ?? defaultBackoff;
	const sleep = opts.sleep ?? defaultSleep;
	let attempts = 0;
	let lastError: unknown;
	let anyDispatched = false;

	// fallbackIndex 0 = primary (registered model, override undefined).
	for (let fallbackIndex = 0; ; fallbackIndex++) {
		let model: ModelOverride | undefined;
		let modelUsed: string | undefined;
		if (fallbackIndex > 0) {
			const fbStr = opts.resolveFallback(fallbackIndex);
			if (fbStr === null) break; // fallback chain exhausted
			try {
				model = parseModelString(fbStr);
			} catch {
				// Malformed config entry — skip to the next configured fallback.
				continue;
			}
			modelUsed = fbStr;
			opts.onFallback?.({ toModel: fbStr, fallbackIndex });
		}

		// Bounded same-model transient retries (independent of the fallback advance).
		for (let retry = 0; retry <= maxRetries; retry++) {
			attempts++;
			anyDispatched = true;
			try {
				// eslint-disable-next-line no-await-in-loop
				const result = await opts.dispatch(model);
				return { result, modelUsed, fallbackIndex, attempts };
			} catch (err) {
				lastError = err;
				if (opts.classify(err) === 'permanent') {
					throw err; // permanent → no retry, no failover
				}
				if (retry < maxRetries) {
					// eslint-disable-next-line no-await-in-loop
					await sleep(backoff(retry + 1));
				}
			}
		}
		// Same-model transient budget exhausted → advance to next fallback.
	}

	throw (
		lastError ??
		new Error(
			anyDispatched
				? 'dispatchWithModelFallback: all models exhausted'
				: 'dispatchWithModelFallback: no dispatch attempted',
		)
	);
}
