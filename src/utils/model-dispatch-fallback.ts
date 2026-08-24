import {
	classifyProviderFailure,
	isRetryableProviderFailure,
} from '../failures/invocation-failure.js';
import {
	advanceScopedModelSelection,
	normalizeModelChain,
	resetScopedModelSelection,
	resolveScopedModelSelection,
	type ScopedModelOverrideKey,
} from '../models/model-override-state.js';

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
 * model-fallback advance — kept INDEPENDENT per AGENTS.md invariant #9.
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
	dispatch: (
		model: ModelOverride | undefined,
		context: {
			attemptNumber: number;
			fallbackIndex: number;
			modelString?: string;
			remainingMs?: number;
			generation?: number;
		},
	) => Promise<T>;
	/**
	 * Resolve the 1-based fallback model as a `provider/model` string, or null
	 * when the fallback chain is exhausted. Typically wraps
	 * `resolveFallbackModel(baseRole, index, getSwarmAgents(swarmId))`.
	 */
	resolveFallback?: (fallbackIndex: number) => string | null;
	/** Classify a dispatch error: 'transient' → retry/failover; 'permanent' → throw immediately. */
	classify: (error: unknown) => 'transient' | 'permanent';
	/** Bounded transient retries on the SAME model before advancing (invariant #9 — independent of fallback). Default 1. */
	maxTransientRetriesPerModel?: number;
	/** Backoff before a same-model retry (NOT before a fallback advance). Default 2**(n-1)*1000 ms. */
	backoffMs?: (retryAttempt: number) => number;
	/** Absolute wall-clock deadline in Unix ms shared across dispatch, retry, and backoff. */
	deadlineAtMs?: number;
	/** Hard cap across all attempts, independent of retry/fallback structure. */
	maxAttempts?: number;
	/** Notified when advancing to a fallback model (for advisory/telemetry). */
	onFallback?: (info: { toModel: string; fallbackIndex: number }) => void;
	/** DI for tests (avoid real waits). */
	sleep?: (ms: number) => Promise<void>;
	/** Clock injection for deadline tests. */
	now?: () => number;
	/**
	 * Optional scoped override contract for direct role-bound dispatch paths.
	 * When supplied together with a primary model and fallback chain, model
	 * selection is keyed by session/invocation/swarm/role and reset on success.
	 */
	scope?: ScopedModelOverrideKey;
	primaryModel?: string;
	fallbackModels?: Iterable<string | null | undefined>;
}

const defaultBackoff = (retryAttempt: number): number =>
	2 ** (retryAttempt - 1) * 1000;
const defaultSleep = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ModelDispatchTimeoutError extends Error {
	constructor(message = 'dispatchWithModelFallback: total deadline expired') {
		super(message);
		this.name = 'TimeoutError';
	}
}

export const _internals = {
	setTimeout,
	clearTimeout,
};

function deadlineError(
	phase: 'dispatch' | 'backoff',
): ModelDispatchTimeoutError {
	return new ModelDispatchTimeoutError(
		`dispatchWithModelFallback: total deadline expired during ${phase}`,
	);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	ms: number,
	timeoutError: Error,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = _internals.setTimeout(() => reject(timeoutError), Math.max(0, ms));
		// This timer is the only mechanism that can settle an abort-ignoring
		// dispatch. Keep it ref'ed; `finally` clears it after either branch wins.
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) _internals.clearTimeout(timer);
	}
}

