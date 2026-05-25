import { stripKnownSwarmPrefix } from '../config/schema';
import type { MemoryKind } from './types';

export interface MemoryRecallProfile {
	kinds: MemoryKind[];
	maxItems: number;
	tokenBudget: number;
}

export const MEMORY_RECALL_PROFILES = {
	architect: {
		kinds: [
			'project_fact',
			'architecture_decision',
			'repo_convention',
			'failure_pattern',
			'security_note',
		],
		maxItems: 10,
		tokenBudget: 1600,
	},
	sme: {
		kinds: [
			'api_finding',
			'code_pattern',
			'repo_convention',
			'failure_pattern',
			'evidence',
		],
		maxItems: 8,
		tokenBudget: 1200,
	},
	coder: {
		kinds: [
			'architecture_decision',
			'repo_convention',
			'code_pattern',
			'test_pattern',
			'failure_pattern',
		],
		maxItems: 8,
		tokenBudget: 1200,
	},
	qa: {
		kinds: [
			'test_pattern',
			'failure_pattern',
			'repo_convention',
			'security_note',
		],
		maxItems: 8,
		tokenBudget: 1200,
	},
	security: {
		kinds: [
			'security_note',
			'architecture_decision',
			'repo_convention',
			'evidence',
		],
		maxItems: 8,
		tokenBudget: 1200,
	},
	curator: {
		kinds: [
			'project_fact',
			'architecture_decision',
			'repo_convention',
			'api_finding',
			'code_pattern',
			'test_pattern',
			'failure_pattern',
			'security_note',
			'evidence',
		],
		maxItems: 20,
		tokenBudget: 3000,
	},
} as const satisfies Record<string, MemoryRecallProfile>;

export type MemoryRecallProfileName = keyof typeof MEMORY_RECALL_PROFILES;

export function resolveMemoryRecallProfile(
	agentRole: string | undefined,
): MemoryRecallProfile {
	const role = normalizeMemoryAgentRole(agentRole);
	return MEMORY_RECALL_PROFILES[role] ?? MEMORY_RECALL_PROFILES.coder;
}

export function normalizeMemoryAgentRole(
	agentRole: string | undefined,
): MemoryRecallProfileName {
	const base = stripKnownSwarmPrefix(agentRole ?? 'architect');
	if (base === 'reviewer' || base === 'test_engineer') return 'qa';
	if (
		base === 'critic' ||
		base === 'critic_sounding_board' ||
		base === 'critic_drift_verifier' ||
		base === 'critic_hallucination_verifier'
	) {
		return 'security';
	}
	if (base === 'curator_init' || base === 'curator_phase') return 'curator';
	if (base === 'docs') return 'sme';
	if (
		base === 'architect' ||
		base === 'sme' ||
		base === 'coder' ||
		base === 'security' ||
		base === 'curator'
	) {
		return base;
	}
	return 'coder';
}
