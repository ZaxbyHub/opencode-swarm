/**
 * Agent model-resolution preflight (issue #2271 bug 4).
 *
 * Agent model strings (DEFAULT_MODELS plus user `agents.<role>.model`
 * overrides) are handed to the OpenCode host unvalidated. When one does not
 * resolve ("Model not found", "Forbidden"), dispatch-lanes classifies the
 * failure as permanent, the affected agent never runs, and the plan-critic
 * gate wedges into manual `approve_plan_critic` overrides because no APPROVED
 * verdict is ever produced.
 *
 * This module validates configured model IDs against the live provider
 * catalog (`client.provider.list()`). Every check is FAIL-OPEN: if the catalog
 * is unreachable or malformed, results come back `unknown` and callers must
 * proceed — the preflight only acts on a POSITIVE confirmation that a model
 * does not resolve.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import { DEFAULT_MODELS } from '../config/constants';
import type { PluginConfig } from '../config/schema.js';

/** Tight bound for the catalog HTTP call — it runs on init/doctor paths. */
export const PROVIDER_LIST_TIMEOUT_MS = 2_000;

export interface ConfiguredAgentModel {
	/** Agent role the model is configured for. */
	agent: string;
	/** Full model id in `provider/model` form. */
	model: string;
	/** Where the value came from. */
	source: 'default' | 'override' | 'fallback';
}

export type ModelResolutionStatus = 'ok' | 'unresolved' | 'unknown';

export interface ModelResolution {
	agent: string;
	model: string;
	source: ConfiguredAgentModel['source'];
	status: ModelResolutionStatus;
	/** Human-readable explanation for non-ok statuses. */
	detail?: string;
}

export interface ModelPreflightResult {
	/** False when the catalog could not be fetched — every entry is `unknown`. */
	catalogAvailable: boolean;
	resolutions: ModelResolution[];
}

/**
 * Split a model id into its provider and model parts. Returns null for ids
 * without a provider prefix (e.g. a bare model name) — those cannot be
 * validated against a provider catalog.
 */
export function splitModelId(
	model: string,
): { provider: string; model: string } | null {
	const separator = model.indexOf('/');
	if (separator <= 0 || separator === model.length - 1) return null;
	return {
		provider: model.slice(0, separator),
		model: model.slice(separator + 1),
	};
}

/**
 * Collect every model id the swarm could dispatch with: DEFAULT_MODELS
 * entries, user agent overrides, and declared fallback_models. Overriding one
 * role replaces its default (mirrors getModelForAgent precedence).
 */
export function collectConfiguredAgentModels(
	config?: PluginConfig,
): ConfiguredAgentModel[] {
	const collected: ConfiguredAgentModel[] = [];
	const overriddenAgents = new Set<string>();
	const overrides = config?.agents ?? {};
	for (const [agent, override] of Object.entries(overrides)) {
		if (typeof override?.model === 'string' && override.model.trim()) {
			collected.push({
				agent,
				model: override.model.trim(),
				source: 'override',
			});
			overriddenAgents.add(agent);
		}
		for (const fallback of override?.fallback_models ?? []) {
			if (typeof fallback === 'string' && fallback.trim()) {
				collected.push({
					agent,
					model: fallback.trim(),
					source: 'fallback',
				});
			}
		}
	}
	for (const [agent, model] of Object.entries(DEFAULT_MODELS)) {
		if (overriddenAgents.has(agent)) continue;
		collected.push({ agent, model, source: 'default' });
	}
	return collected;
}

/** Provider catalog snapshot: provider id → set of model ids. */
export type ProviderCatalog = Map<string, Set<string>>;

/**
 * Issue #2271 review finding: the delegation-gate critic preflight calls this
 * on every critic dispatch — a short TTL cache keeps the per-dispatch cost off
 * the host while staying fresh enough for interactive model-config fixes.
 */
const CATALOG_CACHE_TTL_MS = 30_000;
let catalogCache: { fetchedAt: number; catalog: ProviderCatalog } | null = null;

