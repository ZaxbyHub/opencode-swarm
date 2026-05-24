import type { MemoryKind } from './types';

export interface MemoryConfig {
	enabled: boolean;
	provider: 'local-jsonl';
	storageDir: string;
	recall: {
		defaultMaxItems: number;
		defaultTokenBudget: number;
		minScore: number;
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
	provider: 'local-jsonl',
	storageDir: '.swarm/memory',
	recall: {
		defaultMaxItems: 8,
		defaultTokenBudget: 1200,
		minScore: 0.05,
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
		recall: {
			...DEFAULT_MEMORY_CONFIG.recall,
			...(input?.recall ?? {}),
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
