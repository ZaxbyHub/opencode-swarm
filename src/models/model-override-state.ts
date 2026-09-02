const MAX_SCOPED_MODEL_OVERRIDES = 256;
const SCOPED_MODEL_OVERRIDE_TTL_MS = 30 * 60_000;

export interface ModelOverrideParts {
	providerID: string;
	modelID: string;
}

export interface ScopedModelOverrideKey {
	sessionID: string;
	invocationID: string;
	role: string;
	swarmID?: string;
}

export interface NormalizedModelChain {
	readonly primary?: {
		modelString: string;
		override: ModelOverrideParts;
	};
	readonly fallbacks: readonly {
		modelString: string;
		override: ModelOverrideParts;
	}[];
	readonly signature: string;
	readonly totalModels: number;
}

export interface ScopedModelSelection {
	readonly generation: number;
	readonly fallbackIndex: number;
	readonly modelString?: string;
	readonly model?: ModelOverrideParts;
	readonly exhausted: boolean;
	readonly totalModels: number;
}

export interface ScopedModelAdvanceResult {
	readonly accepted: boolean;
	readonly selection: ScopedModelSelection;
}

export interface ScopedModelSelectionSnapshotEntry {
	readonly key: ScopedModelOverrideKey;
	readonly generation: number;
	readonly fallbackIndex: number;
	readonly updatedAt: number;
}

type ScopedModelEntry = {
	key: string;
	updatedAt: number;
	generation: number;
	fallbackIndex: number;
	signature: string;
};

const scopedModelOverrides = new Map<string, ScopedModelEntry>();

function normalizeText(value: string | undefined): string {
	return value?.trim() ?? '';
}

function entryKey(scope: ScopedModelOverrideKey): string {
	return [
		normalizeText(scope.sessionID),
		normalizeText(scope.invocationID),
		normalizeText(scope.swarmID),
		normalizeText(scope.role),
	].join('\u241f');
}

function parseModelString(model: string): ModelOverrideParts | undefined {
	const value = model.trim();
	if (!value) return undefined;
	const separator = value.indexOf('/');
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return {
		providerID: value.slice(0, separator),
		modelID: value.slice(separator + 1),
	};
}

function pruneScopedModelOverrides(now: number): void {
	for (const [key, entry] of scopedModelOverrides) {
		if (now - entry.updatedAt > SCOPED_MODEL_OVERRIDE_TTL_MS) {
			scopedModelOverrides.delete(key);
		}
	}
	while (scopedModelOverrides.size > MAX_SCOPED_MODEL_OVERRIDES) {
		const first = scopedModelOverrides.keys().next().value;
		if (!first) break;
		scopedModelOverrides.delete(first);
	}
}

function selectionFromEntry(
	entry: ScopedModelEntry,
	chain: NormalizedModelChain,
): ScopedModelSelection {
	if (entry.fallbackIndex >= chain.totalModels) {
		return {
			generation: entry.generation,
			fallbackIndex: entry.fallbackIndex,
			exhausted: true,
			totalModels: chain.totalModels,
		};
	}
	if (entry.fallbackIndex === 0) {
		return {
			generation: entry.generation,
			fallbackIndex: 0,
			modelString: chain.primary?.modelString,
			model: chain.primary?.override,
			exhausted: false,
			totalModels: chain.totalModels,
		};
	}
	const fallback = chain.fallbacks[entry.fallbackIndex - 1];
	return {
		generation: entry.generation,
		fallbackIndex: entry.fallbackIndex,
		modelString: fallback?.modelString,
		model: fallback?.override,
		exhausted: false,
		totalModels: chain.totalModels,
	};
}

