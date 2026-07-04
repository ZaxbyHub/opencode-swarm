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
	learning: MemoryLearningConfig;
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
	embeddings: {
		enabled: boolean;
		model: string;
		dimension: number;
		version?: string;
		cacheSize: number;
	};
	retrieval: {
		rrfK: number;
		weights: {
			lexical: number;
			dense: number;
			metadata: number;
		};
		rerank: {
			enabled: boolean;
			model?: string;
		};
		latencyBudgetMs: number;
	};
	/** Q-learning-style utility tracking for memory recall/promotion/suppression. */
	qLearning: QLearningConfig;
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

export interface QLearningConfig {
	/** EMA learning rate η for q ← (1-η)·q + η·reward. */
	learningRate: number;
	/** Weight of the q-value term added to recall scoring. */
	qValueBoostWeight: number;
	/** Memories with qValue below this are suppressed from default recall. */
	suppressionThreshold: number;
	/** Memories with qValue above this (and enough retrievals) are promotion candidates. */
	promotionThreshold: number;
	/** Minimum retrieval count before a high-q memory is a promotion candidate. */
	promotionMinRetrievals: number;
	/** Fraction of a reward propagated to closely-related memories. */
	propagationFraction: number;
	/** Max related memories a single reward may propagate to. */
	propagationFanoutCap: number;
	/** Only propagate to memories retrieved within this window (days). */
	propagationWindowDays: number;
	/**
	 * Jaccard token-overlap bar for treating two same-scope+kind memories as
	 * "related" for reward propagation (B.5). Deliberately HIGH — propagation
	 * mutates OTHER memories' learned utility, so wrong bounds = blast radius;
	 * it must reach only near-duplicate memories. Strictly higher than
	 * consolidation's clustering bar (`DEFAULT_CONSOLIDATION_CONFIG.jaccardThreshold`
	 * = 0.30, a more aggressive MERGE operation): incidental template-word
	 * overlap between distinct sibling-task memories (e.g. "Recalled by task
	 * A." vs "...task B." ≈ 0.6 Jaccard) must NOT count as related, so
	 * propagation never cross-pollinates distinct tasks' memories — which
	 * coheres with the B.2 unitId attribution the reward path already
	 * enforces. Documented judgment call (task B.5 report): deviates upward
	 * from the spec's "e.g. 0.5" example toward blast-radius safety.
	 */
	propagationRelatednessThreshold: number;
	/** Bounded rate at which suppressed memories are surfaced for exploration. */
	explorationRate: number;
	/** Max bytes of the retained council-synthesis payload (truncated with a marker beyond this). */
	verdictPayloadCapBytes: number;
	/** Neutral starting utility for a new memory. */
	initialQValue: number;
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

export interface MemoryLearningConfig {
	learningRate: number;
	propagationFactor: number;
	qValueBoostWeight: number;
	suppressionThreshold: number;
	promotionThreshold: number;
	propagationTokenOverlapThreshold: number;
	/**
	 * Minimum cosine similarity (embedding space) for a candidate memory to
	 * qualify for soft propagation via the embedding path, independent of the
	 * token-overlap path. Only evaluated when `embeddings.enabled` is true and
	 * the configured embedding provider is available; otherwise propagation
	 * falls back to token-overlap only (issue #1467 acceptance criteria).
	 */
	propagationEmbeddingCosineThreshold: number;
	propagationFanout: number;
	propagationLookbackDays: number;
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

export const DEFAULT_QLEARNING_CONFIG: QLearningConfig = {
	learningRate: 0.1,
	qValueBoostWeight: 0.1,
	suppressionThreshold: 0.15,
	promotionThreshold: 0.85,
	promotionMinRetrievals: 5,
	propagationFraction: 0.3,
	propagationFanoutCap: 20,
	propagationWindowDays: 30,
	propagationRelatednessThreshold: 0.7,
	explorationRate: 0.05,
	verdictPayloadCapBytes: 8192,
	initialQValue: 0.5,
};

/** Council verdict → EMA reward on the [0,1] utility scale (coherence fix; see spec FR-001). */
export const COUNCIL_VERDICT_REWARDS = {
	APPROVE: 1.0,
	CONCERNS: 0.5,
	REJECT: 0.0,
} as const;

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

export const DEFAULT_MEMORY_LEARNING_CONFIG: MemoryLearningConfig = {
	learningRate: 0.1,
	propagationFactor: 0.3,
	qValueBoostWeight: 0.1,
	suppressionThreshold: 0.15,
	promotionThreshold: 0.85,
	propagationTokenOverlapThreshold: 0.4,
	propagationEmbeddingCosineThreshold: 0.7,
	propagationFanout: 20,
	propagationLookbackDays: 30,
};

export const DEFAULT_EMBEDDINGS_CONFIG = {
	enabled: false,
	model: 'Xenova/all-MiniLM-L6-v2',
	dimension: 384,
	cacheSize: 256,
};

export const DEFAULT_RETRIEVAL_CONFIG = {
	rrfK: 60,
	weights: {
		lexical: 0.5,
		dense: 0.4,
		metadata: 0.1,
	},
	rerank: {
		enabled: false,
	},
	latencyBudgetMs: 250,
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
	learning: { ...DEFAULT_MEMORY_LEARNING_CONFIG },
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
	embeddings: { ...DEFAULT_EMBEDDINGS_CONFIG },
	retrieval: { ...DEFAULT_RETRIEVAL_CONFIG },
	qLearning: { ...DEFAULT_QLEARNING_CONFIG },
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
		learning: {
			...DEFAULT_MEMORY_CONFIG.learning,
			...(input?.learning ?? {}),
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
		embeddings: {
			...DEFAULT_MEMORY_CONFIG.embeddings,
			...(input?.embeddings ?? {}),
		},
		retrieval: {
			...DEFAULT_MEMORY_CONFIG.retrieval,
			...(input?.retrieval ?? {}),
			weights: {
				...DEFAULT_MEMORY_CONFIG.retrieval.weights,
				...(input?.retrieval?.weights ?? {}),
			},
			rerank: {
				...DEFAULT_MEMORY_CONFIG.retrieval.rerank,
				...(input?.retrieval?.rerank ?? {}),
			},
		},
		qLearning: {
			...DEFAULT_MEMORY_CONFIG.qLearning,
			...(input?.qLearning ?? {}),
		},
	};
}