function resolveLegacyFallbackModel(
	resolveFallback: ((fallbackIndex: number) => string | null) | undefined,
	fallbackIndex: number,
): {
	model?: ModelOverride;
	modelUsed?: string;
	skip: boolean;
	stop: boolean;
} {
	if (fallbackIndex === 0) {
		return {
			model: undefined,
			modelUsed: undefined,
			skip: false,
			stop: false,
		};
	}
	const fallbackText = resolveFallback?.(fallbackIndex) ?? null;
	if (fallbackText === null) {
		return { skip: false, stop: true };
	}
	try {
		return {
			model: parseModelString(fallbackText),
			modelUsed: fallbackText,
			skip: false,
			stop: false,
		};
	} catch {
		return { skip: true, stop: false };
	}
}

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
	const maxAttempts = Math.max(1, opts.maxAttempts ?? Number.MAX_SAFE_INTEGER);
	const backoff = opts.backoffMs ?? defaultBackoff;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const scopedChain =
		opts.scope === undefined
			? undefined
			: normalizeModelChain(opts.primaryModel, opts.fallbackModels ?? []);
	let attempts = 0;
	let lastError: unknown;
	let anyDispatched = false;
	let fallbackIndex = 0;
	let scopedGeneration: number | undefined;

	const ensureBudget = (phase: 'dispatch' | 'backoff'): number | undefined => {
		if (opts.deadlineAtMs === undefined) return undefined;
		const remainingMs = opts.deadlineAtMs - now();
		if (remainingMs <= 0) {
			throw deadlineError(phase);
		}
		return remainingMs;
	};

	for (;;) {
		let model: ModelOverride | undefined;
		let modelUsed: string | undefined;

		if (scopedChain && opts.scope) {
			const selection =
				fallbackIndex === 0
					? resolveScopedModelSelection(opts.scope, scopedChain, now())
					: advanceScopedModelSelection(
							opts.scope,
							scopedChain,
							scopedGeneration ?? 0,
							now(),
						).selection;
			scopedGeneration = selection.generation;
			if (selection.exhausted) break;
			fallbackIndex = selection.fallbackIndex;
			model = selection.model as ModelOverride | undefined;
			modelUsed = selection.modelString;
		} else {
			const fallback = resolveLegacyFallbackModel(
				opts.resolveFallback,
				fallbackIndex,
			);
			if (fallback.stop) break;
			if (fallback.skip) {
				fallbackIndex++;
				continue;
			}
			model = fallback.model;
			modelUsed = fallback.modelUsed;
		}

		if (fallbackIndex > 0 && modelUsed) {
			opts.onFallback?.({ toModel: modelUsed, fallbackIndex });
		}

		for (let retry = 0; retry <= maxRetries; retry++) {
			if (attempts >= maxAttempts) {
				throw (
					lastError ??
					new Error('dispatchWithModelFallback: attempt budget exhausted')
				);
			}
			const remainingMs = ensureBudget('dispatch');
			attempts++;
			anyDispatched = true;
			try {
				const dispatchPromise = opts.dispatch(model, {
					attemptNumber: attempts,
					fallbackIndex,
					modelString: modelUsed,
					remainingMs,
					generation: scopedGeneration,
				});
				// eslint-disable-next-line no-await-in-loop
				const result =
					remainingMs === undefined
						? await dispatchPromise
						: await raceWithTimeout(
								dispatchPromise,
								remainingMs,
								deadlineError('dispatch'),
							);
				if (opts.scope && scopedGeneration !== undefined) {
					resetScopedModelSelection(opts.scope, scopedGeneration);
				}
				return { result, modelUsed, fallbackIndex, attempts };
			} catch (err) {
				lastError = err;
				if (err instanceof ModelDispatchTimeoutError) {
					throw err;
				}
				const failureRecord = classifyProviderFailure(err);
				if (
					opts.classify(err) === 'permanent' ||
					!isRetryableProviderFailure(failureRecord)
				) {
					throw err;
				}
				if (retry < maxRetries) {
					const backoffBudget = ensureBudget('backoff');
					const sleepMs = Math.max(
						0,
						backoffBudget === undefined
							? backoff(retry + 1)
							: Math.min(backoff(retry + 1), backoffBudget),
					);
					// eslint-disable-next-line no-await-in-loop
					if (backoffBudget === undefined) {
						await sleep(sleepMs);
					} else {
						await raceWithTimeout(
							sleep(sleepMs),
							backoffBudget,
							deadlineError('backoff'),
						);
					}
				}
			}
		}

		fallbackIndex++;
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