/** Test seam: drop the cached catalog (also used after config changes). */
export function invalidateProviderCatalogCache(): void {
	catalogCache = null;
}

/**
 * Fetch the provider catalog. Returns null when the catalog cannot be
 * obtained or parsed — callers fail open on null.
 */
export async function fetchProviderCatalog(
	client: OpencodeClient | null,
): Promise<ProviderCatalog | null> {
	if (!client) return null;
	if (
		catalogCache &&
		Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS
	) {
		return catalogCache.catalog;
	}
	let response: Awaited<ReturnType<OpencodeClient['provider']['list']>>;
	try {
		response = await _internals.providerList(client);
	} catch {
		return null;
	}
	const all = response?.data?.all;
	if (!Array.isArray(all)) return null;
	const catalog: ProviderCatalog = new Map();
	for (const provider of all) {
		if (typeof provider?.id !== 'string') continue;
		const models = new Set<string>();
		if (provider.models && typeof provider.models === 'object') {
			for (const modelKey of Object.keys(provider.models)) {
				models.add(modelKey);
			}
		}
		catalog.set(provider.id, models);
	}
	catalogCache = { fetchedAt: Date.now(), catalog };
	return catalog;
}

/**
 * Validate collected models against a catalog. A model whose provider is
 * absent from the catalog, or whose provider exists but does not list the
 * model, is `unresolved` — but only when the catalog itself was successfully
 * fetched (callers must treat a null catalog as fail-open, never unresolved).
 */
export function resolveAgainstCatalog(
	models: ConfiguredAgentModel[],
	catalog: ProviderCatalog | null,
): ModelPreflightResult {
	if (catalog === null) {
		return {
			catalogAvailable: false,
			resolutions: models.map((entry) => ({
				...entry,
				status: 'unknown' as const,
				detail: 'provider catalog unavailable; model resolution not checked',
			})),
		};
	}
	const resolutions = models.map((entry): ModelResolution => {
		const split = splitModelId(entry.model);
		if (!split) {
			return {
				...entry,
				status: 'unknown' as const,
				detail:
					'model id has no provider prefix; resolution not checked against the catalog',
			};
		}
		const providerModels = catalog.get(split.provider);
		if (providerModels === undefined) {
			return {
				...entry,
				status: 'unresolved' as const,
				detail: `provider "${split.provider}" is not present in the provider catalog`,
			};
		}
		if (!providerModels.has(split.model)) {
			return {
				...entry,
				status: 'unresolved' as const,
				detail: `provider "${split.provider}" does not list model "${split.model}"`,
			};
		}
		return { ...entry, status: 'ok' as const };
	});
	return { catalogAvailable: true, resolutions };
}

/**
 * End-to-end preflight: collect configured models, fetch the catalog, and
 * resolve. Fail-open on every catalog error.
 */
export async function runModelPreflight(
	config: PluginConfig | undefined,
	client: OpencodeClient | null,
): Promise<ModelPreflightResult> {
	const models = collectConfiguredAgentModels(config);
	const catalog = await fetchProviderCatalog(client);
	return resolveAgainstCatalog(models, catalog);
}

/**
 * Resolves a single model id against the live catalog for gate preflights.
 * Returns 'unknown' whenever the catalog cannot be fetched — gates must only
 * block on 'unresolved'.
 */
export async function checkSingleModelResolution(
	model: string,
	client: OpencodeClient | null,
): Promise<ModelResolutionStatus> {
	const catalog = await fetchProviderCatalog(client);
	if (catalog === null) return 'unknown';
	const split = splitModelId(model);
	if (!split) return 'unknown';
	const providerModels = catalog.get(split.provider);
	if (providerModels === undefined || !providerModels.has(split.model)) {
		return 'unresolved';
	}
	return 'ok';
}

export const _internals = {
	/** Injectable seam for the SDK catalog call (tests substitute this). */
	providerList: async (client: OpencodeClient) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				client.provider.list(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('provider list timed out')),
						PROVIDER_LIST_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	},
};
