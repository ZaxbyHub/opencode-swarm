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
	hardDelete: boolean;
}

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
	};
}