export function normalizeModelChain(
	primaryModel: string | undefined,
	fallbackModels: Iterable<string | null | undefined>,
): NormalizedModelChain {
	const seen = new Set<string>();
	const normalizedFallbacks: Array<{
		modelString: string;
		override: ModelOverrideParts;
	}> = [];
	let normalizedPrimary:
		| {
				modelString: string;
				override: ModelOverrideParts;
		  }
		| undefined;

	const primaryText = normalizeText(primaryModel);
	if (primaryText) {
		const parsed = parseModelString(primaryText);
		if (parsed) {
			normalizedPrimary = { modelString: primaryText, override: parsed };
			seen.add(primaryText);
		}
	}

	for (const candidate of fallbackModels) {
		const text = normalizeText(candidate ?? undefined);
		if (!text || seen.has(text)) continue;
		const parsed = parseModelString(text);
		if (!parsed) continue;
		seen.add(text);
		normalizedFallbacks.push({ modelString: text, override: parsed });
	}

	return Object.freeze({
		primary: normalizedPrimary,
		fallbacks: Object.freeze(normalizedFallbacks),
		signature: [
			primaryText,
			...normalizedFallbacks.map((entry) => entry.modelString),
		].join('\u241e'),
		totalModels: 1 + normalizedFallbacks.length,
	});
}

export function resolveScopedModelSelection(
	scope: ScopedModelOverrideKey,
	chain: NormalizedModelChain,
	now = Date.now(),
): ScopedModelSelection {
	pruneScopedModelOverrides(now);
	const key = entryKey(scope);
	const current = scopedModelOverrides.get(key);
	if (!current || current.signature !== chain.signature) {
		const next: ScopedModelEntry = {
			key,
			updatedAt: now,
			generation: (current?.generation ?? 0) + 1,
			fallbackIndex: 0,
			signature: chain.signature,
		};
		scopedModelOverrides.delete(key);
		scopedModelOverrides.set(key, next);
		return selectionFromEntry(next, chain);
	}
	current.updatedAt = now;
	scopedModelOverrides.delete(key);
	scopedModelOverrides.set(key, current);
	return selectionFromEntry(current, chain);
}

export function advanceScopedModelSelection(
	scope: ScopedModelOverrideKey,
	chain: NormalizedModelChain,
	expectedGeneration: number,
	now = Date.now(),
): ScopedModelAdvanceResult {
	const key = entryKey(scope);
	const current = scopedModelOverrides.get(key);
	if (!current || current.signature !== chain.signature) {
		return {
			accepted: false,
			selection: resolveScopedModelSelection(scope, chain, now),
		};
	}
	if (current.generation !== expectedGeneration) {
		current.updatedAt = now;
		return {
			accepted: false,
			selection: selectionFromEntry(current, chain),
		};
	}
	current.updatedAt = now;
	current.fallbackIndex = Math.min(
		current.fallbackIndex + 1,
		chain.totalModels,
	);
	scopedModelOverrides.delete(key);
	scopedModelOverrides.set(key, current);
	return {
		accepted: true,
		selection: selectionFromEntry(current, chain),
	};
}

export function resetScopedModelSelection(
	scope: ScopedModelOverrideKey,
	expectedGeneration?: number,
): boolean {
	const key = entryKey(scope);
	const current = scopedModelOverrides.get(key);
	if (!current) return false;
	if (
		expectedGeneration !== undefined &&
		current.generation !== expectedGeneration
	) {
		return false;
	}
	return scopedModelOverrides.delete(key);
}

export function clearScopedModelSelectionsForSession(sessionID: string): void {
	const normalizedSessionID = normalizeText(sessionID);
	for (const [key, entry] of scopedModelOverrides) {
		if (key.startsWith(`${normalizedSessionID}\u241f`)) {
			scopedModelOverrides.delete(entry.key);
		}
	}
}

export function getScopedModelSelectionSnapshot(): readonly ScopedModelSelectionSnapshotEntry[] {
	return [...scopedModelOverrides.values()].map((entry) => {
		const [sessionID, invocationID, swarmID, role] = entry.key.split('\u241f');
		return {
			key: {
				sessionID,
				invocationID,
				swarmID: swarmID || undefined,
				role,
			},
			generation: entry.generation,
			fallbackIndex: entry.fallbackIndex,
			updatedAt: entry.updatedAt,
		};
	});
}

export function resetScopedModelSelectionStateForTests(): void {
	scopedModelOverrides.clear();
}
