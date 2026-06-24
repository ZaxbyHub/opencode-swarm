import type { MemoryKind } from './types';

export interface MemoryConfig {
	enabled: boolean;
	provider: 'local-jsonl' | 'sqlite';
	storageDir: string;
	sqlite: {
		path: string;
		busyTimeoutMs: number;
	};
	recall: {
		defaultMaxItems: number;
		defaultTokenBudget: number;
		minScore: number;
		injection: {
			enabled: boolean;
			minScore: number;
			requireQuerySignal: boolean;
			maxItems: number;
			tokenBudget: number;
		};
	};
	writes: {
		mode: 'propose';
	};
	redaction: {
		rejectDurableSecrets: boolean;
	};
	maintenance: {
		/** @deprecated superseded by `maintenance.importance` (issue #1464); retained for back-compat. */
		lowUtilityMaxConfidence: number;
		/** @deprecated superseded by `maintenance.importance` (issue #1464); retained for back-compat. */
		lowUtilityMinAgeDays: number;
		autoCompactEveryNRecalls?: number; // default 50, 0 disables
		/** Importance-formula weights + low-utility threshold (DD-11). */
		importance: ImportanceConfig;
	};
	/** Reflection / consolidation pass (issue #1464, Phase 3). */
	consolidation: ConsolidationConfig;
	hardDelete: boolean;
}

export interface ImportanceConfig {
	wRecency: number;
	wFrequency: number;
	wFreshness: number;
	wConfidence: number;
	lambda: number;
	mu: number;
	n: number;
	/** A memory is low-utility when importance < threshold. */
	threshold: number;
}

export interface ConsolidationConfig {
	/** Run episodic→semantic consolidation at phase_complete. Gated by `enabled` too. */
	enabled: boolean;
	/** Max LLM-distilled clusters processed per pass (cost control). */
	maxClustersPerPass: number;
	/** Jaccard token-overlap threshold for lexical clustering. */
	jaccardThreshold: number;
	/** Distilled facts below this confidence are filed as proposals, not auto-applied. */
	autoApplyMinConfidence: number;
	/**
	 * Kind-specific decay half-lives in days. A value of 0 means "never auto-expire"
	 * (the issue's "365+ days, no decay unless superseded" durable kinds).
	 */
	decayHalfLifeDays: Record<MemoryKind, number>;
}

export const DEFAULT_DECAY_HALF_LIFE_DAYS: Record<MemoryKind, number> = {
	scratch: 7,
	todo: 30,
	code_pattern: 90,
	test_pattern: 90,
	failure_pattern: 90,
	api_finding: 180,
	evidence: 180,
	architecture_decision: 0,
	repo_convention: 0,
	project_fact: 0,
	security_note: 0,
	user_preference: 0,
};

export const DEFAULT_IMPORTANCE_CONFIG: ImportanceConfig = {
	wRecency: 0.2,
	wFrequency: 0.2,
	wFreshness: 0.15,
	wConfidence: 0.25,
	lambda: 0.05,
	mu: 0.01,
	n: 50,
	threshold: 0.2,
};

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
	// Explicit opt-in (lockstep with MemoryConfigSchema in src/config/schema.ts):
	// consolidation makes LLM calls and auto-applies records, so a user enabling
	// memory must also explicitly enable consolidation.
	enabled: false,
	maxClustersPerPass: 10,
	jaccardThreshold: 0.3,
	autoApplyMinConfidence: 0.6,
	decayHalfLifeDays: { ...DEFAULT_DECAY_HALF_LIFE_DAYS },
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	enabled: false,
	provider: 'sqlite',
	storageDir: '.swarm/memory',
	sqlite: {
		path: '.swarm/memory/memory.db',
		busyTimeoutMs: 5000,
	},
	recall: {
		defaultMaxItems: 8,
		defaultTokenBudget: 1200,
		minScore: 0.05,
		injection: {
			enabled: true,
			minScore: 0.25,
			requireQuerySignal: true,
			maxItems: 6,
			tokenBudget: 1000,
		},
	},
	writes: {
		mode: 'propose',
	},
	redaction: {
		rejectDurableSecrets: true,
	},
	maintenance: {
		lowUtilityMaxConfidence: 0.45,
		lowUtilityMinAgeDays: 30,
		autoCompactEveryNRecalls: 50,
		importance: { ...DEFAULT_IMPORTANCE_CONFIG },
	},
	consolidation: {
		...DEFAULT_CONSOLIDATION_CONFIG,
		decayHalfLifeDays: { ...DEFAULT_DECAY_HALF_LIFE_DAYS },
	},
	hardDelete: false,
};

export const DURABLE_MEMORY_KINDS: ReadonlySet<MemoryKind> = new Set([
	'user_preference',
	'project_fact',
	'architecture_decision',
	'repo_convention',
	'code_pattern',
	'test_pattern',
	'failure_pattern',
	'security_note',
]);

export const EVIDENCE_REQUIRED_KINDS: ReadonlySet<MemoryKind> = new Set([
	'api_finding',
	'evidence',
	'security_note',
]);

export function resolveMemoryConfig(
	input: Partial<MemoryConfig> | undefined,
): MemoryConfig {
	return {
		...DEFAULT_MEMORY_CONFIG,
		...(input ?? {}),
		sqlite: {
			...DEFAULT_MEMORY_CONFIG.sqlite,
			...(input?.sqlite ?? {}),
		},
		recall: {
			...DEFAULT_MEMORY_CONFIG.recall,
			...(input?.recall ?? {}),
			injection: {
				...DEFAULT_MEMORY_CONFIG.recall.injection,
				...(input?.recall?.injection ?? {}),
			},
		},
		writes: {
			...DEFAULT_MEMORY_CONFIG.writes,
			...(input?.writes ?? {}),
		},
		redaction: {
			...DEFAULT_MEMORY_CONFIG.redaction,
			...(input?.redaction ?? {}),
		},
		maintenance: {
			...DEFAULT_MEMORY_CONFIG.maintenance,
			...(input?.maintenance ?? {}),
			importance: {
				...DEFAULT_MEMORY_CONFIG.maintenance.importance,
				...(input?.maintenance?.importance ?? {}),
			},
		},
		consolidation: {
			...DEFAULT_MEMORY_CONFIG.consolidation,
			...(input?.consolidation ?? {}),
			decayHalfLifeDays: {
				...DEFAULT_MEMORY_CONFIG.consolidation.decayHalfLifeDays,
				...(input?.consolidation?.decayHalfLifeDays ?? {}),
			},
		},
	};
}
